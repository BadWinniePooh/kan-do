/** Category specs: CRUD, uniqueness, card assignment, tenancy isolation. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

describe.skipIf(!hasDb)('categories', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let orgA: string;
  let orgB: string;
  let alice: string; // cookie, org A
  let bob: string; // cookie, org B
  let cardId: string;
  let catId: string;
  let bobCatId: string;

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
    const a = await db.insertInto('organizations').values({ name: 'Cat A', slug: `cat-a-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    const b = await db.insertInto('organizations').values({ name: 'Cat B', slug: `cat-b-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    orgA = a.id;
    orgB = b.id;
    await db
      .insertInto('users')
      .values([
        { org_id: orgA, email: `cat-alice-${RUN}@test.io`, display_name: 'Alice', role: 'user', password_hash: hash },
        { org_id: orgB, email: `cat-bob-${RUN}@test.io`, display_name: 'Bob', role: 'user', password_hash: hash },
      ])
      .execute();
    const login = async (email: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pass12345' } });
      return res.headers['set-cookie']!.toString().split(';')[0]!;
    };
    alice = await login(`cat-alice-${RUN}@test.io`);
    bob = await login(`cat-bob-${RUN}@test.io`);

    const board = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie: alice }, payload: { name: 'Cat board' } });
    const detail = await app.inject({ method: 'GET', url: `/api/boards/${board.json().id}`, headers: { cookie: alice } });
    const open = detail.json().columns.find((c: { semantic: string }) => c.semantic === 'open');
    const card = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { cookie: alice },
      payload: { boardId: board.json().id, columnId: open.id, title: 'categorized card' },
    });
    cardId = card.json().id;
  });

  afterAll(async () => {
    await ctx.db.deleteFrom('organizations').where('id', 'in', [orgA, orgB]).execute();
    await app.close();
    await ctx.db.destroy();
  });

  it('creates a category (name + color)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/categories',
      headers: { cookie: alice },
      payload: { name: 'Bug', color: '#e34948' },
    });
    expect(res.statusCode).toBe(200);
    catId = res.json().id;
    expect(res.json().color).toBe('#e34948');
  });

  it('duplicate name in the same org -> 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/categories',
      headers: { cookie: alice },
      payload: { name: 'Bug', color: '#2a78d6' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('invalid color rejected with field detail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/categories',
      headers: { cookie: alice },
      payload: { name: 'Nope', color: 'red' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('TENANCY: categories are invisible across orgs', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/categories',
      headers: { cookie: bob },
      payload: { name: 'Bob Cat', color: '#2a78d6' },
    });
    bobCatId = created.json().id;
    const listA = await app.inject({ method: 'GET', url: '/api/me/categories', headers: { cookie: alice } });
    expect(listA.json().some((c: { name: string }) => c.name === 'Bob Cat')).toBe(false);
  });

  it('assigns a category to a card; board detail carries categories', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${cardId}`,
      headers: { cookie: alice },
      payload: { categoryId: catId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category_id).toBe(catId);

    const card = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie: alice } });
    const boardId = card.json().card.board_id;
    const detail = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: alice } });
    expect(detail.json().categories.some((c: { id: string }) => c.id === catId)).toBe(true);
  });

  it('TENANCY: cannot assign another org\'s category to a card', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${cardId}`,
      headers: { cookie: alice },
      payload: { categoryId: bobCatId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rename + recolor', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/me/categories/${catId}`,
      headers: { cookie: alice },
      payload: { name: 'Defect', color: '#eb6834' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Defect');
  });

  it('TENANCY: cannot edit another org\'s category', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/me/categories/${bobCatId}`,
      headers: { cookie: alice },
      payload: { name: 'hax' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deleting a category clears it from cards (SET NULL)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/me/categories/${catId}`, headers: { cookie: alice } });
    expect(res.statusCode).toBe(200);
    const card = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie: alice } });
    expect(card.json().card.category_id).toBeNull();
  });
});
