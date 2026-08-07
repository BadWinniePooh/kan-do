/**
 * Column policies: per-column checklists that gate card movement, the partial
 * tick state a card carries between attempts, and the override audit trail.
 *
 * Every read/write goes through assertBoardAccess, so policies, progress and
 * override history are only ever reachable for boards the actor can see;
 * configuring them needs the same 'edit' level as editing columns themselves.
 */
import type { PolicyKind, PolicyRef } from '@kan-do/shared';
import type { Actor } from '../domain/rbac.js';
import type { Db } from '../db/index.js';
import type { AppCtx } from './context.js';
import { badRequest } from './context.js';
import { assertBoardAccess } from './boards.js';

export interface PolicyInput {
  id?: string;
  kind: PolicyKind;
  label: string;
  position: number;
}

/** Every policy on a board, ordered for display (column order, then position). */
export async function listBoardPolicies(ctx: AppCtx, actor: Actor, boardId: string) {
  await assertBoardAccess(ctx.db, actor, boardId, 'view');
  return ctx.db
    .selectFrom('column_policies')
    .innerJoin('board_columns', 'board_columns.id', 'column_policies.column_id')
    .select([
      'column_policies.id',
      'column_policies.column_id',
      'column_policies.kind',
      'column_policies.label',
      'column_policies.position',
    ])
    .where('board_columns.board_id', '=', boardId)
    .orderBy('board_columns.position')
    .orderBy('column_policies.kind')
    .orderBy('column_policies.position')
    .execute();
}

/**
 * Replace-style save for one column's policies — the same shape used for
 * columns and lanes, so create / rename / delete / reorder all arrive as one
 * atomic list from the column settings dialog.
 */
export async function saveColumnPolicies(
  ctx: AppCtx,
  actor: Actor,
  boardId: string,
  columnId: string,
  policies: PolicyInput[],
) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  const column = await ctx.db
    .selectFrom('board_columns')
    .select(['id', 'board_id'])
    .where('id', '=', columnId)
    .executeTakeFirst();
  if (!column || column.board_id !== boardId) throw badRequest('column does not belong to board');

  const result = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('column_policies').select('id').where('column_id', '=', columnId).execute();
    const keep = new Set(policies.filter((p) => p.id).map((p) => p.id!));
    const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    // dropping a policy drops its half-done ticks too (FK cascade); the
    // override audit keeps its own denormalised copy, so history survives
    if (toDelete.length) await trx.deleteFrom('column_policies').where('id', 'in', toDelete).execute();

    const out = [];
    for (const p of [...policies].sort((a, b) => a.position - b.position)) {
      out.push(
        p.id
          ? await trx
              .updateTable('column_policies')
              .set({ kind: p.kind, label: p.label, position: p.position, updated_at: new Date() })
              .where('id', '=', p.id)
              .where('column_id', '=', columnId)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('column_policies')
              .values({ column_id: columnId, kind: p.kind, label: p.label, position: p.position })
              .returningAll()
              .executeTakeFirstOrThrow(),
      );
    }
    return out;
  });
  ctx.realtime.emitToBoard(boardId, { type: 'column.changed' });
  return result;
}

/** Policies of one kind on one column, as move-guard refs. */
async function policyRefs(db: Db, columnId: string, kind: PolicyKind): Promise<PolicyRef[]> {
  const rows = await db
    .selectFrom('column_policies')
    .innerJoin('board_columns', 'board_columns.id', 'column_policies.column_id')
    .select(['column_policies.id', 'column_policies.kind', 'column_policies.label', 'column_policies.column_id', 'board_columns.name'])
    .where('column_policies.column_id', '=', columnId)
    .where('column_policies.kind', '=', kind)
    .orderBy('column_policies.position')
    .execute();
  return rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, columnId: r.column_id, columnName: r.name }));
}

/** What the card must satisfy to leave `fromColumnId` and enter `toColumnId`. */
export async function movePolicies(db: Db, fromColumnId: string, toColumnId: string) {
  const [leavePolicies, enterPolicies] = await Promise.all([
    policyRefs(db, fromColumnId, 'leave'),
    policyRefs(db, toColumnId, 'enter'),
  ]);
  return { leavePolicies, enterPolicies };
}

/** Policy ids already ticked on a card. */
export async function checkedPolicyIds(db: Db, cardId: string): Promise<string[]> {
  const rows = await db.selectFrom('card_policy_progress').select('policy_id').where('card_id', '=', cardId).execute();
  return rows.map((r) => r.policy_id);
}

/**
 * Persist checklist ticks on the card. Called on every move attempt — including
 * the ones that get rejected — so partial progress is never re-entered.
 * `policyIds` is the complete tick state for `applicable`: anything applicable
 * and absent is treated as unticked and cleared.
 */
