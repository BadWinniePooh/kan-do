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
import { assertBoardAccess } from './boards.js';
import { blockedDetails, evaluateMove, requiresReason, type GuardColumn } from '../domain/moveGuard.js';
import { checkedPolicyIds, movePolicies, saveProgress } from './policies.js';
import { activeBlockers } from './blockers.js';
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
    .select(['id', 'board_id', 'lane_id'])
    .where('id', '=', input.columnId)
    .executeTakeFirst();
  if (!column || column.board_id !== input.boardId) throw badRequest('column does not belong to board');

  // columns are lane-scoped, so the chosen column decides the lane; an
  // explicitly requested lane only ever confirms it
  if (input.laneId != null && input.laneId !== column.lane_id) {
    throw badRequest('column belongs to a different lane than the one requested');
  }
  const laneId = column.lane_id;

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
  // no laneId: changing lane is a MOVE (it needs a target column in that lane
  // and it is blocked by default), so it goes through moveCard, never a patch
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
 * Runs the policy, direction and lane gates for a user-initiated move.
 *
 * Order matters: the checklist ticks are persisted BEFORE the decision, so a
 * refused move still leaves the user's partial progress on the card. Throws 409
 * with the checklist attached when the move must not proceed, and 400 when an
 * override or a discard arrives without the justification it owes.
 */
async function guardMove(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  fromCol: GuardColumn,
  toCol: GuardColumn,
  opts: MoveOptions,
) {
  const [{ leavePolicies, enterPolicies }, blockers] = await Promise.all([
    movePolicies(ctx.db, fromCol.id, toCol.id),
    activeBlockers(ctx.db, cardId),
  ]);
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
    activeBlockers: blockers,
    override: {
      policies: opts.override?.policies,
      backwards: opts.override?.backwards,
      lane: opts.override?.lane,
      blockers: opts.override?.blockers,
    },
  });

  if (result.blocked) {
    const why: string[] = [];
    if (result.unmet.length && !opts.override?.policies) why.push('unmet column policies');
    if (result.backwards && !opts.override?.backwards) why.push('cards cannot move to an earlier column in their lane');
    if (result.laneMove && !opts.override?.lane) why.push('cards are not meant to move between lanes');
    if (result.activeBlockers.length && !opts.override?.blockers) {
      why.push(`${result.activeBlockers.length} unresolved blocker(s) on the card`);
    }
    throw conflict(
      `move blocked: ${why.join('; ')}`,
      blockedDetails(result, checkedIds.filter((id) => applicable.some((p) => p.id === id))),
    );
  }

  // a bypassed rule or a thrown-away card without a stated reason is exactly
  // the record that turns out to be useless later
  if (requiresReason(result) && !opts.reason?.trim()) {
    throw badRequest(
      result.overrideUsed
        ? 'overriding a move requires a reason'
        : 'discarding a card requires a reason',
    );
  }
  return { ...result, applicable };
}

export interface MoveOptions {
  /** must match the target column's lane when given; the column decides the lane */
  laneId?: string | null;
  position?: number;
  /** complete checklist state for this attempt; persisted even if the move is refused */
  acknowledgedPolicyIds?: string[];
  /** justification — mandatory for overrides and for discards */
  reason?: string;
  /** deliberate bypasses — each one recorded in card_move_overrides */
  override?: { policies?: boolean; backwards?: boolean; lane?: boolean; blockers?: boolean };
}

