/**
 * Card service: CRUD, moves, ownership, notes. Moves drive the recurrence
 * state machine (domain/recurrence.ts) and record transitions for metrics.
 * All multi-step writes are transactional — a move either fully lands
 * (column + transition + recurrence state) or not at all.
 */
import type { Actor } from '../domain/rbac.js';
import { canEditCards } from '../domain/rbac.js';
import * as rec from '../domain/recurrence.js';
import type { RecurrenceRule } from '@kan-do/shared';
import type { AppCtx } from './context.js';
import { badRequest, conflict, forbidden, notFound } from './context.js';
import { assertBoardAccess, firstLaneId } from './boards.js';
import { blockedDetails, evaluateMove } from '../domain/moveGuard.js';
import { checkedPolicyIds, movePolicies, saveProgress } from './policies.js';
import { scheduleOverdueCheck, scheduleReopen } from '../jobs/queue.js';

async function assertCardEdit(ctx: AppCtx, actor: Actor, cardId: string) {
  const card = await ctx.db.selectFrom('cards').selectAll().where('id', '=', cardId).executeTakeFirst();
  if (!card) throw notFound('card');
  const board = await ctx.db
    .selectFrom('boards')
    .select(['id', 'org_id'])
    .where('id', '=', card.board_id)
    .executeTakeFirstOrThrow();
  const members = await ctx.db.selectFrom('board_members').select('user_id').where('board_id', '=', board.id).execute();
  if (!canEditCards(actor, { orgId: board.org_id, memberIds: members.map((m) => m.user_id) })) throw forbidden();
  return card;
}

export interface CardCreateInput {
  boardId: string;
  columnId: string;
  laneId?: string | null;
  title: string;
  description?: string;
  position?: number;
}

