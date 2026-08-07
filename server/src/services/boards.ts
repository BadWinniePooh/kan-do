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

export async function createBoard(ctx: AppCtx, actor: Actor, name: string) {
  if (!actor.orgId || !canCreateBoard(actor, actor.orgId)) throw forbidden();
  return ctx.db.transaction().execute(async (trx) => {
    const board = await trx
      .insertInto('boards')
      .values({ org_id: actor.orgId!, name, created_by: actor.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx.insertInto('board_members').values({ board_id: board.id, user_id: actor.userId, is_owner: true }).execute();
    // every board starts with a guaranteed open + done column
    await trx
      .insertInto('board_columns')
      .values([
        { board_id: board.id, name: 'Open', position: 0, semantic: 'open' },
        { board_id: board.id, name: 'In progress', position: 1, semantic: null },
        { board_id: board.id, name: 'Done', position: 2, semantic: 'done' },
      ])
      .execute();
    return board;
  });
}

export async function getBoardDetail(ctx: AppCtx, actor: Actor, boardId: string) {
  await assertBoardAccess(ctx.db, actor, boardId, 'view');
  const [board, columns, lanes, members, cards] = await Promise.all([
    ctx.db.selectFrom('boards').selectAll().where('id', '=', boardId).executeTakeFirstOrThrow(),
    ctx.db.selectFrom('board_columns').selectAll().where('board_id', '=', boardId).orderBy('position').execute(),
    ctx.db.selectFrom('lanes').selectAll().where('board_id', '=', boardId).orderBy('position').execute(),
    ctx.db
      .selectFrom('board_members')
      .innerJoin('users', 'users.id', 'board_members.user_id')
      .select(['users.id', 'users.display_name', 'users.avatar_key', 'board_members.is_owner'])
      .where('board_members.board_id', '=', boardId)
      .execute(),
    ctx.db.selectFrom('cards').selectAll().where('board_id', '=', boardId).orderBy('position').execute(),
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
  return { board, columns, lanes, members, cards, owners: ownersWithUrls, covers };
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
  semantic: 'open' | 'done' | null;
}

/** Replace-style column update; enforces the open/done invariant. */
export async function saveColumns(ctx: AppCtx, actor: Actor, boardId: string, columns: ColumnInput[]) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  if (!columns.some((c) => c.semantic === 'open') || !columns.some((c) => c.semantic === 'done')) {
    throw badRequest('board must keep at least one "open" and one "done" column');
  }
  const result = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('board_columns').select('id').where('board_id', '=', boardId).execute();
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
            .where('board_id', '=', boardId)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      } else {
        out.push(
          await trx
            .insertInto('board_columns')
            .values({ board_id: boardId, name: c.name, position: c.position, semantic: c.semantic })
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
 * Lane invariant: once a board has >=1 lane, every card on it has a valid
 * lane; with zero lanes, all cards have lane_id NULL (one implicit lane).
 * Enforced here (first-lane backfill, orphan reassignment after deletes) and
 * in the card service on create/move/update — a card can never end up hidden
 * from every lane view.
 */
export async function saveLanes(ctx: AppCtx, actor: Actor, boardId: string, lanes: { id?: string; name: string; position: number }[]) {
  await assertBoardAccess(ctx.db, actor, boardId, 'edit');
  const result = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('lanes').select('id').where('board_id', '=', boardId).execute();
    const keep = new Set(lanes.filter((l) => l.id).map((l) => l.id!));
    const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (toDelete.length) await trx.deleteFrom('lanes').where('id', 'in', toDelete).execute();
    const out: { id: string; board_id: string; name: string; position: number }[] = [];
    for (const l of [...lanes].sort((a, b) => a.position - b.position)) {
      out.push(
        l.id
          ? await trx
              .updateTable('lanes')
              .set({ name: l.name, position: l.position, updated_at: new Date() })
              .where('id', '=', l.id)
              .where('board_id', '=', boardId)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('lanes')
              .values({ board_id: boardId, name: l.name, position: l.position })
              .returningAll()
              .executeTakeFirstOrThrow(),
      );
    }
    if (out.length > 0) {
      // backfill lane-less cards (board's first lane ever, or orphans left by
      // lane deletion — the FK sets them NULL inside this transaction)
      const first = out[0]!;
      await trx
        .updateTable('cards')
        .set({ lane_id: first.id, updated_at: new Date() })
        .where('board_id', '=', boardId)
        .where((eb) =>
          eb.or([eb('lane_id', 'is', null), eb('lane_id', 'not in', out.map((l) => l.id))]),
        )
        .execute();
    }
    return out;
  });
  ctx.realtime.emitToBoard(boardId, { type: 'lane.changed' });
  return result;
}

/** First lane (by position) of a board, or null when the board has no lanes. */
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
