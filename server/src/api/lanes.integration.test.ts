/**
 * Lane + per-lane column specs, and avatar URL handling.
 *
 * Invariants under test: a board always has at least one lane; every lane owns
 * an independent column set that must include an open and a done column; a lane
 * holding cards cannot be deleted; and a card always sits in a column of its own
 * lane.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);

interface Col {
  id: string;
  lane_id: string;
  name: string;
  position: number;
  semantic: string | null;
}

describe.skipIf(!hasDb)('lanes, per-lane columns & avatars', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let cookie: string;
  let userId: string;
  let boardId: string;
  let laneOne: string;

  const board = async () => (await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } })).json();
  const laneCols = async (laneId: string): Promise<Col[]> =>
    (await board()).columns.filter((c: Col) => c.lane_id === laneId).sort((a: Col, b: Col) => a.position - b.position);
  const putLanes = (payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/boards/${boardId}/lanes`, headers: { cookie }, payload });
  const putCols = (laneId: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/boards/${boardId}/lanes/${laneId}/columns`, headers: { cookie }, payload });

  beforeAll(async () => {
    const db = createDb();
    ctx = {
      db,
      boss: { send: async () => 'job' } as never,
      storage: {
        presignUpload: async () => 'http://stub/upload',
        presignDownload: async (key: string) => `http://stub/signed/${key}`,
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
    const org = await db.insertInto('organizations').values({ name: 'Lane Org', slug: `lane-org-${Date.now()}` }).returning('id').executeTakeFirstOrThrow();
    const user = await db
      .insertInto('users')
      .values({ org_id: org.id, email: `lane-${Date.now()}@test.io`, display_name: 'Lane Tester', role: 'user', password_hash: hash })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow();
    userId = user.id;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'pass12345' } });
    cookie = res.headers['set-cookie']!.toString().split(';')[0]!;

    const created = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie }, payload: { name: 'Lane board' } });
    boardId = created.json().id;
    laneOne = (await board()).lanes[0].id;
  });

  afterAll(async () => {
    await app.close();
    await ctx.db.destroy();
  });

  it('a new board starts with one lane that owns its own open+done columns', async () => {
    const detail = await board();
    expect(detail.lanes).toHaveLength(1);
    const cols = await laneCols(laneOne);
    expect(cols.every((c) => c.lane_id === laneOne)).toBe(true);
    expect(cols.some((c) => c.semantic === 'open')).toBe(true);
    expect(cols.some((c) => c.semantic === 'done')).toBe(true);
  });

  it('a new lane is born with its own open+done columns, independent of lane one', async () => {
    const res = await putLanes([
      { id: laneOne, name: 'Lane One', position: 0 },
      { name: 'Lane Two', position: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    const laneTwo = (res.json() as { id: string; name: string }[]).find((l) => l.name === 'Lane Two')!.id;

    const two = await laneCols(laneTwo);
    expect(two.some((c) => c.semantic === 'open')).toBe(true);
    expect(two.some((c) => c.semantic === 'done')).toBe(true);
    // distinct column rows, not shared with lane one
    const one = await laneCols(laneOne);
    expect(one.map((c) => c.id).some((id) => two.map((t) => t.id).includes(id))).toBe(false);
  });

  it('lanes can have completely different columns', async () => {
    const laneTwo = (await board()).lanes.find((l: { name: string }) => l.name === 'Lane Two').id;
    const res = await putCols(laneTwo, [
      { name: 'Intake', position: 0, semantic: 'open' },
      { name: 'Legal review', position: 1, semantic: null },
      { name: 'Signed', position: 2, semantic: 'done' },
      { name: 'Dropped', position: 3, semantic: 'discard' },
    ]);
    expect(res.statusCode).toBe(200);

    const two = await laneCols(laneTwo);
    expect(two.map((c) => c.name)).toEqual(['Intake', 'Legal review', 'Signed', 'Dropped']);
    expect(two.find((c) => c.name === 'Dropped')!.semantic).toBe('discard');
    // lane one is untouched
    expect((await laneCols(laneOne)).map((c) => c.name)).toEqual(['Open', 'In progress', 'Done']);
  });

  it('every lane needs its own open and done column', async () => {
    const laneTwo = (await board()).lanes.find((l: { name: string }) => l.name === 'Lane Two').id;
    const res = await putCols(laneTwo, [
      { name: 'Intake', position: 0, semantic: 'open' },
      { name: 'Legal review', position: 1, semantic: null },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/every lane must keep/);
  });

  it('a card takes its lane from the column it is created in', async () => {
    const open = (await laneCols(laneOne)).find((c) => c.semantic === 'open')!;
    const card = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { cookie },
      payload: { boardId, columnId: open.id, title: 'lane one card' },
    });
    expect(card.statusCode).toBe(200);
    expect(card.json().lane_id).toBe(laneOne);
  });

  it('rejects a card whose requested lane disagrees with its column', async () => {
    const laneTwo = (await board()).lanes.find((l: { name: string }) => l.name === 'Lane Two').id;
    const open = (await laneCols(laneOne)).find((c) => c.semantic === 'open')!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { cookie },
      payload: { boardId, columnId: open.id, laneId: laneTwo, title: 'mismatched' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a lane holding cards cannot be deleted', async () => {
    const laneTwo = (await board()).lanes.find((l: { name: string }) => l.name === 'Lane Two').id;
    const res = await putLanes([{ id: laneTwo, name: 'Lane Two', position: 0 }]); // drops lane one, which holds a card
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/still holds cards/);
  });

  it('an empty lane can be deleted', async () => {
    const laneTwo = (await board()).lanes.find((l: { name: string }) => l.name === 'Lane Two').id;
    const res = await putLanes([{ id: laneOne, name: 'Lane One', position: 0 }]);
    expect(res.statusCode).toBe(200);
    expect((await board()).lanes.map((l: { id: string }) => l.id)).toEqual([laneOne]);
    // its columns went with it
    expect((await board()).columns.every((c: Col) => c.lane_id !== laneTwo)).toBe(true);
  });

  it('a board must keep at least one lane', async () => {
    const res = await putLanes([]);
    expect(res.statusCode).toBe(400);
  });

  it('owner avatar arrives as a presigned URL, never a raw storage key', async () => {
    await ctx.db.updateTable('users').set({ avatar_key: 'avatar/u/pic.png' }).where('id', '=', userId).execute();
    const cardId = (await board()).cards[0].id;
    await app.inject({
      method: 'PUT',
      url: `/api/cards/${cardId}/owners`,
      headers: { cookie },
      payload: [{ kind: 'user', id: userId }],
    });
    const detail = await board();
    const owner = detail.owners.find((o: { card_id: string }) => o.card_id === cardId);
    expect(owner.user_avatar).toBe('http://stub/signed/avatar/u/pic.png');

    const cardDetail = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie } });
    expect(cardDetail.json().owners[0].user_avatar).toMatch(/^http:\/\/stub\/signed\//);
  });
});