export async function createCard(ctx: AppCtx, actor: Actor, input: CardCreateInput) {
  await assertBoardAccess(ctx.db, actor, input.boardId, 'edit');
  const column = await ctx.db
    .selectFrom('board_columns')
    .select(['id', 'board_id'])
    .where('id', '=', input.columnId)
    .executeTakeFirst();
  if (!column || column.board_id !== input.boardId) throw badRequest('column does not belong to board');

  // lane invariant: on a board with lanes, a new card always lands in one
  const laneId = input.laneId ?? (await firstLaneId(ctx.db, input.boardId));

  const card = await ctx.db.transaction().execute(async (trx) => {
    const c = await trx
      .insertInto('cards')
      .values({
        board_id: input.boardId,
        column_id: input.columnId,
        lane_id: laneId,
        title: input.title,
        description: input.description ?? null,
        position: input.position ?? Date.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('card_transitions')
      .values({ card_id: c.id, from_column_id: null, to_column_id: input.columnId, actor_id: actor.userId })
      .execute();
    return c;
  });
  ctx.realtime.emitToBoard(input.boardId, { type: 'card.created', cardId: card.id });
  return card;
}

export interface CardPatch {
  title?: string;
  description?: string | null;
  laneId?: string | null;
  categoryId?: string | null;
  dueDate?: string | null;
  recurrenceRule?: RecurrenceRule | null;
  coverAttachmentId?: string | null;
}

export async function updateCard(ctx: AppCtx, actor: Actor, cardId: string, patch: CardPatch) {
  const card = await assertCardEdit(ctx, actor, cardId);

  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.laneId !== undefined) {
    // never allow a card to go lane-less while the board has lanes
    set.lane_id = patch.laneId ?? (await firstLaneId(ctx.db, card.board_id));
  }
  if (patch.categoryId !== undefined) {
    if (patch.categoryId !== null) {
      // tenancy: category must belong to the board's org
      const board = await ctx.db.selectFrom('boards').select('org_id').where('id', '=', card.board_id).executeTakeFirstOrThrow();
      const cat = await ctx.db
        .selectFrom('categories')
        .select('id')
        .where('id', '=', patch.categoryId)
        .where('org_id', '=', board.org_id)
        .executeTakeFirst();
      if (!cat) throw badRequest('category does not belong to this organization');
    }
    set.category_id = patch.categoryId;
  }
  if (patch.coverAttachmentId !== undefined) set.cover_attachment_id = patch.coverAttachmentId;
  if (patch.dueDate !== undefined) {
    set.due_date = patch.dueDate ? new Date(patch.dueDate) : null;
    if (!patch.dueDate) set.is_overdue = false;
  }
  if (patch.recurrenceRule !== undefined) {
    set.recurrence_rule = patch.recurrenceRule ? JSON.stringify(patch.recurrenceRule) : null;
    if (patch.recurrenceRule === null) {
      // dropping recurrence resets the state machine
      Object.assign(set, {
        recurrence_status: 'open',
        closed_at: null,
        reopen_at: null,
        reopened_at: null,
        overdue_at: null,
        is_overdue: false,
      });
    }
  }

  const updated = await ctx.db
    .updateTable('cards')
    .set(set)
    .where('id', '=', cardId)
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return updated;
}

/**
 * Runs the policy + direction gates for a user-initiated move.
 *
 * Order matters: the checklist ticks are persisted BEFORE the decision, so a
 * refused move still leaves the user's partial progress on the card. Throws 409
 * with the checklist attached when the move must not proceed.
 */
async function guardMove(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  fromCol: { id: string; position: number },
  toCol: { id: string; position: number },
  opts: MoveOptions,
) {
  const { leavePolicies, enterPolicies } = await movePolicies(ctx.db, fromCol.id, toCol.id);
  const applicable = [...leavePolicies, ...enterPolicies];

  if (fromCol.id !== toCol.id && applicable.length) {
    await saveProgress(ctx.db, cardId, actor.userId, applicable, opts.acknowledgedPolicyIds ?? []);
  }
  const checkedIds = applicable.length ? await checkedPolicyIds(ctx.db, cardId) : [];

  const result = evaluateMove({
    fromColumn: fromCol,
    toColumn: toCol,
    leavePolicies,
    enterPolicies,
    checkedIds,
    override: { policies: opts.override?.policies, backwards: opts.override?.backwards },
  });

  if (result.blocked) {
    const why = result.unmet.length && result.backwards
      ? 'move blocked: unmet column policies and backwards move'
      : result.unmet.length
        ? 'move blocked by unmet column policies'
        : 'move blocked: cards cannot move backwards on this board';
    throw conflict(why, blockedDetails(result, checkedIds.filter((id) => applicable.some((p) => p.id === id))));
  }
  return { ...result, applicable };
}

export interface MoveOptions {
  laneId?: string | null;
  position?: number;
  /** complete checklist state for this attempt; persisted even if the move is refused */
  acknowledgedPolicyIds?: string[];
  /** deliberate bypasses — each one recorded in card_move_overrides */
  override?: { policies?: boolean; backwards?: boolean; reason?: string };
}

/**
 * Move a card to another column (and/or lane/position).
 *
 * Gated by the move guard (domain/moveGuard.ts): the source column's "before
 * leaving" policies and the target column's "before entering" policies must all
 * be ticked, and a card may not move to an earlier column. Both gates take an
 * explicit override, which is audited. System moves (actor null) bypass the
 * guard — the scheduler reopening a recurring card is not a user decision.
 *
 * Recurrence hooks:
 *  - into a done column  -> onClosed: schedule reopen
 *  - out of done to open -> onReopened (manual reopen): arm overdue deadline
 */
export async function moveCard(
  ctx: AppCtx,
  actor: Actor | null, // null = system (scheduler reopen)
  cardId: string,
  toColumnId: string,
  opts: MoveOptions = {},
) {
  const db = ctx.db;
  const card = actor
    ? await assertCardEdit(ctx, actor, cardId)
    : await db.selectFrom('cards').selectAll().where('id', '=', cardId).executeTakeFirstOrThrow();

  const [fromCol, toCol] = await Promise.all([
    db.selectFrom('board_columns').select(['id', 'semantic', 'position']).where('id', '=', card.column_id).executeTakeFirstOrThrow(),
    db.selectFrom('board_columns').select(['id', 'semantic', 'board_id', 'position']).where('id', '=', toColumnId).executeTakeFirst(),
  ]);
  if (!toCol || toCol.board_id !== card.board_id) throw badRequest('target column does not belong to the card\'s board');

  const guard = actor ? await guardMove(ctx, actor, card.id, fromCol, toCol, opts) : null;

  const now = new Date();
  const set: Record<string, unknown> = {
    column_id: toColumnId,
    updated_at: now,
  };
  if (opts.laneId !== undefined) {
    set.lane_id = opts.laneId ?? (await firstLaneId(db, card.board_id));
  }
  if (opts.position !== undefined) set.position = opts.position;

  let reopenToSchedule: Date | null = null;
  let overdueToSchedule: Date | null = null;

  const rule = card.recurrence_rule as RecurrenceRule | null;
  const closing = toCol.semantic === 'done' && fromCol.semantic !== 'done';
  const reopening = fromCol.semantic === 'done' && toCol.semantic !== 'done';

  if (rule && closing) {
    const s = rec.onClosed(rule, now);
    Object.assign(set, {
      recurrence_status: s.status,
      closed_at: s.closedAt,
      reopen_at: s.reopenAt,
      reopened_at: null,
      overdue_at: null,
      is_overdue: false,
    });
    reopenToSchedule = s.reopenAt;
  } else if (rule && reopening) {
    const s = rec.onReopened(rule, now);
    Object.assign(set, {
      recurrence_status: s.status,
      closed_at: null,
      reopen_at: null,
      reopened_at: s.reopenedAt,
      overdue_at: s.overdueAt,
      is_overdue: false,
    });
    overdueToSchedule = s.overdueAt;
  } else if (!rule && toCol.semantic === 'done') {
    set.is_overdue = false; // plain card done -> clear overdue highlight
  }

  const updated = await db.transaction().execute(async (trx) => {
    const u = await trx.updateTable('cards').set(set).where('id', '=', cardId).returningAll().executeTakeFirstOrThrow();
    if (fromCol.id !== toColumnId) {
      await trx
        .insertInto('card_transitions')
        .values({ card_id: cardId, from_column_id: fromCol.id, to_column_id: toColumnId, actor_id: actor?.userId ?? null, at: now })
        .execute();
    }
    if (guard?.overrideUsed) {
      // labels are copied in: the audit must stay readable after the policy or
      // its column is deleted
      await trx
        .insertInto('card_move_overrides')
        .values({
          card_id: cardId,
          board_id: card.board_id,
          from_column_id: fromCol.id,
          to_column_id: toColumnId,
          actor_id: actor?.userId ?? null,
          backwards: guard.backwards,
          skipped_policies: JSON.stringify(
            guard.skipped.map((p) => ({ policyId: p.id, kind: p.kind, label: p.label, columnId: p.columnId, columnName: p.columnName })),
          ),
          reason: opts.override?.reason?.trim() || null,
          at: now,
        })
        .execute();
    }
    if (guard?.applicable.length) {
      // the checklist belonged to THIS move; a later move re-asks from scratch
      await trx
        .deleteFrom('card_policy_progress')
        .where('card_id', '=', cardId)
        .where('policy_id', 'in', guard.applicable.map((p) => p.id))
        .execute();
    }
    return u;
  });

  // scheduled AFTER the commit; singleton keys make retries idempotent
  if (reopenToSchedule) await scheduleReopen(ctx.boss, cardId, reopenToSchedule);
  if (overdueToSchedule) await scheduleOverdueCheck(ctx.boss, cardId, overdueToSchedule);

  ctx.realtime.emitToBoard(card.board_id, { type: 'card.moved', cardId });
  return updated;
}

export async function deleteCard(ctx: AppCtx, actor: Actor, cardId: string) {
  const card = await assertCardEdit(ctx, actor, cardId);
  await ctx.db.deleteFrom('cards').where('id', '=', cardId).execute();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.deleted', cardId });
}

export async function setOwners(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  owners: { kind: 'user' | 'external'; id: string }[],
) {
  const card = await assertCardEdit(ctx, actor, cardId);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom('card_owners').where('card_id', '=', cardId).execute();
    if (owners.length) {
      await trx
        .insertInto('card_owners')
        .values(
          owners.map((o) => ({
            card_id: cardId,
            kind: o.kind,
            user_id: o.kind === 'user' ? o.id : null,
            external_owner_id: o.kind === 'external' ? o.id : null,
          })),
        )
        .execute();
    }
  });
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
}

