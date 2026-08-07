/**
 * Assembles CardFact rows for the pivot engine — strictly from boards the
 * requesting user can access. A requested boardIds filter is INTERSECTED with
 * the accessible set, so foreign ids simply contribute nothing.
 *
 * Both the single-series and the multi-series entry points share this one fact
 * collector, so a chart can never widen its own data access by asking for more
 * series.
 */
import type { ColumnSemantic } from '@kan-do/shared';
import type { Actor } from '../domain/rbac.js';
import { computeCardMetrics } from '../domain/metrics.js';
import {
  pivot,
  multiPivot,
  type CardFact,
  type PivotQuery,
  type PivotRow,
  type MultiPivotQuery,
  type MultiPivotResult,
} from '../domain/pivot.js';
import type { AppCtx } from './context.js';
import { listBoards } from './boards.js';

const month = (d: Date) => d.toISOString().slice(0, 7);

async function collectFacts(ctx: AppCtx, actor: Actor, boardIds?: string[]): Promise<{ facts: CardFact[]; boardCount: number }> {
  const accessible = await listBoards(ctx, actor);
  const boards = boardIds?.length ? accessible.filter((b) => boardIds.includes(b.id)) : accessible;

  const facts: CardFact[] = [];
  const now = new Date();

  for (const board of boards) {
    const [columns, lanes, categories, cards] = await Promise.all([
      ctx.db.selectFrom('board_columns').select(['id', 'name', 'semantic']).where('board_id', '=', board.id).execute(),
      ctx.db.selectFrom('lanes').select(['id', 'name']).where('board_id', '=', board.id).execute(),
      ctx.db.selectFrom('categories').select(['id', 'name']).where('org_id', '=', board.org_id).execute(),
      ctx.db.selectFrom('cards').selectAll().where('board_id', '=', board.id).execute(),
    ]);
    if (cards.length === 0) continue;

    const colName = new Map(columns.map((c) => [c.id, c.name]));
    const semantics = new Map<string, ColumnSemantic>(columns.map((c) => [c.id, c.semantic]));
    const laneName = new Map(lanes.map((l) => [l.id, l.name]));
    const catName = new Map(categories.map((c) => [c.id, c.name]));

    const owners = await ctx.db
      .selectFrom('card_owners')
      .leftJoin('users', 'users.id', 'card_owners.user_id')
      .leftJoin('external_owners', 'external_owners.id', 'card_owners.external_owner_id')
      .select(['card_owners.card_id', 'users.display_name as user_name', 'external_owners.display_name as external_name'])
      .where('card_owners.card_id', 'in', cards.map((c) => c.id))
      .execute();
    const ownersByCard = new Map<string, string[]>();
    for (const o of owners) {
      const name = o.user_name ?? o.external_name;
      if (!name) continue;
      const list = ownersByCard.get(o.card_id) ?? [];
      list.push(name);
      ownersByCard.set(o.card_id, list);
    }

    // policy/backwards overrides make it into the pivot so "how often do we
    // bypass our own rules" is answerable from the widget builder
    const overrides = await ctx.db
      .selectFrom('card_move_overrides')
      .select(({ fn }) => ['card_id', fn.countAll().as('n')])
      .where('board_id', '=', board.id)
      .groupBy('card_id')
      .execute();
    const overridesByCard = new Map(overrides.map((o) => [o.card_id, Number(o.n)]));

    for (const card of cards) {
      const transitions = await ctx.db
        .selectFrom('card_transitions')
        .select(['to_column_id', 'at'])
        .where('card_id', '=', card.id)
        .orderBy('at')
        .execute();
      const [first, ...rest] = transitions;
      const m = first
        ? computeCardMetrics(
            new Date(card.created_at),
            first.to_column_id,
            rest.map((t) => ({ toColumnId: t.to_column_id, at: new Date(t.at) })),
            semantics,
            now,
          )
        : { leadTimeMs: null, cycleTimeMs: null, waitingTimeMs: null, perColumnMs: {} as Record<string, number> };

      let closedMonth = 'Not done';
      for (const t of transitions) {
        if (semantics.get(t.to_column_id) === 'done') {
          closedMonth = month(new Date(t.at));
          break;
        }
      }

      const overrideCount = overridesByCard.get(card.id) ?? 0;

      facts.push({
        board: board.name,
        column: colName.get(card.column_id) ?? 'Unknown',
        lane: card.lane_id ? (laneName.get(card.lane_id) ?? 'None') : 'None',
        category: card.category_id ? (catName.get(card.category_id) ?? 'None') : 'None',
        owners: ownersByCard.get(card.id) ?? [],
        recurrenceStatus: card.recurrence_rule ? card.recurrence_status : 'not recurring',
        createdMonth: month(new Date(card.created_at)),
        closedMonth,
        overrideStatus: overrideCount > 0 ? 'overridden' : 'clean',
        leadTimeMs: m.leadTimeMs,
        cycleTimeMs: m.cycleTimeMs,
        waitingTimeMs: m.waitingTimeMs,
        timeInColumnMs: m.perColumnMs[card.column_id] ?? null,
        overrideCount,
      });
    }
  }

  return { facts, boardCount: boards.length };
}

export async function runPivotQuery(
  ctx: AppCtx,
  actor: Actor,
  query: PivotQuery & { boardIds?: string[] },
): Promise<{ rows: PivotRow[]; boardCount: number }> {
  const { facts, boardCount } = await collectFacts(ctx, actor, query.boardIds);
  return { rows: pivot(facts, query), boardCount };
}

export async function runMultiPivotQuery(
  ctx: AppCtx,
  actor: Actor,
  query: MultiPivotQuery & { boardIds?: string[] },
): Promise<MultiPivotResult & { boardCount: number }> {
  const { facts, boardCount } = await collectFacts(ctx, actor, query.boardIds);
  return { ...multiPivot(facts, query), boardCount };
}