/**
 * Move a card to another column. The target column determines the target lane,
 * because columns are lane-scoped.
 *
 * Gated by the move guard (domain/moveGuard.ts): policies must be ticked, a card
 * may not move to an earlier column in its own lane, and it may not change lane.
 * Each gate takes an explicit, separately-confirmed override, which is audited
 * with the reason the user typed. System moves (actor null) bypass the guard —
 * the scheduler reopening a recurring card is not a user decision.
 *
 * Recurrence hooks:
 *  - into a done column    -> onClosed: schedule the reopen
 *  - out of done to open   -> onReopened (manual reopen): arm overdue deadline
 *  - into a discard column -> the recurrence clock STOPS. Discarding is not
 *    completing, so it must not start the "reopen after the interval" countdown
 *    that done triggers; the card goes dormant and normal behaviour resumes if
 *    it is ever moved back out.
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

  const cols = ['id', 'semantic', 'position', 'lane_id', 'board_id'] as const;
  const [fromCol, toCol] = await Promise.all([
    db.selectFrom('board_columns').select(cols).where('id', '=', card.column_id).executeTakeFirstOrThrow(),
    db.selectFrom('board_columns').select(cols).where('id', '=', toColumnId).executeTakeFirst(),
  ]);
  if (!toCol || toCol.board_id !== card.board_id) throw badRequest("target column does not belong to the card's board");
  if (opts.laneId != null && opts.laneId !== toCol.lane_id) {
    throw badRequest('target column belongs to a different lane than the one requested');
  }

  const guardCol = (c: typeof toCol): GuardColumn => ({
    id: c.id,
    laneId: c.lane_id,
    position: c.position,
    semantic: c.semantic,
  });
  const guard = actor ? await guardMove(ctx, actor, card.id, guardCol(fromCol), guardCol(toCol), opts) : null;

  const now = new Date();
  const reason = opts.reason?.trim() || null;
  const set: Record<string, unknown> = {
    column_id: toColumnId,
    // the column carries its lane with it — a card is never in a column of a
    // lane it does not belong to
    lane_id: toCol.lane_id,
    updated_at: now,
  };
  if (opts.position !== undefined) set.position = opts.position;

  let reopenToSchedule: Date | null = null;
  let overdueToSchedule: Date | null = null;

  const rule = card.recurrence_rule as RecurrenceRule | null;
  const discarding = toCol.semantic === 'discard';
  const closing = !discarding && toCol.semantic === 'done' && fromCol.semantic !== 'done';
  const reopening = !discarding && fromCol.semantic === 'done' && toCol.semantic !== 'done';

  if (discarding) {
    // dormant: no closed_at, so nothing to count an interval from, and any
    // armed overdue deadline is disarmed. A queued reopen job re-checks state
    // and no-ops. Moving the card back out leaves it plainly open again.
    Object.assign(set, {
      recurrence_status: 'open',
      closed_at: null,
      reopen_at: null,
      reopened_at: null,
      overdue_at: null,
      is_overdue: false,
    });
  } else if (rule && closing) {
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
        .values({
          card_id: cardId,
          from_column_id: fromCol.id,
          to_column_id: toColumnId,
          actor_id: actor?.userId ?? null,
          reason,
          at: now,
        })
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
          from_lane_id: fromCol.lane_id,
          to_lane_id: toCol.lane_id,
          actor_id: actor?.userId ?? null,
          backwards: guard.backwards,
          lane_move: guard.laneMove,
          blocked: guard.bypassedBlockers.length > 0,
          blockers: JSON.stringify(
            guard.bypassedBlockers.map((b) => ({ blockerId: b.id, reason: b.reason, startedAt: b.startedAt })),
          ),
          skipped_policies: JSON.stringify(
            guard.skipped.map((p) => ({ policyId: p.id, kind: p.kind, label: p.label, columnId: p.columnId, columnName: p.columnName })),
          ),
          reason,
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

/**
 * Full card history for the audit view, as one chronological timeline.
 *
 * Built entirely from records that already exist — card_transitions (the same
 * history the cycle/lead/waiting metrics are computed from) and
 * card_move_overrides — so there is no second, divergent history to maintain.
 * Creation is the transition with no source column.
 *
 * Access is the board's own view permission; the audit adds no new tier.
 */