export async function saveProgress(
  db: Db,
  cardId: string,
  actorId: string,
  applicable: readonly PolicyRef[],
  policyIds: readonly string[],
) {
  const applicableIds = new Set(applicable.map((p) => p.id));
  const ticked = [...new Set(policyIds)].filter((id) => applicableIds.has(id));
  const untick = [...applicableIds].filter((id) => !ticked.includes(id));

  await db.transaction().execute(async (trx) => {
    if (untick.length) {
      await trx.deleteFrom('card_policy_progress').where('card_id', '=', cardId).where('policy_id', 'in', untick).execute();
    }
    if (ticked.length) {
      await trx
        .insertInto('card_policy_progress')
        .values(ticked.map((policy_id) => ({ card_id: cardId, policy_id, checked_by: actorId })))
        .onConflict((oc) => oc.columns(['card_id', 'policy_id']).doNothing())
        .execute();
    }
  });
}

/**
 * Everything the UI needs to render the move checklist before attempting the
 * move: which policies apply, which are already ticked, and whether the move
 * runs backwards through the board's column order.
 */
export async function getMoveRequirements(ctx: AppCtx, actor: Actor, cardId: string, toColumnId: string) {
  const card = await ctx.db.selectFrom('cards').select(['id', 'board_id', 'column_id']).where('id', '=', cardId).executeTakeFirst();
  if (!card) throw badRequest('card not found');
  await assertBoardAccess(ctx.db, actor, card.board_id, 'view');

  const [fromCol, toCol] = await Promise.all([
    ctx.db.selectFrom('board_columns').select(['id', 'name', 'position']).where('id', '=', card.column_id).executeTakeFirst(),
    ctx.db.selectFrom('board_columns').select(['id', 'name', 'position', 'board_id']).where('id', '=', toColumnId).executeTakeFirst(),
  ]);
  if (!toCol || toCol.board_id !== card.board_id) throw badRequest("target column does not belong to the card's board");
  const target = { id: toCol.id, name: toCol.name, position: toCol.position };
  // same-column reorder: nothing to satisfy
  if (!fromCol || fromCol.id === toCol.id) {
    return { backwards: false, applicable: [], checkedIds: [], fromColumn: fromCol ?? null, toColumn: target };
  }

  const { leavePolicies, enterPolicies } = await movePolicies(ctx.db, fromCol.id, toCol.id);
  const applicable = [...leavePolicies, ...enterPolicies];
  const checkedIds = (await checkedPolicyIds(ctx.db, cardId)).filter((id) => applicable.some((p) => p.id === id));
  return {
    backwards: toCol.position < fromCol.position,
    applicable,
    checkedIds,
    fromColumn: { id: fromCol.id, name: fromCol.name, position: fromCol.position },
    toColumn: target,
  };
}

/**
 * Persist checklist ticks without attempting the move, so a user who has only
 * done half the list can close the dialog and keep the progress.
 */
export async function saveMoveProgress(
  ctx: AppCtx,
  actor: Actor,
  cardId: string,
  toColumnId: string,
  acknowledgedPolicyIds: string[],
) {
  const card = await ctx.db.selectFrom('cards').select(['id', 'board_id', 'column_id']).where('id', '=', cardId).executeTakeFirst();
  if (!card) throw badRequest('card not found');
  await assertBoardAccess(ctx.db, actor, card.board_id, 'edit');

  const { leavePolicies, enterPolicies } = await movePolicies(ctx.db, card.column_id, toColumnId);
  const applicable = [...leavePolicies, ...enterPolicies];
  await saveProgress(ctx.db, cardId, actor.userId, applicable, acknowledgedPolicyIds);
  return { checkedIds: (await checkedPolicyIds(ctx.db, cardId)).filter((id) => applicable.some((p) => p.id === id)) };
}

/**
 * Override audit for reporting. Board-scoped and access-checked, so a widget
 * built on it can only ever surface boards the requester may see.
 */
export async function listOverrides(ctx: AppCtx, actor: Actor, boardId: string, limit = 200) {
  await assertBoardAccess(ctx.db, actor, boardId, 'view');
  return ctx.db
    .selectFrom('card_move_overrides')
    .leftJoin('cards', 'cards.id', 'card_move_overrides.card_id')
    .leftJoin('users', 'users.id', 'card_move_overrides.actor_id')
    .select([
      'card_move_overrides.id',
      'card_move_overrides.card_id',
      'card_move_overrides.from_column_id',
      'card_move_overrides.to_column_id',
      'card_move_overrides.backwards',
      'card_move_overrides.skipped_policies',
      'card_move_overrides.reason',
      'card_move_overrides.at',
      'cards.title as card_title',
      'users.display_name as actor_name',
    ])
    .where('card_move_overrides.board_id', '=', boardId)
    .orderBy('card_move_overrides.at', 'desc')
    .limit(limit)
    .execute();
}
