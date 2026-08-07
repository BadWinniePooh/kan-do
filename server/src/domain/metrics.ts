/**
 * Metrics engine — pure computation from the card's column-transition history.
 *
 * Definitions (documented in ARCHITECTURE.md):
 *  - lead time:   card creation -> first arrival in a done-mapped column
 *  - cycle time:  first departure from an open-mapped column -> first arrival
 *                 in a done-mapped column (work started -> finished)
 *  - waiting:     total time spent in open-mapped columns before first done
 *  - per-column:  total dwell time per column (open-ended stays count to `now`)
 */
import type { ColumnSemantic, MetricDefs } from '@kan-do/shared';

export interface Transition {
  toColumnId: string;
  at: Date;
}

export function computeCardMetrics(
  createdAt: Date,
  initialColumnId: string,
  transitions: Transition[],
  semantics: Map<string, ColumnSemantic>,
  now: Date,
): MetricDefs {
  // Build stays: [columnId, from, to]
  const ordered = [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const stays: { columnId: string; from: Date; to: Date }[] = [];
  let currentColumn = initialColumnId;
  let since = createdAt;
  for (const t of ordered) {
    stays.push({ columnId: currentColumn, from: since, to: t.at });
    currentColumn = t.toColumnId;
    since = t.at;
  }
  stays.push({ columnId: currentColumn, from: since, to: now });

  const perColumnMs: Record<string, number> = {};
  for (const s of stays) {
    perColumnMs[s.columnId] = (perColumnMs[s.columnId] ?? 0) + (s.to.getTime() - s.from.getTime());
  }

  let firstDoneArrival: Date | null = null;
  for (const t of ordered) {
    if (semantics.get(t.toColumnId) === 'done') {
      firstDoneArrival = t.at;
      break;
    }
  }

  // Discarding is NOT completing: it never sets firstDoneArrival, so lead and
  // cycle time stay null for a discarded card. It does stop the clock though —
  // a card thrown away out of the backlog must not accrue waiting time forever.
  let firstDiscardArrival: Date | null = null;
  for (const t of ordered) {
    if (semantics.get(t.toColumnId) === 'discard') {
      firstDiscardArrival = t.at;
      break;
    }
  }

  // first departure from an open-mapped column
  let workStarted: Date | null = null;
  for (const s of stays) {
    if (semantics.get(s.columnId) === 'open') {
      const departed = s.to.getTime() < now.getTime() || firstDoneArrival !== null;
      if (s.to.getTime() < now.getTime()) {
        workStarted = s.to;
        break;
      }
      if (!departed) break;
    }
  }

  let waitingMs = 0;
  const cutoff = firstDoneArrival ?? firstDiscardArrival ?? now;
  for (const s of stays) {
    if (semantics.get(s.columnId) === 'open' && s.from < cutoff) {
      const end = s.to < cutoff ? s.to : cutoff;
      waitingMs += Math.max(0, end.getTime() - s.from.getTime());
    }
  }

  return {
    leadTimeMs: firstDoneArrival ? firstDoneArrival.getTime() - createdAt.getTime() : null,
    cycleTimeMs:
      firstDoneArrival && workStarted && workStarted <= firstDoneArrival
        ? firstDoneArrival.getTime() - workStarted.getTime()
        : null,
    waitingTimeMs: waitingMs,
    perColumnMs,
  };
}

/** Aggregate helper for dashboard widgets: mean of non-null values. */
export function meanMs(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
