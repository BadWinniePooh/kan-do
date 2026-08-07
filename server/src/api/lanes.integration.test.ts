/**
 * Lane invariant + avatar URL specs.
 * Invariant: once a board has >=1 lane, every card has a valid lane; with no
 * lanes, all cards have lane_id NULL. A card can never be hidden from every
 * lane view.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('lane invariant & avatars', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let cookie: string;
  let userId: string;
  let boardId: string;
  let openCol: string;

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

    const board = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie }, payload: { name: 'Lane board' } });
    boardId = board.json().id;
    const detail = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } });
    openCol = detail.json().columns.find((c: { semantic: string }) => c.semantic === 'open').id;
  });

  afterAll(async () => {
    await app.close();
    await ctx.db.destroy();
  });

  async function laneless(): Promise<number> {
    const rows = await ctx.db
      .selectFrom('cards')
      .select('id')
      .where('board_id', '=', boardId)
      .where('lane_id', 'is', null)
      .execute();
    return rows.length;
  }

  it('no lanes: cards are lane-less (single implicit lane)', async () => {
    const card = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { cookie },
      payload: { boardId, columnId: openCol, title: 'pre-lane card' },
    });
    expect(card.statusCode).toBe(200);
    expect(card.json().lane_id).toBeNull();
  });

  it('creating the FIRST lane adopts all lane-less cards', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/lanes`,
      headers: { cookie },
      payload: [{ name: 'Lane One', position: 0 }],
    });
    expect(res.statusCode).toBe(200);
    const laneOne = res.json()[0].id;
    expect(await laneless()).toBe(0);
    const cards = await ctx.db.selectFrom('cards').select('lane_id').where('board_id', '=', boardId).execute();
    expect(cards.every((c) => c.lane_id === laneOne)).toBe(true);
  });

  it('new card on a laned board gets the first lane even when none supplied', async () => {
    const card = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { cookie },
      payload: { boardId, columnId: openCol, title: 'post-lane card' },
    });
    expect(card.json().lane_id).not.toBeNull();
  });

  it('deleting a lane reassigns its cards to the first remaining lane', async () => {
    // add a second lane, then delete the first
    const detail = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } });
    const existing = detail.json().lanes[0];
    const two = await app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/lanes`,
      headers: { cookie },
      payload: [
        { id: existing.id, name: existing.name, position: 0 },
        { name: 'Lane Two', position: 1 },
      ],
    });
    const laneTwo = two.json().find((l: { name: string }) => l.name === 'Lane Two').id;

    const onlyTwo = await app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/lanes`,
      headers: { cookie },
      payload: [{ id: laneTwo, name: 'Lane Two', position: 0 }],
    });
    expect(onlyTwo.statusCode).toBe(200);
    expect(await laneless()).toBe(0);
    const cards = await ctx.db.selectFrom('cards').select('lane_id').where('board_id', '=', boardId).execute();
    expect(cards.every((c) => c.lane_id === laneTwo)).toBe(true);
  });

  it('deleting ALL lanes returns cards to the implicit lane (all NULL)', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/boards/${boardId}/lanes`, headers: { cookie }, payload: [] });
    expect(res.statusCode).toBe(200);
    const cards = await ctx.db.selectFrom('cards').select('lane_id').where('board_id', '=', boardId).execute();
    expect(cards.every((c) => c.lane_id === null)).toBe(true);
  });

  it('owner avatar arrives as a presigned URL, never a raw storage key', async () => {
    await ctx.db.updateTable('users').set({ avatar_key: 'avatar/u/pic.png' }).where('id', '=', userId).execute();
    const detail0 = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } });
    const cardId = detail0.json().cards[0].id;
    await app.inject({
      method: 'PUT',
      url: `/api/cards/${cardId}/owners`,
      headers: { cookie },
      payload: [{ kind: 'user', id: userId }],
    });
    const detail = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } });
    const owner = detail.json().owners.find((o: { card_id: string }) => o.card_id === cardId);
    expect(owner.user_avatar).toBe('http://stub/signed/avatar/u/pic.png');

    const cardDetail = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie } });
    expect(cardDetail.json().owners[0].user_avatar).toMatch(/^http:\/\/stub\/signed\//);
  });
});
