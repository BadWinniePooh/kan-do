/**
 * Blockers end to end: lifecycle, markdown comments, move enforcement with
 * override + audit, board-level visibility, metrics, and the widget builder's
 * facts endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

interface Col {
  id: string;
  lane_id: string;
  name: string;
  position: number;
  semantic: string | null;
}

describe.skipIf(!hasDb)('blockers', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let cookie: string;
  let outsider: string;
  let boardId: string;
  let open: Col;
  let doing: Col;

  const board = async () => (await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } })).json();

  const newCard = async (columnId: string, title: string): Promise<string> =>
    (await app.inject({ method: 'POST', url: '/api/cards', headers: { cookie }, payload: { boardId, columnId, title } })).json()
      .id as string;

  const block = (cardId: string, reason: string) =>
    app.inject({ method: 'POST', url: `/api/cards/${cardId}/blockers`, headers: { cookie }, payload: { reason } });

  const move = (cardId: string, toColumnId: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/cards/${cardId}/move`, headers: { cookie }, payload: { toColumnId, ...payload } });

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
    const org = await db.insertInto('organizations').values({ name: 'Blk Org', slug: `blk-${RUN}` }).returning('id').executeTakeFirstOrThrow();
    const otherOrg = await db
      .insertInto('organizations')
      .values({ name: 'Blk Other', slug: `blk-other-${RUN}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('users')
      .values([
        { org_id: org.id, email: `blk-${RUN}@test.io`, display_name: 'Bea', role: 'user', password_hash: hash },
        { org_id: otherOrg.id, email: `blk-out-${RUN}@test.io`, display_name: 'Otto', role: 'user', password_hash: hash },
      ])
      .execute();
    const login = async (email: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pass12345' } })).headers[
        'set-cookie'
      ]!
        .toString()
        .split(';')[0]!;
    cookie = await login(`blk-${RUN}@test.io`);
    outsider = await login(`blk-out-${RUN}@test.io`);

    const created = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie }, payload: { name: 'Blocker board' } });
    boardId = created.json().id;
    const cols = (await board()).columns as Col[];
    open = cols.find((c) => c.semantic === 'open')!;
    doing = cols.find((c) => c.semantic === null)!;
  });

  afterAll(async () => {
    // boards before the org: see the note on DELETE /api/admin/orgs/:orgId
    await ctx.db.deleteFrom('boards').where('id', '=', boardId).execute();
    await ctx.db.deleteFrom('organizations').where('slug', 'like', `blk-%${RUN}`).execute();
    await app.close();
    await ctx.db.destroy();
  });

  describe('lifecycle', () => {
    it('starts active with a required reason and a start time', async () => {
      const card = await newCard(open.id, 'Stuck card');
      const res = await block(card, 'waiting on the vendor');
      expect(res.statusCode).toBe(200);
      expect(res.json().reason).toBe('waiting on the vendor');
      expect(res.json().ended_at).toBeNull();
      expect(res.json().started_at).toBeTruthy();

      const listed = await app.inject({ method: 'GET', url: `/api/cards/${card}/blockers`, headers: { cookie } });
      expect(listed.json()).toHaveLength(1);
      expect(listed.json()[0].created_by_name).toBe('Bea');
    });

    it('rejects a blocker with no reason', async () => {
      const card = await newCard(open.id, 'Reasonless');
      const res = await app.inject({
        method: 'POST',
        url: `/api/cards/${card}/blockers`,
        headers: { cookie },
        payload: { reason: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('resolving stamps the end and who did it; the blocker stays as history', async () => {
      const card = await newCard(open.id, 'Unstuck later');
      const b = (await block(card, 'waiting on legal')).json();
      const res = await app.inject({ method: 'POST', url: `/api/cards/${card}/blockers/${b.id}/resolve`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().ended_at).not.toBeNull();

      const listed = await app.inject({ method: 'GET', url: `/api/cards/${card}/blockers`, headers: { cookie } });
      expect(listed.json()).toHaveLength(1);
      expect(listed.json()[0].resolved_by_name).toBe('Bea');
    });

    it('refuses an end before the start', async () => {
      const card = await newCard(open.id, 'Time travel');
      const b = (await block(card, 'nonsense')).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card}/blockers/${b.id}`,
        headers: { cookie },
        payload: { endedAt: new Date(Date.now() - 86_400_000).toISOString() },
      });
      expect(res.statusCode).toBe(400);
    });

    it('carries markdown comments with the same edit/render pattern as notes', async () => {
      const card = await newCard(open.id, 'Chatty blocker');
      const b = (await block(card, 'needs a decision')).json();
      const base = `/api/cards/${card}/blockers/${b.id}`;

      const added = await app.inject({ method: 'POST', url: `${base}/comments`, headers: { cookie }, payload: { markdown: '**chased** vendor' } });
      expect(added.statusCode).toBe(200);
      const commentId = added.json().id;

      await app.inject({ method: 'PATCH', url: `${base}/comments/${commentId}`, headers: { cookie }, payload: { markdown: 'chased _twice_' } });
      const listed = await app.inject({ method: 'GET', url: `/api/cards/${card}/blockers`, headers: { cookie } });
      expect(listed.json()[0].comments[0].markdown).toBe('chased _twice_');
      expect(listed.json()[0].comments[0].author_name).toBe('Bea');

      await app.inject({ method: 'DELETE', url: `${base}/comments/${commentId}`, headers: { cookie } });
      const after = await app.inject({ method: 'GET', url: `/api/cards/${card}/blockers`, headers: { cookie } });
      expect(after.json()[0].comments).toEqual([]);
    });

    it('cannot exist without its card — deleting the card takes them', async () => {
      const card = await newCard(open.id, 'Doomed');
      const b = (await block(card, 'about to vanish')).json();
      await app.inject({ method: 'POST', url: `/api/cards/${card}/blockers/${b.id}/comments`, headers: { cookie }, payload: { markdown: 'note' } });

      await app.inject({ method: 'DELETE', url: `/api/cards/${card}`, headers: { cookie } });
      expect(await ctx.db.selectFrom('card_blockers').select('id').where('id', '=', b.id).execute()).toEqual([]);
      expect(await ctx.db.selectFrom('card_blocker_comments').select('id').where('blocker_id', '=', b.id).execute()).toEqual([]);
    });

    it('TENANCY: an outsider can neither read nor add blockers', async () => {
      const card = await newCard(open.id, 'Private');
      await block(card, 'internal');
      expect((await app.inject({ method: 'GET', url: `/api/cards/${card}/blockers`, headers: { cookie: outsider } })).statusCode).toBe(403);
      const write = await app.inject({
        method: 'POST',
        url: `/api/cards/${card}/blockers`,
        headers: { cookie: outsider },
        payload: { reason: 'sneaky' },
      });
      expect(write.statusCode).toBe(403);
    });
  });

  describe('move enforcement', () => {
    it('an active blocker holds the card in its column', async () => {
      const card = await newCard(open.id, 'Held');
      await block(card, 'waiting on the customer');

      const req = await app.inject({
        method: 'GET',
        url: `/api/cards/${card}/move-requirements?toColumnId=${doing.id}`,
        headers: { cookie },
      });
      expect(req.json().activeBlockers).toHaveLength(1);
      expect(req.json().requiresReason).toBe(true);

      const res = await move(card, doing.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().details.activeBlockers[0].reason).toBe('waiting on the customer');
      expect(res.json().error).toMatch(/unresolved blocker/);
      expect((await board()).cards.find((c: { id: string }) => c.id === card).column_id).toBe(open.id);
    });

    it('resolving the blocker lets the card move normally', async () => {
      const card = await newCard(open.id, 'Freed');
      const b = (await block(card, 'briefly stuck')).json();
      expect((await move(card, doing.id)).statusCode).toBe(409);

      await app.inject({ method: 'POST', url: `/api/cards/${card}/blockers/${b.id}/resolve`, headers: { cookie } });
      const ok = await move(card, doing.id);
      expect(ok.statusCode).toBe(200);
      // moving normally records no override
      expect(await ctx.db.selectFrom('card_move_overrides').select('id').where('card_id', '=', card).execute()).toEqual([]);
    });

    it('overriding needs a reason and is audited with the blockers it bypassed', async () => {
      const card = await newCard(open.id, 'Forced past');
      await block(card, 'still waiting on the vendor');

      expect((await move(card, doing.id, { override: { blockers: true } })).statusCode).toBe(400);

      const ok = await move(card, doing.id, { override: { blockers: true }, reason: 'deadline, proceeding at risk' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().column_id).toBe(doing.id);

      const audit = await ctx.db.selectFrom('card_move_overrides').selectAll().where('card_id', '=', card).execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.blocked).toBe(true);
      expect(audit[0]!.reason).toBe('deadline, proceeding at risk');
      expect((audit[0]!.blockers as { reason: string }[])[0]!.reason).toBe('still waiting on the vendor');

      // moving past it does not resolve it — the card is still blocked
      const listed = await app.inject({ method: 'GET', url: `/api/cards/${card}/blockers`, headers: { cookie } });
      expect(listed.json()[0].ended_at).toBeNull();
    });

    it('shows up in the card audit timeline: blocked, override, resolved', async () => {
      const card = await newCard(open.id, 'Full story');
      const b = (await block(card, 'awaiting sign-off')).json();
      await move(card, doing.id, { override: { blockers: true }, reason: 'shipping regardless' });
      await app.inject({ method: 'POST', url: `/api/cards/${card}/blockers/${b.id}/resolve`, headers: { cookie } });

      const res = await app.inject({ method: 'GET', url: `/api/cards/${card}/audit`, headers: { cookie } });
      const timeline = res.json().timeline as { kind: string; reason: string | null }[];
      expect(timeline.some((e) => e.kind === 'blocked' && e.reason === 'awaiting sign-off')).toBe(true);
      expect(timeline.some((e) => e.kind === 'unblocked')).toBe(true);
      const override = timeline.find((e) => e.kind === 'override') as { bypassedBlockers: { reason: string }[]; reason: string };
      expect(override.reason).toBe('shipping regardless');
      expect(override.bypassedBlockers[0]!.reason).toBe('awaiting sign-off');
    });
  });

  describe('visibility & reporting', () => {
    it('active blockers ship with the board so a blocked card is obvious without opening it', async () => {
      const card = await newCard(open.id, 'Visibly stuck');
      await block(card, 'blocked in the open');
      const detail = await board();
      const shown = detail.blockers.find((b: { card_id: string }) => b.card_id === card);
      expect(shown.reason).toBe('blocked in the open');
      // resolved ones do not clutter the board
      const resolvedCard = await newCard(open.id, 'Was stuck');
      const rb = (await block(resolvedCard, 'briefly')).json();
      await app.inject({ method: 'POST', url: `/api/cards/${resolvedCard}/blockers/${rb.id}/resolve`, headers: { cookie } });
      expect((await board()).blockers.some((b: { card_id: string }) => b.card_id === resolvedCard)).toBe(false);
    });

    it('board metrics report how often cards block and for how long', async () => {
      const m = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/metrics`, headers: { cookie } });
      const b = m.json().blockers;
      expect(b.totalCount).toBeGreaterThanOrEqual(5);
      expect(b.everBlockedCardCount).toBeGreaterThanOrEqual(5);
      expect(b.activeCount).toBeGreaterThanOrEqual(1);
      expect(b.blockedCardCount).toBeGreaterThanOrEqual(1);
      expect(b.meanBlockedMs).not.toBeNull();
    });

    it('is groupable in the pivot engine by status and by reason', async () => {
      const byStatus = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/query',
        headers: { cookie },
        payload: { dimensions: ['blockStatus'], metric: 'count', aggregation: 'count', boardIds: [boardId] },
      });
      const statuses = (byStatus.json().rows as { keys: string[] }[]).map((r) => r.keys[0]);
      expect(statuses).toContain('Blocked now');
      expect(statuses).toContain('Was blocked');

      const byReason = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/query',
        headers: { cookie },
        payload: { dimensions: ['blockerReason'], metric: 'count', aggregation: 'count', boardIds: [boardId] },
      });
      const reasons = (byReason.json().rows as { keys: string[] }[]).map((r) => r.keys[0]);
      expect(reasons).toContain('waiting on the customer');
    });
  });

  describe('the builder data browser', () => {
    it('returns real rows with a field catalogue covering blockers and reasons', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/facts',
        headers: { cookie },
        payload: { boardIds: [boardId] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        fields: { key: string; kind: string }[];
        rows: Record<string, unknown>[];
        total: number;
      };
      const keys = body.fields.map((f) => f.key);
      for (const expected of ['blockStatus', 'blockerReason', 'discardReason', 'overrideReason', 'blockerCount', 'blockedTimeMs']) {
        expect(keys).toContain(expected);
      }
      expect(body.rows.length).toBeGreaterThan(0);
      expect(body.rows.length).toBe(Math.min(body.total, 200));
      // multi-valued dimensions arrive as one readable cell, not an array
      expect(typeof body.rows[0]!.owner).toBe('string');
      expect(body.rows.some((r) => r.blockStatus === 'Blocked now')).toBe(true);
    });

    it('respects the row limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/facts',
        headers: { cookie },
        payload: { boardIds: [boardId], limit: 2 },
      });
      expect(res.json().rows).toHaveLength(2);
      expect(res.json().total).toBeGreaterThan(2);
    });

    it('TENANCY: browsing another org\'s board yields nothing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/facts',
        headers: { cookie: outsider },
        payload: { boardIds: [boardId] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows).toEqual([]);
      expect(res.json().boardCount).toBe(0);
    });
  });
});
