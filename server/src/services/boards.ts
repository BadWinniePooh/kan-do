import type { Actor } from '../domain/rbac.js';
import { canAccessBoard, canCreateBoard, sameTenant } from '../domain/rbac.js';
import type { AppCtx } from './context.js';
import { HttpError, badRequest, forbidden, notFound } from './context.js';
import type { Db } from '../db/index.js';

export async function assertBoardAccess(
  db: Db,
  actor: Actor,
  boardId: string,
  level: 'view' | 'edit' | 'admin',
): Promise<{ id: string; org_id: string }> {
  const board = await db.selectFrom('boards').select(['id', 'org_id']).where('id', '=', boardId).executeTakeFirst();
  if (!board) throw notFound('board');
  const members = await db.selectFrom('board_members').select('user_id').where('board_id', '=', boardId).execute();
  if (!canAccessBoard(actor, { orgId: board.org_id, memberIds: members.map((m) => m.user_id) }, level)) {
    throw forbidden();
  }
  return board;
}

export async function listBoards(ctx: AppCtx, actor: Actor) {
  if (actor.role === 'global_admin') {
    return ctx.db.selectFrom('boards').selectAll().orderBy('created_at').execute();
  }
  return ctx.db
    .selectFrom('boards')
    .innerJoin('board_members', 'board_members.board_id', 'boards.id')
    .where('board_members.user_id', '=', actor.userId)
    .selectAll('boards')
    .orderBy('boards.created_at')
    .execute();
}

/**
 * The column set a brand-new lane starts with. Every lane must independently
 * satisfy the open+done invariant, so a lane can never exist without them.
 */
export const DEFAULT_LANE_COLUMNS: { name: string; position: number; semantic: 'open' | 'done' | null }[] = [
  { name: 'Open', position: 0, semantic: 'open' },
  { name: 'In progress', position: 1, semantic: null },
  { name: 'Done', position: 2, semantic: 'done' },
];

