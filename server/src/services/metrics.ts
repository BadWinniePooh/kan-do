import type { ColumnSemantic } from '@kan-do/shared';
import { computeCardMetrics, meanMs } from '../domain/metrics.js';
import type { Actor } from '../domain/rbac.js';
import type { AppCtx } from './context.js';
import { assertBoardAccess } from './boards.js';

export async function boardMetrics(ctx: AppCtx, actor: Actor, boardId: string) {
  await assertBoardAccess(ctx.db, actor, boardId, 'view');
  const [columns, cards] = await Promise.all([
    ctx.db.selectFrom('board_columns').select(['id', 'name', 'semantic']).where('board_id', '=', boardId).orderBy('position').execute(),
    ctx.db.selectFrom('cards').select(['id', 'title', 'created_at']).where('board_id', '=', boardId).execute(),
  ]);
  const semantics = new Map<string, ColumnSemantic>(columns.map((c) => [c.id, c.semantic]));
  const now = new Date();

  const perCard: ({ cardId: string; title: string } & ReturnType<typeof computeCardMetrics>)[] = [];
  for (const card of cards) {
    const transitions = await ctx.db
      .selectFrom('card_transitions')
      .select(['to_column_id', 'at'])
      .where('card_id', '=', card.id)
      .orderBy('at')
      .execute();
    if (transitions.length === 0) continue;
    const [first, ...rest] = transitions;
    const m = computeCardMetrics(
      new Date(card.created_at),
      first!.to_column_id,
      rest.map((t) => ({ toColumnId: t.to_column_id, at: new Date(t.at) })),
      semantics,
      now,
    );
    perCard.push({ cardId: card.id, title: card.title, ...m });
  }

  // throughput: first arrival of each card into a done-mapped column
  const doneColumnIds = columns.filter((c) => c.semantic === 'done').map((c) => c.id);
  const doneEvents = doneColumnIds.length
    ? await ctx.db
        .selectFrom('card_transitions')
        .select(({ fn }) => ['card_id', fn.min('at').as('done_at')])
        .where('to_column_id', 'in', doneColumnIds)
        .where('card_id', 'in', cards.length ? cards.map((c) => c.id) : ['00000000-0000-0000-0000-000000000000'])
        .groupBy('card_id')
        .execute()
    : [];

  // "time since done": aging of cards currently resting in a done column —
  // reported separately because dwell there is expected, not a bottleneck
  const doneAges: number[] = [];
  if (doneColumnIds.length) {
    const resting = await ctx.db
      .selectFrom('cards')
      .select(['id'])
      .where('board_id', '=', boardId)
      .where('column_id', 'in', doneColumnIds)
      .execute();
    for (const c of resting) {
      const last = await ctx.db
        .selectFrom('card_transitions')
        .select('at')
        .where('card_id', '=', c.id)
        .orderBy('at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (last) doneAges.push(now.getTime() - new Date(last.at).getTime());
    }
  }

  const overdueCount = await ctx.db
    .selectFrom('cards')
    .select(({ fn }) => fn.countAll().as('n'))
    .where('board_id', '=', boardId)
    .where('is_overdue', '=', true)
    .executeTakeFirst();

  return {
    columns,
    perCard,
    doneEvents: doneEvents.map((d) => ({ at: d.done_at })),
    overdueCount: Number(overdueCount?.n ?? 0),
    aggregates: {
      meanLeadTimeMs: meanMs(perCard.map((c) => c.leadTimeMs)),
      meanCycleTimeMs: meanMs(perCard.map((c) => c.cycleTimeMs)),
      meanWaitingTimeMs: meanMs(perCard.map((c) => c.waitingTimeMs)),
      meanDoneAgeMs: meanMs(doneAges.length ? doneAges : [null]),
      perColumnMeanMs: columns.map((col) => ({
        columnId: col.id,
        name: col.name,
        meanMs: meanMs(perCard.map((c) => c.perColumnMs[col.id] ?? null)),
      })),
    },
  };
}
