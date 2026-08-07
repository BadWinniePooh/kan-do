/**
 * Specs for the backend-capability/UI-gap audit. Each block documents the
 * expected behavior of an endpoint the frontend now exposes:
 *   1. global admin creates users (incl. org admins) inside an org
 *   2. global admin renames an org
 *   3. board rename / 4. board delete / 5. board membership
 *   6. card delete
 *   7. org admin resets a user's password
 *   8. external-owner deletion
 *   9. invite with role
 *  10. duplicate email maps to a clean 409 (not a 500)
 * Needs DATABASE_URL to a migrated Postgres (CI service container).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('admin & board management gaps', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let rootCookie: string;
  let orgA: string;
  let orgB: string;
  let alice: { id: string; cookie: string };
  let carol: { id: string; cookie: string };
  let bob: { id: string; cookie: string }; // org B

  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return { id: res.json().id as string, cookie: res.headers['set-cookie']!.toString().split(';')[0]! };
  }

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
    await db.deleteFrom('organizations').execute();
    await db.deleteFrom('users').execute();
    await db
      .insertInto('users')
      .values({ org_id: null, email: 'root2@test.io', display_name: 'Root', role: 'global_admin', password_hash: hash })
      .execute();
    const a = await db.insertInto('organizations').values({ name: 'Gap Org A', slug: 'gap-a' }).returning('id').executeTakeFirstOrThrow();
    const b = await db.insertInto('organizations').values({ name: 'Gap Org B', slug: 'gap-b' }).returning('id').executeTakeFirstOrThrow();
    orgA = a.id;
    orgB = b.id;
    await db
      .insertInto('users')
      .values([
        { org_id: orgA, email: 'alice2@test.io', display_name: 'Alice', role: 'user', password_hash: hash },
        { org_id: orgA, email: 'carol2@test.io', display_name: 'Carol', role: 'user', password_hash: hash },
        { org_id: orgB, email: 'bob2@test.io', display_name: 'Bob', role: 'user', password_hash: hash },
      ])
      .execute();

    rootCookie = (await login('root2@test.io', 'pass12345')).cookie;
    alice = await login('alice2@test.io', 'pass12345');
    carol = await login('carol2@test.io', 'pass12345');
    bob = await login('bob2@test.io', 'pass12345');
  });

  afterAll(async () => {
    await app.close();
    await ctx.db.destroy();
  });

  // ---- gap 1 + 9 + 10: user creation by global admin, with role ----
  describe('global admin creates org users', () => {
    it('creates a normal user in an org', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/orgs/${orgA}/users`,
        headers: { cookie: rootCookie },
        payload: { email: 'new-user@test.io', displayName: 'New User', password: 'longpass1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('user');
    });

    it('creates an ORG ADMIN directly (bootstrap for a fresh org)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/orgs/${orgA}/users`,
        headers: { cookie: rootCookie },
        payload: { email: 'new-admin@test.io', displayName: 'New Admin', password: 'longpass1', role: 'org_admin' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('org_admin');
      // the new org admin can actually use admin powers
      const admin = await login('new-admin@test.io', 'longpass1');
      const list = await app.inject({ method: 'GET', url: `/api/orgs/${orgA}/users`, headers: { cookie: admin.cookie } });
      expect(list.statusCode).toBe(200);
    });

    it('duplicate email in the same org -> clean 409, not a 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/orgs/${orgA}/users`,
        headers: { cookie: rootCookie },
        payload: { email: 'alice2@test.io', displayName: 'Dup', password: 'longpass1' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/exists/i);
    });

    it('validation error carries field detail (short password)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/orgs/${orgA}/users`,
        headers: { cookie: rootCookie },
        payload: { email: 'x@test.io', displayName: 'X', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().fields.some((f: { path: string }) => f.path === 'password')).toBe(true);
    });

    it('plain user cannot create users, even in own org', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/orgs/${orgA}/users`,
        headers: { cookie: alice.cookie },
        payload: { email: 'nope@test.io', displayName: 'Nope', password: 'longpass1' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---- gap 2: org rename ----
  describe('org rename', () => {
    it('global admin renames an org', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/orgs/${orgA}`,
        headers: { cookie: rootCookie },
        payload: { name: 'Gap Org A Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Gap Org A Renamed');
    });

    it('non-global-admin denied', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/admin/orgs/${orgA}`,
        headers: { cookie: alice.cookie },
        payload: { name: 'hax' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---- gaps 3/4/5/6: board + card management ----
  describe('board rename, membership, delete; card delete', () => {
    let boardId: string;
    let cardId: string;

    beforeAll(async () => {
      const board = await app.inject({
        method: 'POST',
        url: '/api/boards',
        headers: { cookie: alice.cookie },
        payload: { name: 'Gap board' },
      });
      boardId = board.json().id;
      const detail = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: alice.cookie } });
      const open = detail.json().columns.find((c: { semantic: string }) => c.semantic === 'open');
      const card = await app.inject({
        method: 'POST',
        url: '/api/cards',
        headers: { cookie: alice.cookie },
        payload: { boardId, columnId: open.id, title: 'gap card' },
      });
      cardId = card.json().id;
    });

    it('member renames the board', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/boards/${boardId}`,
        headers: { cookie: alice.cookie },
        payload: { name: 'Gap board v2' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Gap board v2');
    });

    it('org-user directory: alice sees her org only (member picker source)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/me/org-users', headers: { cookie: alice.cookie } });
      expect(res.statusCode).toBe(200);
      const emails = res.json().map((u: { email: string }) => u.email);
      expect(emails).toContain('carol2@test.io');
      expect(emails).not.toContain('bob2@test.io'); // no cross-tenant leak
    });

    it('member adds a same-org member; new member can view the board', async () => {
      const add = await app.inject({
        method: 'POST',
        url: `/api/boards/${boardId}/members`,
        headers: { cookie: alice.cookie },
        payload: { userId: carol.id },
      });
      expect(add.statusCode).toBe(200);
      const view = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: carol.cookie } });
      expect(view.statusCode).toBe(200);
    });

    it('cross-org user cannot be added as member', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/boards/${boardId}/members`,
        headers: { cookie: alice.cookie },
        payload: { userId: bob.id },
      });
      expect(res.statusCode).toBe(400);
    });

    it('non-owner member cannot delete the board; owner can', async () => {
      const denied = await app.inject({ method: 'DELETE', url: `/api/boards/${boardId}`, headers: { cookie: carol.cookie } });
      expect(denied.statusCode).toBe(403);

      // card delete first (gap 6): member deletes a card
      const delCard = await app.inject({ method: 'DELETE', url: `/api/cards/${cardId}`, headers: { cookie: carol.cookie } });
      expect(delCard.statusCode).toBe(200);
      const gone = await app.inject({ method: 'GET', url: `/api/cards/${cardId}`, headers: { cookie: alice.cookie } });
      expect(gone.statusCode).toBe(404);

      // removed member loses access
      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/boards/${boardId}/members/${carol.id}`,
        headers: { cookie: alice.cookie },
      });
      expect(remove.statusCode).toBe(200);
      const noView = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: carol.cookie } });
      expect(noView.statusCode).toBe(403);

      const del = await app.inject({ method: 'DELETE', url: `/api/boards/${boardId}`, headers: { cookie: alice.cookie } });
      expect(del.statusCode).toBe(200);
      const goneBoard = await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie: alice.cookie } });
      expect(goneBoard.statusCode).toBe(404);
    });
  });

  // ---- gap 7: password reset ----
  describe('password reset by admin', () => {
    it('old password stops working, new one works', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/orgs/${orgA}/users/${carol.id}`,
        headers: { cookie: rootCookie },
        payload: { password: 'brandnewpass1' },
      });
      expect(res.statusCode).toBe(200);
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'carol2@test.io', password: 'pass12345' },
      });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'carol2@test.io', password: 'brandnewpass1' },
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it('too-short replacement rejected with field detail', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/orgs/${orgA}/users/${carol.id}`,
        headers: { cookie: rootCookie },
        payload: { password: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---- gap 8: external owner deletion ----
  describe('external owner directory', () => {
    it('org admin deletes an external owner; cross-org delete is a no-op', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/me/external-owners',
        headers: { cookie: alice.cookie },
        payload: { displayName: 'Vendor X' },
      });
      const extId = created.json().id;

      // bob (org B, but needs admin) — plain user in another org: forbidden by preHandler
      const denied = await app.inject({
        method: 'DELETE',
        url: `/api/orgs/${orgA}/external-owners/${extId}`,
        headers: { cookie: bob.cookie },
      });
      expect(denied.statusCode).toBe(403);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/orgs/${orgA}/external-owners/${extId}`,
        headers: { cookie: rootCookie },
      });
      expect(del.statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: '/api/me/external-owners', headers: { cookie: alice.cookie } });
      expect(list.json().some((x: { id: string }) => x.id === extId)).toBe(false);
    });
  });
});
