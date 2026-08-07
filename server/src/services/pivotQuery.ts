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
  displayValue,
  DIMENSIONS,
  DIMENSION_LABELS,
  type Dimension,
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

    // overrides make it into the pivot so "how often do we bypass our own rules,
    // which ones, and why" is answerable straight from the widget builder
    const overrides = await ctx.db
      .selectFrom('card_move_overrides')
      .select(['card_id', 'backwards', 'lane_move', 'skipped_policies', 'reason'])
      .where('board_id', '=', board.id)
      .execute();
    const overridesByCard = new Map<string, { count: number; reasons: string[]; policies: string[] }>();
    for (const o of overrides) {
      const entry = overridesByCard.get(o.card_id) ?? { count: 0, reasons: [], policies: [] };
      entry.count += 1;
      if (o.reason?.trim()) entry.reasons.push(o.reason.trim());
      for (const p of Array.isArray(o.skipped_policies) ? (o.skipped_policies as { label: string }[]) : []) {
        if (p.label) entry.policies.push(p.label);
      }
      // the two rule bypasses that are not policies still deserve a name
      if (o.backwards) entry.policies.push('Backwards move');
      if (o.lane_move) entry.policies.push('Cross-lane move');
      overridesByCard.set(o.card_id, entry);
    }

    // blockers: how often work stalled, why, and for how long. An unresolved
    // blocker is still running, so it counts up to `now`.
    const blockerRows = await ctx.db
      .selectFrom('card_blockers')
      .select(['card_id', 'reason', 'started_at', 'ended_at'])
      .where(
        'card_id',
        'in',
        cards.map((c) => c.id),
      )
      .execute();
    const blockersByCard = new Map<string, { reasons: string[]; totalMs: number; count: number; active: boolean }>();
    for (const b of blockerRows) {
      const entry = blockersByCard.get(b.card_id) ?? { reasons: [], totalMs: 0, count: 0, active: false };
      entry.count += 1;
      entry.reasons.push(b.reason);
      entry.totalMs += (b.ended_at ?? now).getTime() - b.started_at.getTime();
      if (!b.ended_at) entry.active = true;
      blockersByCard.set(b.card_id, entry);
    }

    for (const card of cards) {
      const transitions = await ctx.db
        .selectFrom('card_transitions')
        .select(['to_column_id', 'at', 'reason'])
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

      // closedMonth is DONE only — a discarded card was never completed and
      // must never land in a completion bucket
      let closedMonth = 'Not done';
      for (const t of transitions) {
        if (semantics.get(t.to_column_id) === 'done') {
          closedMonth = month(new Date(t.at));
          break;
        }
      }

      // the reason given the last time this card was thrown away
      let discardReason = 'Not discarded';
      for (const t of [...transitions].reverse()) {
        if (semantics.get(t.to_column_id) === 'discard') {
          discardReason = t.reason?.trim() || 'No reason given';
          break;
        }
      }

      const currentSemantic = semantics.get(card.column_id);
      const outcome = currentSemantic === 'done' ? 'Done' : currentSemantic === 'discard' ? 'Discarded' : 'Active';
      const ov = overridesByCard.get(card.id);
      const bl = blockersByCard.get(card.id);

      facts.push({
        board: board.name,
        column: colName.get(card.column_id) ?? 'Unknown',
        lane: laneName.get(card.lane_id) ?? 'None',
        category: card.category_id ? (catName.get(card.category_id) ?? 'None') : 'None',
        owners: ownersByCard.get(card.id) ?? [],
        recurrenceStatus: card.recurrence_rule ? card.recurrence_status : 'not recurring',
        createdMonth: month(new Date(card.created_at)),
        closedMonth,
        outcome,
        overrideStatus: ov ? 'overridden' : 'clean',
        blockStatus: bl?.active ? 'Blocked now' : bl ? 'Was blocked' : 'Never blocked',
        discardReason,
        overrideReasons: ov?.reasons ?? [],
        overriddenPolicies: ov?.policies ?? [],
        blockerReasons: bl?.reasons ?? [],
        leadTimeMs: m.leadTimeMs,
        cycleTimeMs: m.cycleTimeMs,
        waitingTimeMs: m.waitingTimeMs,
        timeInColumnMs: m.perColumnMs[card.column_id] ?? null,
        overrideCount: ov?.count ?? 0,
        blockerCount: bl?.count ?? 0,
        // null, not 0, for a card that was never blocked: averaging "blocked
        // duration" must not be dragged down by cards that never stalled
        blockedTimeMs: bl ? bl.totalMs : null,
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

/** Field catalogue for the widget builder's data browser. */
export const FACT_FIELDS: { key: string; label: string; kind: 'dimension' | 'metric'; format: 'text' | 'count' | 'duration' }[] = [
  ...DIMENSIONS.map((key) => ({ key, label: DIMENSION_LABELS[key], kind: 'dimension' as const, format: 'text' as const })),
  { key: 'count', label: 'Card count', kind: 'metric', format: 'count' },
  { key: 'leadTimeMs', label: 'Lead time', kind: 'metric', format: 'duration' },
  { key: 'cycleTimeMs', label: 'Cycle time', kind: 'metric', format: 'duration' },
  { key: 'waitingTimeMs', label: 'Waiting time', kind: 'metric', format: 'duration' },
  { key: 'timeInColumnMs', label: 'Time in current column', kind: 'metric', format: 'duration' },
  { key: 'blockedTimeMs', label: 'Blocked time', kind: 'metric', format: 'duration' },
  { key: 'blockerCount', label: 'Blockers', kind: 'metric', format: 'count' },
  { key: 'overrideCount', label: 'Rule overrides', kind: 'metric', format: 'count' },
];

/**
 * The raw fact rows behind every widget, for the builder's spreadsheet-style
 * browser: the user picks grouping and measures by clicking real columns of
 * real data instead of choosing abstract labels from a dropdown.
 *
 * Same collector, same access scoping as the queries themselves — browsing can
 * never reveal a row a chart could not.
 */
export async function runFactsQuery(
  ctx: AppCtx,
  actor: Actor,
  query: { boardIds?: string[]; limit?: number },
): Promise<{ fields: typeof FACT_FIELDS; rows: Record<string, unknown>[]; total: number; boardCount: number }> {
  const { facts, boardCount } = await collectFacts(ctx, actor, query.boardIds);
  const limit = query.limit ?? 200;
  const rows = facts.slice(0, limit).map((f) => {
    const row: Record<string, unknown> = { count: 1 };
    for (const field of FACT_FIELDS) {
      if (field.key === 'count') continue;
      // multi-valued dimensions (owner, blocker reason, …) collapse to one
      // readable cell here; grouping still explodes them
      row[field.key] =
        field.kind === 'dimension'
          ? displayValue(f, field.key as Dimension)
          : (f as unknown as Record<string, unknown>)[field.key];
    }
    return row;
  });
  return { fields: FACT_FIELDS, rows, total: facts.length, boardCount };
}

export async function runMultiPivotQuery(
  ctx: AppCtx,
  actor: Actor,
  query: MultiPivotQuery & { boardIds?: string[] },
): Promise<MultiPivotResult & { boardCount: number }> {
  const { facts, boardCount } = await collectFacts(ctx, actor, query.boardIds);
  return { ...multiPivot(facts, query), boardCount };
}
