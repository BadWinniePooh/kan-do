/**
 * Column policies end to end: management, the gated move flow, partial progress,
 * the no-backwards rule, overrides and their audit trail, and tenancy.
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
  name: string;
  position: number;
  semantic: string | null;
}
interface PolicyRow {
  id: string;
  column_id: string;
  kind: 'enter' | 'leave';
  label: string;
  position: number;
}

describe.skipIf(!hasDb)('column policies', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let mallory: string;
  let boardId: string;
  let open: Col;
  let doing: Col;
  let done: Col;

  const authed = (cookie: string) => ({ cookie });

  const board = async (cookie = alice) =>
    (await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: authed(cookie) })).json();

  const newCard = async (columnId: string, title: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: authed(alice),
      payload: { boardId, columnId, title },
    });
    return res.json().id as string;
  };

  const setPolicies = (columnId: string, policies: { id?: string; kind: 'enter' | 'leave'; label: string }[]) =>
    app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/columns/${columnId}/policies`,
      headers: authed(alice),
      payload: policies.map((p, i) => ({ ...p, position: i })),
    });

  const requirements = (cardId: string, toColumnId: string, cookie = alice) =>
    app.inject({
      method: 'GET',
      url: `/api/cards/${cardId}/move-requirements?toColumnId=${toColumnId}`,
      headers: authed(cookie),
    });

  const move = (cardId: string, toColumnId: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/cards/${cardId}/move`, headers: authed(alice), payload: { toColumnId, ...payload } });

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
    orgA = (await db.insertInto('organizations').values({ name: 'Pol A', slug: `pol-a-${RUN}` }).returning('id').executeTakeFirstOrThrow()).id;
    orgB = (await db.insertInto('organizations').values({ name: 'Pol B', slug: `pol-b-${RUN}` }).returning('id').executeTakeFirstOrThrow()).id;
    await db
      .insertInto('users')
      .values([
        { org_id: orgA, email: `pol-alice-${RUN}@test.io`, display_name: 'Alice', role: 'user', password_hash: hash },
        { org_id: orgB, email: `pol-mallory-${RUN}@test.io`, display_name: 'Mallory', role: 'user', password_hash: hash },
      ])
      .execute();
    const login = async (email: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pass12345' } });
      return res.headers['set-cookie']!.toString().split(';')[0]!;
    };
    alice = await login(`pol-alice-${RUN}@test.io`);
    mallory = await login(`pol-mallory-${RUN}@test.io`);

    const created = await app.inject({ method: 'POST', url: '/api/boards', headers: authed(alice), payload: { name: 'Policy board' } });
    boardId = created.json().id;
    const cols = (await board()).columns as Col[];
    open = cols.find((c) => c.semantic === 'open')!;
    done = cols.find((c) => c.semantic === 'done')!;
    doing = cols.find((c) => c.semantic === null)!;
  });

  afterAll(async () => {
    await ctx.db.deleteFrom('organizations').where('id', 'in', [orgA, orgB]).execute();
    await app.close();
    await ctx.db.destroy();
  });

  describe('managing policies', () => {
    it('creates, reorders, renames and deletes in one replace-style call', async () => {
      const created = await setPolicies(doing.id, [
        { kind: 'enter', label: 'Estimated' },
        { kind: 'enter', label: 'Assigned' },
        { kind: 'leave', label: 'Reviewed' },
      ]);
      expect(created.statusCode).toBe(200);
      const rows = created.json() as PolicyRow[];
      expect(rows).toHaveLength(3);

      const estimated = rows.find((r) => r.label === 'Estimated')!;
      const assigned = rows.find((r) => r.label === 'Assigned')!;
      // reorder (assigned first), rename, and drop the 'leave' one
      const updated = await setPolicies(doing.id, [
        { id: assigned.id, kind: 'enter', label: 'Owner assigned' },
        { id: estimated.id, kind: 'enter', label: 'Estimated' },
      ]);
      expect(updated.statusCode).toBe(200);
      const after = updated.json() as PolicyRow[];
      expect(after.map((p) => p.label)).toEqual(['Owner assigned', 'Estimated']);
      expect(after.map((p) => p.position)).toEqual([0, 1]);

      const onBoard = (await board()).policies as PolicyRow[];
      expect(onBoard.filter((p) => p.column_id === doing.id).map((p) => p.label)).toEqual(['Owner assigned', 'Estimated']);
    });

    it('TENANCY: an outsider can neither read nor write a board\'s policies', async () => {
      const read = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/policies`, headers: authed(mallory) });
      expect(read.statusCode).toBe(403);
      const write = await app.inject({
        method: 'PUT',
        url: `/api/boards/${boardId}/columns/${doing.id}/policies`,
        headers: authed(mallory),
        payload: [{ kind: 'enter', label: 'sneaky', position: 0 }],
      });
      expect(write.statusCode).toBe(403);
    });

    it('rejects a column that belongs to another board', async () => {
      const other = await app.inject({ method: 'POST', url: '/api/boards', headers: authed(alice), payload: { name: 'Other' } });
      const otherId = other.json().id;
      const res = await app.inject({
        method: 'PUT',
        url: `/api/boards/${otherId}/columns/${doing.id}/policies`,
        headers: authed(alice),
        payload: [{ kind: 'enter', label: 'x', position: 0 }],
      });
      expect(res.statusCode).toBe(400);
      await app.inject({ method: 'DELETE', url: `/api/boards/${otherId}`, headers: authed(alice) });
    });
  });

  describe('the gated move', () => {
    let cardId: string;
    let enterA: PolicyRow;
    let enterB: PolicyRow;
    let leaveOpen: PolicyRow;

    beforeAll(async () => {
      const entering = await setPolicies(doing.id, [
        { kind: 'enter', label: 'Acceptance criteria written' },
        { kind: 'enter', label: 'Owner assigned' },
      ]);
      [enterA, enterB] = entering.json() as [PolicyRow, PolicyRow];
      const leaving = await setPolicies(open.id, [{ kind: 'leave', label: 'Triaged' }]);
      leaveOpen = (leaving.json() as PolicyRow[])[0]!;
      cardId = await newCard(open.id, 'Gated card');
    });

    it('move-requirements lists the source leave and target enter policies', async () => {
      const res = await requirements(cardId, doing.id);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.backwards).toBe(false);
      expect(body.applicable.map((p: { label: string }) => p.label)).toEqual([
        'Triaged',
        'Acceptance criteria written',
        'Owner assigned',
      ]);
      expect(body.checkedIds).toEqual([]);
    });

    it('refuses the move while policies are unticked and reports which', async () => {
      const res = await move(cardId, doing.id, { acknowledgedPolicyIds: [] });
      expect(res.statusCode).toBe(409);
      expect(res.json().details.unmet).toHaveLength(3);
      const detail = await board();
      expect(detail.cards.find((c: { id: string }) => c.id === cardId).column_id).toBe(open.id);
    });

    it('saves partial progress from a refused attempt', async () => {
      const res = await move(cardId, doing.id, { acknowledgedPolicyIds: [leaveOpen.id, enterA.id] });
      expect(res.statusCode).toBe(409);
      expect(res.json().details.unmet.map((p: { id: string }) => p.id)).toEqual([enterB.id]);

      // the ticks survive to the next attempt rather than being re-entered
      const again = await requirements(cardId, doing.id);
      expect([...(again.json().checkedIds as string[])].sort()).toEqual([leaveOpen.id, enterA.id].sort());
    });

    it('saves progress without moving via move-progress', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cards/${cardId}/move-progress`,
        headers: authed(alice),
        payload: { toColumnId: doing.id, acknowledgedPolicyIds: [leaveOpen.id] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().checkedIds).toEqual([leaveOpen.id]);
      const detail = await board();
      expect(detail.cards.find((c: { id: string }) => c.id === cardId).column_id).toBe(open.id);
    });

    it('moves once every applicable policy is ticked, and clears the checklist', async () => {
      const res = await move(cardId, doing.id, { acknowledgedPolicyIds: [leaveOpen.id, enterA.id, enterB.id] });
      expect(res.statusCode).toBe(200);
      expect(res.json().column_id).toBe(doing.id);

      const progress = await ctx.db.selectFrom('card_policy_progress').select('policy_id').where('card_id', '=', cardId).execute();
      expect(progress).toEqual([]);

      // and no override was recorded — this was the normal path
      const overrides = await ctx.db.selectFrom('card_move_overrides').select('id').where('card_id', '=', cardId).execute();
      expect(overrides).toEqual([]);
    });

    it('a card with no applicable policies moves straight through', async () => {
      const plain = await newCard(doing.id, 'Ungated');
      const req = await requirements(plain, done.id);
      expect(req.json().applicable).toEqual([]);
      expect((await move(plain, done.id)).statusCode).toBe(200);
    });
  });

  describe('backwards moves', () => {
    it('are blocked outright', async () => {
      const card = await newCard(done.id, 'Backslider');
      const req = await requirements(card, open.id);
      expect(req.json().backwards).toBe(true);

      const res = await move(card, open.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().details.backwards).toBe(true);
      expect(res.json().error).toMatch(/earlier column/);
    });

    it('a forward move to the very next column is never backwards', async () => {
      const card = await newCard(open.id, 'Forward');
      expect((await requirements(card, done.id)).json().backwards).toBe(false);
    });
  });

  describe('overrides', () => {
    it('an unmet-policy override moves the card and records what was skipped', async () => {
      const [policy] = (await setPolicies(done.id, [{ kind: 'enter', label: 'Release notes updated' }])).json() as PolicyRow[];
      const card = await newCard(doing.id, 'Forced through');

      const blocked = await move(card, done.id);
      expect(blocked.statusCode).toBe(409);

      const forced = await move(card, done.id, { override: { policies: true }, reason: 'hotfix, notes to follow' });
      expect(forced.statusCode).toBe(200);
      expect(forced.json().column_id).toBe(done.id);

      const audit = await ctx.db.selectFrom('card_move_overrides').selectAll().where('card_id', '=', card).execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.backwards).toBe(false);
      expect(audit[0]!.reason).toBe('hotfix, notes to follow');
      expect(audit[0]!.skipped_policies).toEqual([
        { policyId: policy!.id, kind: 'enter', label: 'Release notes updated', columnId: done.id, columnName: done.name },
      ]);
      expect(audit[0]!.actor_id).toBeTruthy();

      await setPolicies(done.id, []);
    });

    it('an override without a reason is refused', async () => {
      const card = await newCard(done.id, 'No excuse');
      const res = await move(card, open.id, { override: { backwards: true } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/requires a reason/);
      const audit = await ctx.db.selectFrom('card_move_overrides').select('id').where('card_id', '=', card).execute();
      expect(audit).toEqual([]);
    });

    it('a backwards override is recorded as such', async () => {
      const card = await newCard(done.id, 'Reversed');
      const res = await move(card, open.id, { override: { backwards: true }, reason: 'shipped by mistake' });
      expect(res.statusCode).toBe(200);
      expect(res.json().column_id).toBe(open.id);

      const audit = await ctx.db.selectFrom('card_move_overrides').selectAll().where('card_id', '=', card).execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.backwards).toBe(true);
      expect(audit[0]!.skipped_policies).toEqual([]);
      expect(audit[0]!.reason).toBe('shipped by mistake');
    });

    it('a policy override alone does not unlock a backwards move', async () => {
      const card = await newCard(done.id, 'Still stuck');
      const res = await move(card, open.id, { override: { policies: true }, reason: 'trying it on' });
      expect(res.statusCode).toBe(409);
      expect(res.json().details.backwards).toBe(true);
    });

    it('overrides are queryable per board and roll up into board metrics', async () => {
      const listed = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/policy-overrides`, headers: authed(alice) });
      expect(listed.statusCode).toBe(200);
      const rows = listed.json() as { backwards: boolean; actor_name: string; card_title: string }[];
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => r.actor_name === 'Alice')).toBe(true);
      expect(rows.some((r) => r.backwards)).toBe(true);

      const m = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/metrics`, headers: authed(alice) });
      const o = m.json().overrides;
      expect(o.total).toBe(rows.length);
      expect(o.backwardsMoves).toBeGreaterThanOrEqual(1);
      expect(o.policiesSkipped).toBeGreaterThanOrEqual(1);
    });

    it('TENANCY: an outsider cannot read the override audit', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/policy-overrides`, headers: authed(mallory) });
      expect(res.statusCode).toBe(403);
    });

    it('the audit survives deleting the policy it names', async () => {
      const [policy] = (await setPolicies(done.id, [{ kind: 'enter', label: 'Temporary rule' }])).json() as PolicyRow[];
      const card = await newCard(doing.id, 'Outlives its rule');
      await move(card, done.id, { override: { policies: true }, reason: 'rule about to be retired' });
      await setPolicies(done.id, []); // policy gone

      const audit = await ctx.db.selectFrom('card_move_overrides').selectAll().where('card_id', '=', card).execute();
      expect(audit).toHaveLength(1);
      expect((audit[0]!.skipped_policies as { policyId: string; label: string }[])[0]).toMatchObject({
        policyId: policy!.id,
        label: 'Temporary rule',
      });
    });
  });
});