export async function getCardDetail(ctx: AppCtx, actor: Actor, cardId: string) {
  const card = await ctx.db.selectFrom('cards').selectAll().where('id', '=', cardId).executeTakeFirst();
  if (!card) throw notFound('card');
  await assertBoardAccess(ctx.db, actor, card.board_id, 'view');
  const [notes, attachments, owners, transitions] = await Promise.all([
    ctx.db.selectFrom('notes').selectAll().where('card_id', '=', cardId).orderBy('position').orderBy('created_at').execute(),
    ctx.db.selectFrom('attachments').selectAll().where('card_id', '=', cardId).orderBy('created_at').execute(),
    ctx.db
      .selectFrom('card_owners')
      .leftJoin('users', 'users.id', 'card_owners.user_id')
      .leftJoin('external_owners', 'external_owners.id', 'card_owners.external_owner_id')
      .select([
        'card_owners.kind',
        'card_owners.user_id',
        'card_owners.external_owner_id',
        'users.display_name as user_name',
        'users.avatar_key as user_avatar',
        'external_owners.display_name as external_name',
      ])
      .where('card_owners.card_id', '=', cardId)
      .execute(),
    ctx.db.selectFrom('card_transitions').selectAll().where('card_id', '=', cardId).orderBy('at').execute(),
  ]);
  const withUrls = await Promise.all(
    attachments.map(async (a) => ({ ...a, url: await ctx.storage.presignDownload(a.object_key) })),
  );
  const ownersWithUrls = await Promise.all(
    owners.map(async (o) => ({
      ...o,
      user_avatar: o.user_avatar ? await ctx.storage.presignDownload(o.user_avatar) : null,
    })),
  );
  return { card, notes, attachments: withUrls, owners: ownersWithUrls, transitions };
}

export async function addNote(ctx: AppCtx, actor: Actor, cardId: string, markdown: string) {
  const card = await assertCardEdit(ctx, actor, cardId);
  const note = await ctx.db
    .insertInto('notes')
    .values({ card_id: cardId, author_id: actor.userId, markdown })
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return note;
}

export async function updateNote(ctx: AppCtx, actor: Actor, cardId: string, noteId: string, markdown: string) {
  const card = await assertCardEdit(ctx, actor, cardId);
  const note = await ctx.db
    .updateTable('notes')
    .set({ markdown, updated_at: new Date() })
    .where('id', '=', noteId)
    .where('card_id', '=', cardId)
    .returningAll()
    .executeTakeFirst();
  if (!note) throw notFound('note');
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
  return note;
}

export async function deleteNote(ctx: AppCtx, actor: Actor, cardId: string, noteId: string) {
  const card = await assertCardEdit(ctx, actor, cardId);
  await ctx.db.deleteFrom('notes').where('id', '=', noteId).where('card_id', '=', cardId).execute();
  ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
}