export async function getCardAudit(ctx: AppCtx, actor: Actor, cardId: string) {
  const card = await ctx.db
    .selectFrom('cards')
    .select(['id', 'board_id', 'title', 'created_at'])
    .where('id', '=', cardId)
    .executeTakeFirst();
  if (!card) throw notFound('card');
  await assertBoardAccess(ctx.db, actor, card.board_id, 'view');

  const [transitions, overrides, columns, lanes, blockers] = await Promise.all([
    ctx.db
      .selectFrom('card_transitions')
      .leftJoin('users', 'users.id', 'card_transitions.actor_id')
      .select([
        'card_transitions.id',
        'card_transitions.from_column_id',
        'card_transitions.to_column_id',
        'card_transitions.reason',
        'card_transitions.at',
        'users.display_name as actor_name',
      ])
      .where('card_transitions.card_id', '=', cardId)
      .orderBy('card_transitions.at')
      .orderBy('card_transitions.id')
      .execute(),
    ctx.db
      .selectFrom('card_move_overrides')
      .leftJoin('users', 'users.id', 'card_move_overrides.actor_id')
      .select([
        'card_move_overrides.id',
        'card_move_overrides.from_column_id',
        'card_move_overrides.to_column_id',
        'card_move_overrides.backwards',
        'card_move_overrides.lane_move',
        'card_move_overrides.blocked',
        'card_move_overrides.blockers',
        'card_move_overrides.skipped_policies',
        'card_move_overrides.reason',
        'card_move_overrides.at',
        'users.display_name as actor_name',
      ])
      .where('card_move_overrides.card_id', '=', cardId)
      .orderBy('card_move_overrides.at')
      .execute(),
    // history can name columns and lanes that were since deleted — resolve what
    // still exists and fall back to a placeholder rather than dropping the entry
    ctx.db
      .selectFrom('board_columns')
      .select(['id', 'name', 'lane_id', 'semantic'])
      .where('board_id', '=', card.board_id)
      .execute(),
    ctx.db.selectFrom('lanes').select(['id', 'name']).where('board_id', '=', card.board_id).execute(),
    ctx.db
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
      .execute(),
  ]);

  const laneName = new Map(lanes.map((l) => [l.id, l.name]));
  const colInfo = new Map(columns.map((c) => [c.id, c]));
  const describe = (id: string | null) => {
    if (!id) return null;
    const c = colInfo.get(id);
    if (!c) return { id, name: 'a deleted column', laneName: null, semantic: null };
    return { id, name: c.name, laneName: laneName.get(c.lane_id) ?? null, semantic: c.semantic };
  };

  type Entry =
    | { kind: 'created'; at: Date; actorName: string | null; column: ReturnType<typeof describe> }
    | {
        kind: 'moved';
        at: Date;
        actorName: string | null;
        from: ReturnType<typeof describe>;
        to: ReturnType<typeof describe>;
        laneChanged: boolean;
        discarded: boolean;
        reason: string | null;
      }
    | {
        kind: 'override';
        at: Date;
        actorName: string | null;
        from: ReturnType<typeof describe>;
        to: ReturnType<typeof describe>;
        backwards: boolean;
        laneMove: boolean;
        skipped: { label: string; kind: string; columnName?: string }[];
        bypassedBlockers: { reason: string }[];
        reason: string | null;
      }
    | { kind: 'blocked'; at: Date; actorName: string | null; blockerId: string; reason: string }
    | { kind: 'unblocked'; at: Date; actorName: string | null; blockerId: string; reason: string };

  const entries: { rank: number; entry: Entry }[] = [];
  for (const t of transitions) {
    const to = describe(t.to_column_id);
    if (!t.from_column_id) {
      entries.push({ rank: 0, entry: { kind: 'created', at: t.at, actorName: t.actor_name, column: to } });
      continue;
    }
    const from = describe(t.from_column_id);
    entries.push({
      rank: 1,
      entry: {
        kind: 'moved',
        at: t.at,
        actorName: t.actor_name,
        from,
        to,
        laneChanged: Boolean(from && to && from.laneName !== to.laneName),
        discarded: to?.semantic === 'discard',
        reason: t.reason,
      },
    });
  }
  for (const o of overrides) {
    entries.push({
      rank: 2, // right after the move it authorised, when both share a timestamp
      entry: {
        kind: 'override',
        at: o.at,
        actorName: o.actor_name,
        from: describe(o.from_column_id),
        to: describe(o.to_column_id),
        backwards: o.backwards,
        laneMove: o.lane_move,
        skipped: Array.isArray(o.skipped_policies) ? (o.skipped_policies as { label: string; kind: string }[]) : [],
        bypassedBlockers: Array.isArray(o.blockers) ? (o.blockers as { reason: string }[]) : [],
        reason: o.reason,
      },
    });
  }

  // a blocker is two moments in the card's life, not one row
  for (const b of blockers) {
    entries.push({
      rank: 0,
      entry: { kind: 'blocked', at: b.started_at, actorName: b.created_by_name, blockerId: b.id, reason: b.reason },
    });
    if (b.ended_at) {
      entries.push({
        rank: 0,
        entry: { kind: 'unblocked', at: b.ended_at, actorName: b.resolved_by_name, blockerId: b.id, reason: b.reason },
      });
    }
  }

  entries.sort((a, b) => a.entry.at.getTime() - b.entry.at.getTime() || a.rank - b.rank);
  return { card: { id: card.id, title: card.title, createdAt: card.created_at }, timeline: entries.map((e) => e.entry) };
}
