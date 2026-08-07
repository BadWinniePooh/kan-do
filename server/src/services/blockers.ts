/**
 * Blockers: a stated reason a card cannot progress right now.
 *
 * Strictly dependent on a card — every read and write is reached through the
 * card, so board access is the only permission involved and a blocker can never
 * outlive its parent (FK CASCADE). A card may accumulate many over its life;
 * the ones without an `ended_at` are active and hold the card in place.
 *
 * Comments are raw markdown, the same shape and lifecycle as card notes.
 */
import type { BlockerRef } from '@kan-do/shared';
import type { Actor } from '../domain/rbac.js';
import type { Db } from '../db/index.js';
import type { AppCtx } from './context.js';
import { badRequest, notFound } from './context.js';
import { assertBoardAccess } from './boards.js';

async function cardFor(ctx: AppCtx, actor: Actor, cardId: string, level: 'view' | 'edit') {
  const card = await ctx.db.selectFrom('cards').select(['id', 'board_id']).where('id', '=', cardId).executeTakeFirst();
  if (!card) throw notFound('card');
  await assertBoardAccess(ctx.db, actor, card.board_id, level);
  return card;
}

/** The blockers holding a card in place right now. */
export async function activeBlockers(db: Db, cardId: string): Promise<BlockerRef[]> {
  const rows = await db
    .selectFrom('card_blockers')
    .select(['id', 'reason', 'started_at'])
    .where('card_id', '=', cardId)
    .where('ended_at', 'is', null)
    .orderBy('started_at')
    .execute();
  return rows.map((r) => ({ id: r.id, reason: r.reason, startedAt: new Date(r.started_at).toISOString() }));
}

/** Active blockers for many cards at once — one query per board render. */
export async function activeBlockersByCard(db: Db, cardIds: string[]) {
  if (cardIds.length === 0) return [];
  return db
    .selectFrom('card_blockers')
    .select(['id', 'card_id', 'reason', 'started_at'])
    .where('card_id', 'in', cardIds)
    .where('ended_at', 'is', null)
    .orderBy('started_at')
    .execute();
}

export async function listBlockers(ctx: AppCtx, actor: Actor, cardId: string) {
  await cardFor(ctx, actor, cardId, 'view');
  const blockers = await ctx.db
    .selectFrom('card_blockers')
    .leftJoin('users as creator', 'creator.id', 'card_blockers.created_by')
    .leftJoin('users as resolver', 'resolver.id', 'card_blockers.resolved_by')
    .select([
      'card_blockers.id',
      'card_blockers.reason',
      'card_blockers.started_at',
      'card_blockers.ended_at',
      'creator.display_name as created_by_name',
      'resolver.display_name as resolved_by_name',
    ])
    .where('card_blockers.card_id', '=', cardId)
    .orderBy('card_blockers.started_at', 'desc')
    .execute();
  if (blockers.length === 0) return [];

  const comments = await ctx.db
    .selectFrom('card_blocker_comments')
    .leftJoin('users', 'users.id', 'card_blocker_comments.author_id')
    .select([
      'card_blocker_comments.id',
      'card_blocker_comments.blocker_id',
      'card_blocker_comments.markdown',
      'card_blocker_comments.created_at',
      'users.display_name as author_name',
    ])
    .where(
      'card_blocker_comments.blocker_id',
      'in',
      blockers.map((b) => b.id),
    )
    .orderBy('card_blocker_comments.created_at')
    .execute();

  return blockers.map((b) => ({ ...b, comments: comments.filter((c) => c.blocker_id === b.id) }));
}

export async function createBlocker(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  input: { reason: string; startedAt?: string },
) {
  const card = await cardFor(ctx, actor, cardId, 'edit');
  const blocker = await ctx.db
    .insertInto('card_blockers')
    .values({
      card_id: cardId,
      reason: input.reason,
      started_at: input.startedAt ? new Date(input.startedAt) : new Date(),
      created_by: actor.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return blocker;
}

export async function updateBlocker(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  blockerId: string,
  patch: { reason?: string; startedAt?: string; endedAt?: string | null },
) {
  const card = await cardFor(ctx, actor, cardId, 'edit');
  const existing = await ctx.db
    .selectFrom('card_blockers')
    .select(['id', 'started_at', 'ended_at'])
    .where('id', '=', blockerId)
    .where('card_id', '=', cardId)
    .executeTakeFirst();
  if (!existing) throw notFound('blocker');

  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.reason !== undefined) set.reason = patch.reason;
  if (patch.startedAt !== undefined) set.started_at = new Date(patch.startedAt);
  if (patch.endedAt !== undefined) {
    set.ended_at = patch.endedAt ? new Date(patch.endedAt) : null;
    // resolving stamps who did it; reopening clears that as well as the end
    set.resolved_by = patch.endedAt ? actor.userId : null;
  }

  const start = patch.startedAt ? new Date(patch.startedAt) : new Date(existing.started_at);
  const end = patch.endedAt !== undefined ? (patch.endedAt ? new Date(patch.endedAt) : null) : existing.ended_at;
  if (end && end < start) throw badRequest('a blocker cannot end before it started');

  const updated = await ctx.db
    .updateTable('card_blockers')
    .set(set)
    .where('id', '=', blockerId)
    .where('card_id', '=', cardId)
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return updated;
}

/** Resolve = stamp the end. The blocker stays on the card as history. */
export async function resolveBlocker(ctx: AppCtx, actor: Actor, cardId: string, blockerId: string) {
  return updateBlocker(ctx, actor, cardId, blockerId, { endedAt: new Date().toISOString() });
}

export async function deleteBlocker(ctx: AppCtx, actor: Actor, cardId: string, blockerId: string) {
  const card = await cardFor(ctx, actor, cardId, 'edit');
  await ctx.db.deleteFrom('card_blockers').where('id', '=', blockerId).where('card_id', '=', cardId).execute();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
}

async function assertBlockerOnCard(ctx: AppCtx, cardId: string, blockerId: string) {
  const row = await ctx.db
    .selectFrom('card_blockers')
    .select('id')
    .where('id', '=', blockerId)
    .where('card_id', '=', cardId)
    .executeTakeFirst();
  if (!row) throw notFound('blocker');
}

export async function addComment(ctx: AppCtx, actor: Actor, cardId: string, blockerId: string, markdown: string) {
  const card = await cardFor(ctx, actor, cardId, 'edit');
  await assertBlockerOnCard(ctx, cardId, blockerId);
  const comment = await ctx.db
    .insertInto('card_blocker_comments')
    .values({ blocker_id: blockerId, author_id: actor.userId, markdown })
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return comment;
}

export async function updateComment(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  blockerId: string,
  commentId: string,
  markdown: string,
) {
  const card = await cardFor(ctx, actor, cardId, 'edit');
  await assertBlockerOnCard(ctx, cardId, blockerId);
  const comment = await ctx.db
    .updateTable('card_blocker_comments')
    .set({ markdown, updated_at: new Date() })
    .where('id', '=', commentId)
    .where('blocker_id', '=', blockerId)
    .returningAll()
    .executeTakeFirst();
  if (!comment) throw notFound('comment');
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return comment;
}

export async function deleteComment(ctx: AppCtx, actor: Actor, cardId: string, blockerId: string, commentId: string) {
  const card = await cardFor(ctx, actor, cardId, 'edit');
  await assertBlockerOnCard(ctx, cardId, blockerId);
  await ctx.db.deleteFrom('card_blocker_comments').where('id', '=', commentId).where('blocker_id', '=', blockerId).execute();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
}
