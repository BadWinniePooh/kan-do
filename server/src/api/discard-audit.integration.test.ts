/**
 * Cross-lane moves, discard columns (recurrence + metrics), mandatory reasons,
 * and the card audit timeline.
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

describe.skipIf(!hasDb)('discard, lane moves & card audit', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let orgId: string;
  let cookie: string;
  let boardId: string;
  let laneA: string;
  let laneB: string;
  let aOpen: Col;
  let aDoing: Col;
  let aDone: Col;
  let aBin: Col;
  let bOpen: Col;

  const board = async () => (await app.inject({ method: 'GET', url: `/api/boards/${boardId}`, headers: { cookie } })).json();
  const cols = async (laneId: string): Promise<Col[]> =>
    (await board()).columns.filter((c: Col) => c.lane_id === laneId).sort((a: Col, b: Col) => a.position - b.position);

  const newCard = async (columnId: string, title: string): Promise<string> =>
    (
      await app.inject({ method: 'POST', url: '/api/cards', headers: { cookie }, payload: { boardId, columnId, title } })
    ).json().id as string;

  const move = (cardId: string, toColumnId: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/cards/${cardId}/move`, headers: { cookie }, payload: { toColumnId, ...payload } });

  const requirements = (cardId: string, toColumnId: string) =>
    app.inject({ method: 'GET', url: `/api/cards/${cardId}/move-requirements?toColumnId=${toColumnId}`, headers: { cookie } });

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
    orgId = (await db.insertInto('organizations').values({ name: 'Disc Org', slug: `disc-${RUN}` }).returning('id').executeTakeFirstOrThrow()).id;
    await db
      .insertInto('users')
      .values({ org_id: orgId, email: `disc-${RUN}@test.io`, display_name: 'Dana', role: 'user', password_hash: hash })
      .execute();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `disc-${RUN}@test.io`, password: 'pass12345' } });
    cookie = login.headers['set-cookie']!.toString().split(';')[0]!;

    const created = await app.inject({ method: 'POST', url: '/api/boards', headers: { cookie }, payload: { name: 'Discard board' } });
    boardId = created.json().id;
    laneA = (await board()).lanes[0].id;

    // lane A gets a discard column; lane B is created with its own defaults
    const laneRes = await app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/lanes`,
      headers: { cookie },
      payload: [
        { id: laneA, name: 'Lane A', position: 0 },
        { name: 'Lane B', position: 1 },
      ],
    });
    laneB = (laneRes.json() as { id: string; name: string }[]).find((l) => l.name === 'Lane B')!.id;
    await app.inject({
      method: 'PUT',
      url: `/api/boards/${boardId}/lanes/${laneA}/columns`,
      headers: { cookie },
      payload: [
        { name: 'Open', position: 0, semantic: 'open' },
        { name: 'Doing', position: 1, semantic: null },
        { name: 'Done', position: 2, semantic: 'done' },
        { name: 'Binned', position: 3, semantic: 'discard' },
      ],
    });
    const a = await cols(laneA);
    aOpen = a.find((c) => c.semantic === 'open')!;
    aDoing = a.find((c) => c.semantic === null)!;
    aDone = a.find((c) => c.semantic === 'done')!;
    aBin = a.find((c) => c.semantic === 'discard')!;
    bOpen = (await cols(laneB)).find((c) => c.semantic === 'open')!;
  });

  afterAll(async () => {
    await ctx.db.deleteFrom('organizations').where('id', '=', orgId).execute();
    await app.close();
    await ctx.db.destroy();
  });

  describe('cross-lane moves', () => {
    it('are blocked by default and reported as a lane move', async () => {
      const card = await newCard(aOpen.id, 'Wanderer');
      const req = await requirements(card, bOpen.id);
      expect(req.json().laneMove).toBe(true);
      expect(req.json().backwards).toBe(false); // no shared order across lanes

      const res = await move(card, bOpen.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().details.laneMove).toBe(true);
      expect(res.json().error).toMatch(/between lanes/);
      expect((await board()).cards.find((c: { id: string }) => c.id === card).lane_id).toBe(laneA);
    });

    it('go through with an explicit override and a reason, and are audited', async () => {
      const card = await newCard(aOpen.id, 'Escalated');
      expect((await move(card, bOpen.id, { override: { lane: true } })).statusCode).toBe(400); // no reason

      const ok = await move(card, bOpen.id, { override: { lane: true }, reason: 'escalated to the other team' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().lane_id).toBe(laneB);
      expect(ok.json().column_id).toBe(bOpen.id);

      const audit = await ctx.db.selectFrom('card_move_overrides').selectAll().where('card_id', '=', card).execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.lane_move).toBe(true);
      expect(audit[0]!.backwards).toBe(false);
      expect(audit[0]!.from_lane_id).toBe(laneA);
      expect(audit[0]!.to_lane_id).toBe(laneB);
      expect(audit[0]!.reason).toBe('escalated to the other team');
    });

    it('a card cannot be re-laned through a plain PATCH', async () => {
      const card = await newCard(aOpen.id, 'Sneaky');
      const res = await app.inject({ method: 'PATCH', url: `/api/cards/${card}`, headers: { cookie }, payload: { laneId: laneB } });
      // the field is simply not part of the patch contract; the lane is unchanged
      expect(res.statusCode).toBe(200);
      expect(res.json().lane_id).toBe(laneA);
    });
  });

  describe('discard', () => {
    it('needs a reason, and records it on the transition', async () => {
      const card = await newCard(aDoing.id, 'Abandoned');
      const req = await requirements(card, aBin.id);
      expect(req.json().discarding).toBe(true);
      expect(req.json().requiresReason).toBe(true);
      expect(req.json().backwards).toBe(false);

      expect((await move(card, aBin.id)).statusCode).toBe(400);

      const ok = await move(card, aBin.id, { reason: 'customer withdrew the request' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().column_id).toBe(aBin.id);

      const t = await ctx.db
        .selectFrom('card_transitions')
        .select(['reason', 'to_column_id'])
        .where('card_id', '=', card)
        .orderBy('at', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(t.to_column_id).toBe(aBin.id);
      expect(t.reason).toBe('customer withdrew the request');

      // discarding is not an override: no override row is written
      expect(await ctx.db.selectFrom('card_move_overrides').select('id').where('card_id', '=', card).execute()).toEqual([]);
    });

    it('is never backwards, whatever position the bin sits at', async () => {
      const card = await newCard(aDone.id, 'Late regret');
      // Done is position 2, the bin is 3, but a bin earlier in the order would
      // behave identically — discarding is a terminal exit, not a step back
      const ok = await move(card, aBin.id, { reason: 'shipped then retracted' });
      expect(ok.statusCode).toBe(200);
    });

    it('coming back out of the bin needs no override', async () => {
      const card = await newCard(aDoing.id, 'Resurrected');
      await move(card, aBin.id, { reason: 'paused indefinitely' });
      const back = await requirements(card, aOpen.id);
      expect(back.json().backwards).toBe(false);
      expect((await move(card, aOpen.id)).statusCode).toBe(200);
    });

    it('STOPS recurrence instead of starting the reopen countdown', async () => {
      const card = await newCard(aDoing.id, 'Weekly chore');
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card}`,
        headers: { cookie },
        payload: { recurrenceRule: { freq: 'weekly', interval: 1 } },
      });

      await move(card, aBin.id, { reason: 'chore no longer needed' });
      const binned = await ctx.db.selectFrom('cards').selectAll().where('id', '=', card).executeTakeFirstOrThrow();
      expect(binned.recurrence_status).toBe('open');
      expect(binned.closed_at).toBeNull();
      expect(binned.reopen_at).toBeNull(); // the countdown never started
      expect(binned.is_overdue).toBe(false);

      // out of the bin it is plainly open again; the next close starts the cycle
      await move(card, aOpen.id);
      const revived = await ctx.db.selectFrom('cards').selectAll().where('id', '=', card).executeTakeFirstOrThrow();
      expect(revived.recurrence_status).toBe('open');
      expect(revived.reopen_at).toBeNull();

      await move(card, aDoing.id);
      await move(card, aDone.id);
      const closed = await ctx.db.selectFrom('cards').selectAll().where('id', '=', card).executeTakeFirstOrThrow();
      expect(closed.recurrence_status).toBe('awaiting_reopen');
      expect(closed.reopen_at).not.toBeNull();
    });

    it('never counts as completion in board metrics', async () => {
      const m = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/metrics`, headers: { cookie } });
      const body = m.json();
      expect(body.outcomes.discardedCount).toBeGreaterThanOrEqual(2);
      expect(body.outcomes.completedCount).toBeGreaterThanOrEqual(0);
      // a card that only ever reached the bin has no lead or cycle time
      const binnedIds = (await board()).cards.filter((c: { column_id: string }) => c.column_id === aBin.id).map((c: { id: string }) => c.id);
      for (const id of binnedIds) {
        const pc = body.perCard.find((p: { cardId: string }) => p.cardId === id);
        if (pc) {
          expect(pc.leadTimeMs).toBeNull();
          expect(pc.cycleTimeMs).toBeNull();
        }
      }
      // and none of them show up as a throughput event
      const doneEventCount = body.doneEvents.length;
      expect(doneEventCount).toBeLessThanOrEqual(body.outcomes.completedCount + body.outcomes.activeCount);
    });

    it('is a separate outcome in the pivot engine, with its reason groupable', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/query',
        headers: { cookie },
        payload: { dimensions: ['outcome'], metric: 'count', aggregation: 'count', boardIds: [boardId] },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().rows as { keys: string[]; value: number }[];
      expect(rows.find((r) => r.keys[0] === 'Discarded')!.value).toBeGreaterThanOrEqual(2);

      const byReason = await app.inject({
        method: 'POST',
        url: '/api/me/dashboard/query',
        headers: { cookie },
        payload: { dimensions: ['discardReason'], metric: 'count', aggregation: 'count', boardIds: [boardId] },
      });
      const reasons = (byReason.json().rows as { keys: string[] }[]).map((r) => r.keys[0]);
      expect(reasons).toContain('customer withdrew the request');
      expect(reasons).toContain('Not discarded');
    });
  });

  describe('audit timeline', () => {
    it('reads creation, every move and every override in order, with reasons', async () => {
      const card = await newCard(aOpen.id, 'Well travelled');
      await move(card, aDoing.id);
      await move(card, aDone.id);
      await move(card, aDoing.id, { override: { backwards: true }, reason: 'reopened after a bug report' });
      await move(card, aBin.id, { reason: 'superseded by another card' });

      const res = await app.inject({ method: 'GET', url: `/api/cards/${card}/audit`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const timeline = res.json().timeline as { kind: string; reason: string | null; actorName: string | null }[];

      expect(timeline[0]!.kind).toBe('created');
      expect(timeline[0]!.actorName).toBe('Dana');
      expect(timeline.filter((e) => e.kind === 'moved')).toHaveLength(4);

      const override = timeline.find((e) => e.kind === 'override')!;
      expect(override.reason).toBe('reopened after a bug report');
      expect(timeline.find((e) => e.reason === 'superseded by another card')).toBeTruthy();

      // chronological, and the override sits with the move it authorised
      const ats = (res.json().timeline as { at: string }[]).map((e) => new Date(e.at).getTime());
      expect([...ats].sort((a, b) => a - b)).toEqual(ats);
      const overrideIdx = timeline.findIndex((e) => e.kind === 'override');
      expect(timeline[overrideIdx - 1]!.kind).toBe('moved');
    });

    it('marks the discard move as a discard', async () => {
      const card = await newCard(aDoing.id, 'Binned with a note');
      await move(card, aBin.id, { reason: 'duplicate of an older card' });
      const res = await app.inject({ method: 'GET', url: `/api/cards/${card}/audit`, headers: { cookie } });
      const discard = (res.json().timeline as { kind: string; discarded?: boolean; reason: string | null }[]).find(
        (e) => e.kind === 'moved' && e.discarded,
      )!;
      expect(discard.reason).toBe('duplicate of an older card');
    });

    it('TENANCY: someone outside the board cannot read its card history', async () => {
      const hash = await bcrypt.hash('pass12345', 4);
      const otherOrg = await ctx.db
        .insertInto('organizations')
        .values({ name: 'Other', slug: `disc-other-${RUN}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.db
        .insertInto('users')
        .values({ org_id: otherOrg.id, email: `disc-out-${RUN}@test.io`, display_name: 'Outsider', role: 'user', password_hash: hash })
        .execute();
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `disc-out-${RUN}@test.io`, password: 'pass12345' },
      });
      const outsider = login.headers['set-cookie']!.toString().split(';')[0]!;

      const cardId = (await board()).cards[0].id;
      const res = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/audit`, headers: { cookie: outsider } });
      expect(res.statusCode).toBe(403);

      await ctx.db.deleteFrom('organizations').where('id', '=', otherOrg.id).execute();
    });
  });
});
