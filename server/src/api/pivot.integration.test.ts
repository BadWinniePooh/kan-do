/** Pivot query endpoint: shape + tenancy (foreign boardIds leak nothing). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

describe.skipIf(!hasDb)('pivot query', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let bob: string;
  let aliceBoard: string;

  beforeAll(async () => {
    const db = createDb();
    ctx = {
      db,
      boss: { send: async () => 'job' } as never,
      storage: {
        presignUpload: async () => 'http://stub',
        presignDownload: async () => 'http://stub',
        delete: async () => {},
        healthy: async () => true,
        ensureBucket: async () => {},
      },
      mailer: { enabled: false, send: async () => {} },
      push: { enabled: false, send: async () => {} },
      realtime: { emitToBoard: () => {}, emitToUser: () => {} },
    };
    app = await buildApp(ctx);
    const hash = await bcrypt.hash('pass12345', 4);
    orgA = (await db.insertInto('organizations').values({ name: 'Piv A', slug: `piv-a-${RUN}` }).returning('id').executeTakeFirstOrThrow()).id;
    orgB = (await db.insertInto('organizations').values({ name: 'Piv B', slug: `piv-b-${RUN}` }).returning('id').executeTakeFirstOrThrow()).id;
    await db
      .insertInto('users')
      .values([
        { org_id: orgA, email: `piv-alice-${RUN}@test.io`, display_name: 'Alice', role: 'user', password_hash: hash },
        { org_id: orgB, email: `piv-bob-${RUN}@test.io`, display_name: 'Bob', role: 'user', password_hash: hash },
      ])
      .execute();
    const login = async (email: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pass12345' } });
      return res.headers['set-cookie']!.toString().split(';')[0]!;
    };
    alice = await login(`piv-alice-${RUN}@test.io`);
    bob = await login(`piv-bob-${RUN}@test.io`);

    const board = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: alice }, payload: { name: 'Pivot board' } });
    aliceBoard = board.json().id;
    const detail = await app.inject({ method: 'GET', url: `/api/boards/${aliceBoard}`, headers: { cookie: alice } });
    const cols = detail.json().columns;
    const open = cols.find((c: { semantic: string }) => c.semantic === 'open');
    const done = cols.find((c: { semantic: string }) => c.semantic === 'done');
    for (const title of ['P1', 'P2', 'P3']) {
      await app.inject({
        method: 'POST',
        url: '/api/cards',
        headers: { cookie: alice },
        payload: { boardId: aliceBoard, columnId: open.id, title },
      });
    }
    // one card finishes -> gives count-by-column structure
    const d = await app.inject({ method: 'GET', url: `/api/boards/${aliceBoard}`, headers: { cookie: alice } });
    const cardId = d.json().cards[0].id;
    await app.inject({ method: 'POST', url: `/api/cards/${cardId}/move`, headers: { cookie: alice }, payload: { toColumnId: done.id } });
  });

  afterAll(async () => {
    await ctx.db.deleteFrom('organizations').where('id', 'in', [orgA, orgB]).execute();
    await app.close();
    await ctx.db.destroy();
  });

  it('count of cards by column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: alice },
      payload: { dimensions: ['column'], metric: 'count', aggregation: 'count' },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as { keys: string[]; value: number }[];
    expect(rows.find((r) => r.keys[0] === 'Open')?.value).toBe(2);
    expect(rows.find((r) => r.keys[0] === 'Done')?.value).toBe(1);
  });

  it('two-dimension pivot works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: alice },
      payload: { dimensions: ['column', 'category'], metric: 'count', aggregation: 'count' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.every((r: { keys: string[] }) => r.keys.length === 2)).toBe(true);
  });

  it("TENANCY: bob passing alice's boardId gets zero data", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: bob },
      payload: { dimensions: ['column'], metric: 'count', aggregation: 'count', boardIds: [aliceBoard] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([]);
    expect(res.json().boardCount).toBe(0);
  });

  it('multi-series burnup: two cumulative counts on one month axis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: alice },
      payload: {
        dimension: 'createdMonth',
        omitKeys: ['Not done'],
        boardIds: [aliceBoard],
        series: [
          { label: 'Scope', metric: 'count', aggregation: 'count', dimension: 'createdMonth', cumulative: true },
          { label: 'Completed', metric: 'count', aggregation: 'count', dimension: 'closedMonth', cumulative: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { keys: string[]; series: { label: string; values: number[] }[] };
    expect(body.series.map((s) => s.label)).toEqual(['Scope', 'Completed']);
    expect(body.keys.length).toBeGreaterThan(0);
    // three cards created this month, one of them finished
    expect(body.series[0]!.values.at(-1)).toBe(3);
    expect(body.series[1]!.values.at(-1)).toBe(1);
  });

  it("TENANCY: bob's multi-series query over alice's board returns nothing", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: bob },
      payload: {
        dimension: 'createdMonth',
        boardIds: [aliceBoard],
        series: [{ label: 'Scope', metric: 'count', aggregation: 'count' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toEqual([]);
    expect(res.json().boardCount).toBe(0);
  });

  it('invalid series metric rejected with validation detail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: alice },
      payload: {
        dimension: 'createdMonth',
        series: [{ label: 'x', metric: 'password_hash', aggregation: 'count' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('invalid dimension rejected with validation detail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/dashboard/query',
      headers: { cookie: alice },
      payload: { dimensions: ['password_hash'], metric: 'count', aggregation: 'count' },
    });
    expect(res.statusCode).toBe(400);
  });
});