export async function createBoard(ctx: AppCtx, actor: Actor, name: string) {
  if (!actor.orgId || !canCreateBoard(actor, actor.orgId)) throw forbidden();
  return ctx.db.transaction().execute(async (trx) => {
    const board = await trx
      .insertInto('boards')
      .values({ org_id: actor.orgId!, name, created_by: actor.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx.insertInto('board_members').values({ board_id: board.id, user_id: actor.userId, is_owner: true }).execute();
    // columns live on lanes, so a board starts with one lane carrying the
    // guaranteed open + done pair
    const lane = await trx
      .insertInto('lanes')
      .values({ board_id: board.id, name: 'Default', position: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('board_columns')
      .values(DEFAULT_LANE_COLUMNS.map((c) => ({ ...c, board_id: board.id, lane_id: lane.id })))
      .execute();
    return board;
  });
}

export async function getBoardDetail(ctx: AppCtx, actor: Actor, boardId: string) {
  await assertBoardAccess(ctx.db, actor, boardId, 'view');
  const orgIdRow = await ctx.db.selectFrom('boards').select('org_id').where('id', '=', boardId).executeTakeFirstOrThrow();
  const [board, columns, lanes, members, cards, categories, policies] = await Promise.all([
    ctx.db.selectFrom('boards').selectAll().where('id', '=', boardId).executeTakeFirstOrThrow(),
    // lane-scoped: ordered by lane then position, so the client can group
    // straight into per-lane column strips
    ctx.db
      .selectFrom('board_columns')
      .innerJoin('lanes', 'lanes.id', 'board_columns.lane_id')
      .selectAll('board_columns')
      .where('board_columns.board_id', '=', boardId)
      .orderBy('lanes.position')
      .orderBy('board_columns.position')
      .execute(),
    ctx.db.selectFrom('lanes').selectAll().where('board_id', '=', boardId).orderBy('position').execute(),
    ctx.db
      .selectFrom('board_members')
      .innerJoin('users', 'users.id', 'board_members.user_id')
      .select(['users.id', 'users.display_name', 'users.avatar_key', 'board_members.is_owner'])
      .where('board_members.board_id', '=', boardId)
      .execute(),
    ctx.db.selectFrom('cards').selectAll().where('board_id', '=', boardId).orderBy('position').execute(),
    ctx.db.selectFrom('categories').selectAll().where('org_id', '=', orgIdRow.org_id).orderBy('name').execute(),
    // shipped with the board so the UI knows which columns gate movement
    // without a second round-trip per column
    ctx.db
      .selectFrom('column_policies')
      .innerJoin('board_columns', 'board_columns.id', 'column_policies.column_id')
      .select(['column_policies.id', 'column_policies.column_id', 'column_policies.kind', 'column_policies.label', 'column_policies.position'])
      .where('board_columns.board_id', '=', boardId)
      .orderBy('column_policies.position')
      .execute(),
  ]);
  const cardIds = cards.map((c) => c.id);
  const owners = cardIds.length
    ? await ctx.db
        .selectFrom('card_owners')
        .leftJoin('users', 'users.id', 'card_owners.user_id')
        .leftJoin('external_owners', 'external_owners.id', 'card_owners.external_owner_id')
        .select([
          'card_owners.card_id',
          'card_owners.kind',
          'card_owners.user_id',
          'card_owners.external_owner_id',
          'users.display_name as user_name',
          'users.avatar_key as user_avatar',
          'external_owners.display_name as external_name',
        ])
        .where('card_owners.card_id', 'in', cardIds)
        .execute()
    : [];
  // avatar_key is an object-storage key, not a URL — presign before it
  // reaches any <img src>. One signature per distinct key.
  const avatarUrls = new Map<string, string>();
  for (const key of new Set(owners.map((o) => o.user_avatar).filter((k): k is string => !!k))) {
    avatarUrls.set(key, await ctx.storage.presignDownload(key));
  }
  const ownersWithUrls = owners.map((o) => ({
    ...o,
    user_avatar: o.user_avatar ? (avatarUrls.get(o.user_avatar) ?? null) : null,
  }));
  const coveredCards = cards.filter((c) => c.cover_attachment_id);
  const covers: Record<string, string> = {};
  if (coveredCards.length) {
    const atts = await ctx.db
      .selectFrom('attachments')
      .select(['id', 'object_key'])
      .where('id', 'in', coveredCards.map((c) => c.cover_attachment_id!))
      .execute();
    const byId = new Map(atts.map((a) => [a.id, a.object_key]));
    for (const c of coveredCards) {
      const key = byId.get(c.cover_attachment_id!);
      if (key) covers[c.id] = await ctx.storage.presignDownload(key);
    }
  }
  return { board, columns, lanes, members, cards, owners: ownersWithUrls, covers, categories, policies };
}

export async function updateBoard(ctx: AppCtx, actor: Actor, boardId: string, patch: { name?: string }) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  const board = await ctx.db
    .updateTable('boards')
    .set({ ...patch, updated_at: new Date() })
    .where('id', '=', boardId)
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.realtime.emitToBoard(boardId, { type: 'board.updated' });
  return board;
}

export interface ColumnInput {
  id?: string;
  name: string;
  position: number;
  semantic: 'open' | 'done' | 'discard' | null;
}

/**
 * Replace-style column update for ONE lane. Columns are lane-scoped, so two
 * lanes on the same board may have entirely different columns — and the
 * open+done invariant is checked per lane, not per board. 'discard' is optional
 * and a lane may have several plain columns or none.
 */
export async function saveColumns(ctx: AppCtx, actor: Actor, boardId: string, laneId: string, columns: ColumnInput[]) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  const lane = await ctx.db.selectFrom('lanes').select(['id', 'board_id']).where('id', '=', laneId).executeTakeFirst();
  if (!lane || lane.board_id !== boardId) throw badRequest('lane does not belong to board');
  if (!columns.some((c) => c.semantic === 'open') || !columns.some((c) => c.semantic === 'done')) {
    throw badRequest('every lane must keep at least one "open" and one "done" column');
  }
  const result = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('board_columns').select('id').where('lane_id', '=', laneId).execute();
    const keepIds = new Set(columns.filter((c) => c.id).map((c) => c.id!));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      const occupied = await trx
        .selectFrom('cards')
        .select('id')
        .where('column_id', 'in', toDelete)
        .limit(1)
        .executeTakeFirst();
      if (occupied) throw badRequest('cannot delete a column that still holds cards');
      await trx.deleteFrom('board_columns').where('id', 'in', toDelete).execute();
    }
    const out = [];
    for (const c of columns) {
      if (c.id) {
        out.push(
          await trx
            .updateTable('board_columns')
            .set({ name: c.name, position: c.position, semantic: c.semantic, updated_at: new Date() })
            .where('id', '=', c.id)
            // scoped to the lane: a column can never be re-homed into another one
            .where('lane_id', '=', laneId)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      } else {
        out.push(
          await trx
            .insertInto('board_columns')
            .values({ board_id: boardId, lane_id: laneId, name: c.name, position: c.position, semantic: c.semantic })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
    }
    return out;
  });
  ctx.realtime.emitToBoard(boardId, { type: 'column.changed' });
  return result;
}

/**
 * Lane invariants, now that columns hang off lanes:
 *  - a board always has at least one lane (a column has nowhere else to live);
 *  - a new lane is born with its own open/done column pair, so it is valid the
 *    instant it exists rather than only after a follow-up column save;
 *  - a lane holding cards cannot be deleted — deleting it would take its
 *    columns, and with them the cards' placement. The caller moves the cards
 *    out first, deliberately.
 */
export async function saveLanes(ctx: AppCtx, actor: Actor, boardId: string, lanes: { id?: string; name: string; position: number }[]) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  if (lanes.length === 0) throw badRequest('a board must keep at least one lane');
  const result = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('lanes').select('id').where('board_id', '=', boardId).execute();
    const keep = new Set(lanes.filter((l) => l.id).map((l) => l.id!));
    const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      const occupied = await trx.selectFrom('cards').select('id').where('lane_id', 'in', toDelete).limit(1).executeTakeFirst();
      if (occupied) throw badRequest('cannot delete a lane that still holds cards — move them to another lane first');
      await trx.deleteFrom('lanes').where('id', 'in', toDelete).execute();
    }
    const out: { id: string; board_id: string; name: string; position: number }[] = [];
    for (const l of [...lanes].sort((a, b) => a.position - b.position)) {
      if (l.id) {
        out.push(
          await trx
            .updateTable('lanes')
            .set({ name: l.name, position: l.position, updated_at: new Date() })
            .where('id', '=', l.id)
            .where('board_id', '=', boardId)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      } else {
        const lane = await trx
          .insertInto('lanes')
          .values({ board_id: boardId, name: l.name, position: l.position })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('board_columns')
          .values(DEFAULT_LANE_COLUMNS.map((c) => ({ ...c, board_id: boardId, lane_id: lane.id })))
          .execute();
        out.push(lane);
      }
    }
    return out;
  });
  ctx.realtime.emitToBoard(boardId, { type: 'lane.changed' });
  return result;
}

