/**
 * Integration tests: real Fastify app + real Postgres (DATABASE_URL must point
 * at a migrated database — CI spins one up as a service container).
 * Object storage / mail / push / queue / realtime are stubbed: integration
 * scope here is API <-> DB behavior, per the testing pyramid.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const rootEmail = `root-${RUN}@test.io`;
const aliceEmail = `alice-${RUN}@test.io`;
const bobEmail = `bob-${RUN}@test.io`;

const stubStorage = {
  presignUpload: async () => 'http://stub/upload',
  presignDownload: async () => 'http://stub/download',
  delete: async () => {},
  healthy: async () => true,
  ensureBucket: async () => {},
};

const scheduled: { queue: string; key?: string }[] = [];
const stubBoss = {
  send: async (queue: string, _data: unknown, opts?: { singletonKey?: string }) => {
    scheduled.push({ queue, key: opts?.singletonKey });
    return 'job-id';
  },
} as never;

describe.skipIf(!hasDb)('API integration', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let adminCookie: string;
  let aliceCookie: string;
  let bobCookie: string; // other org
  let orgA: string;
  let orgB: string;
  let boardId: string;
  let columns: { id: string; semantic: string | null }[];

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return res.headers['set-cookie']!.toString().split(';')[0]!;
  }

  beforeAll(async () => {
    const db = createDb();
    ctx = {
      db,
      boss: stubBoss,
      storage: stubStorage,
      mailer: { enabled: false, send: async () => {} },
      push: { enabled: false, send: async () => {} },
      realtime: { emitToBoard: () => {}, emitToUser: () => {} },
    };
    app = await buildApp(ctx);

    // seed: global admin + two orgs + one user each — all rows unique to this
    // run; never delete or touch data this test didn't create
    const hash = await bcrypt.hash('pass12345', 4);
    await db
      .insertInto('users')
      .values({ org_id: null, email: rootEmail, display_name: 'Root', role: 'global_admin', password_hash: hash })
      .execute();
    const a = await db.insertInto('organizations').values({ name: 'Org A', slug: `api-a-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    const b = await db.insertInto('organizations').values({ name: 'Org B', slug: `api-b-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    orgA = a.id;
    orgB = b.id;
    await db
      .insertInto('users')
      .values([
        { org_id: orgA, email: aliceEmail, display_name: 'Alice Alpha', role: 'user', password_hash: hash },
        { org_id: orgB, email: bobEmail, display_name: 'Bob Beta', role: 'user', password_hash: hash },
      ])
      .execute();

    adminCookie = await login(rootEmail, 'pass12345');
    aliceCookie = await login(aliceEmail, 'pass12345');
    bobCookie = await login(bobEmail, 'pass12345');
  });

  afterAll(async () => {
    // teardown own data only (org cascade removes org users/boards/cards)
    await ctx.db.deleteFrom('organizations').where('id', 'in', [orgA, orgB]).execute();
    await ctx.db.deleteFrom('users').where('email', '=', rootEmail).execute();
    await app.close();
    await ctx.db.destroy();
  });

  it('rejects bad credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: aliceEmail, password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('unauthenticated request is refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/boards' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a board with guaranteed open+done columns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/boards',
      headers: { cookie: aliceCookie },
      payload: { name: 'Alice board' },
    });
    expect(res.statusCode).toBe(200);
    boardId = res.json().id;

    const detail = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: aliceCookie } });
    columns = detail.json().columns;
    expect(columns.some((c) => c.semantic === 'open')).toBe(true);
    expect(columns.some((c) => c.semantic === 'done')).toBe(true);
  });

  it('TENANCY: user from another org cannot see or touch the board', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: bobCookie } });
    expect(view.statusCode).toBe(403);
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}`,
      headers: { cookie: bobCookie },
      payload: { name: 'hijacked' },
    });
    expect(edit.statusCode).toBe(403);
  });

  it('cannot remove the last open column', async () => {
    const payload = columns.map((c, i) => ({
      id: c.id,
      name: `col${i}`,
      position: i,
      semantic: c.semantic === 'open' ? null : (c.semantic as 'done' | null),
    }));
    const res = await app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/columns`,
      headers: { cookie: aliceCookie },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('card lifecycle: create, move to done schedules recurrence reopen', async () => {
    const open = columns.find((c) => c.semantic === 'open')!;
    const done = columns.find((c) => c.semantic === 'done')!;

    const created = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { cookie: aliceCookie },
      payload: { boardId, columnId: open.id, title: 'Water plants' },
    });
    expect(created.statusCode).toBe(200);
    const cardId = created.json().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${cardId}`,
      headers: { cookie: aliceCookie },
      payload: { recurrenceRule: { freq: 'daily', interval: 2 } },
    });
    expect(patched.statusCode).toBe(200);

    scheduled.length = 0;
    const moved = await app.inject({
      method: 'POST',
      url: `/api/cards/${cardId}/move`,
      headers: { cookie: aliceCookie },
      payload: { toColumnId: done.id },
    });
    expect(moved.statusCode).toBe(200);
    const body = moved.json();
    expect(body.recurrence_status).toBe('awaiting_reopen');
    expect(body.closed_at).toBeTruthy();
    expect(body.reopen_at).toBeTruthy();
    expect(scheduled.some((s) => s.key?.startsWith(`reopen:${cardId}:`))).toBe(true);

    // transition history recorded
    const detail = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie: aliceCookie } });
    expect(detail.json().transitions.length).toBe(2); // create + move

    // cross-tenant card access denied
    const stolen = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie: bobCookie } });
    expect(stolen.statusCode).toBe(403);
  });

  it('org admin API: alice cannot manage users, root can', async () => {
    const denied = await app.inject({ method: 'GET', url: `/api/orgs/${orgA}/users`, headers: { cookie: aliceCookie } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: `/api/orgs/${orgA}/users`, headers: { cookie: adminCookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('global admin routes closed to normal users', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/orgs', headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('readiness reports dependency health', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.db).toBe(true);
  });
});