/** First lane (by position) of a board. Every board has one. */
export async function firstLaneId(db: Db, boardId: string): Promise<string | null> {
  const lane = await db
    .selectFrom('lanes')
    .select('id')
    .where('board_id', '=', boardId)
    .orderBy('position')
    .orderBy('created_at')
    .executeTakeFirst();
  return lane?.id ?? null;
}

/**
 * A lane's open-mapped column — where a card lands when it is (re)opened.
 * Per lane, because column identity is lane-scoped now.
 */
export async function openColumnOfLane(db: Db, laneId: string): Promise<string | null> {
  const col = await db
    .selectFrom('board_columns')
    .select('id')
    .where('lane_id', '=', laneId)
    .where('semantic', '=', 'open')
    .orderBy('position')
    .executeTakeFirst();
  return col?.id ?? null;
}

export async function addBoardMember(ctx: AppCtx, actor: Actor, boardId: string, userId: string) {
  const board = await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  const user = await ctx.db.selectFrom('users').select(['id', 'org_id']).where('id', '=', userId).executeTakeFirst();
  if (!user) throw notFound('user');
  if (user.org_id !== board.org_id) throw new HttpError(400, 'user belongs to a different organization');
  await ctx.db
    .insertInto('board_members')
    .values({ board_id: boardId, user_id: userId })
    .onConflict((oc) => oc.doNothing())
    .execute();
  ctx.realtime.emitToBoard(boardId, { type: 'board.updated' });
}

export async function removeBoardMember(ctx: AppCtx, actor: Actor, boardId: string, userId: string) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  await ctx.db.deleteFrom('board_members').where('board_id', '=', boardId).where('user_id', '=', userId).execute();
  ctx.realtime.emitToBoard(boardId, { type: 'board.updated' });
}

export async function deleteBoard(ctx: AppCtx, actor: Actor, boardId: string) {
  const board = await ctx.db.selectFrom('boards').select(['id', 'org_id']).where('id', '=', boardId).executeTakeFirst();
  if (!board) throw notFound('board');
  const membership = await ctx.db
    .selectFrom('board_members')
    .select('is_owner')
    .where('board_id', '=', boardId)
    .where('user_id', '=', actor.userId)
    .executeTakeFirst();
  const allowed =
    actor.role === 'global_admin' || (sameTenant(actor, board.org_id) && membership?.is_owner === true);
  if (!allowed) throw forbidden();
  await ctx.db.deleteFrom('boards').where('id', '=', boardId).execute();
}
