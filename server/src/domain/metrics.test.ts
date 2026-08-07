import { describe, it, expect } from 'vitest';
import { computeCardMetrics, meanMs } from './metrics.js';
import type { ColumnSemantic } from '@kan-do/shared';

const semantics = new Map<string, ColumnSemantic>([
  ['open', 'open'],
  ['doing', null],
  ['review', null],
  ['done', 'done'],
]);

const T = (s: string) => new Date(s);
const HOUR = 3_600_000;

describe('computeCardMetrics', () => {
  it('full journey: open -> doing -> done', () => {
    const m = computeCardMetrics(
      T('2026-08-01T00:00:00Z'),
      'open',
      [
        { toColumnId: 'doing', at: T('2026-08-01T02:00:00Z') },
        { toColumnId: 'done', at: T('2026-08-01T05:00:00Z') },
      ],
      semantics,
      T('2026-08-01T10:00:00Z'),
    );
    expect(m.leadTimeMs).toBe(5 * HOUR);   // created -> done
    expect(m.cycleTimeMs).toBe(3 * HOUR);  // left open -> done
    expect(m.waitingTimeMs).toBe(2 * HOUR); // sat in open
    expect(m.perColumnMs).toEqual({ open: 2 * HOUR, doing: 3 * HOUR, done: 5 * HOUR });
  });

  it('card still open: null lead/cycle, waiting accrues to now', () => {
    const m = computeCardMetrics(T('2026-08-01T00:00:00Z'), 'open', [], semantics, T('2026-08-01T04:00:00Z'));
    expect(m.leadTimeMs).toBeNull();
    expect(m.cycleTimeMs).toBeNull();
    expect(m.waitingTimeMs).toBe(4 * HOUR);
    expect(m.perColumnMs).toEqual({ open: 4 * HOUR });
  });

  it('bounced back and forth: per-column sums accumulate', () => {
    const m = computeCardMetrics(
      T('2026-08-01T00:00:00Z'),
      'open',
      [
        { toColumnId: 'doing', at: T('2026-08-01T01:00:00Z') },
        { toColumnId: 'open', at: T('2026-08-01T02:00:00Z') },
        { toColumnId: 'doing', at: T('2026-08-01T04:00:00Z') },
        { toColumnId: 'done', at: T('2026-08-01T06:00:00Z') },
      ],
      semantics,
      T('2026-08-01T06:00:00Z'),
    );
    expect(m.perColumnMs.open).toBe(3 * HOUR); // 0-1 and 2-4
    expect(m.perColumnMs.doing).toBe(3 * HOUR);
    expect(m.waitingTimeMs).toBe(3 * HOUR);
    expect(m.cycleTimeMs).toBe(5 * HOUR); // first left open at 01:00, done at 06:00
    expect(m.leadTimeMs).toBe(6 * HOUR);
  });

  it('straight to done counts first done arrival for lead time', () => {
    const m = computeCardMetrics(
      T('2026-08-01T00:00:00Z'),
      'open',
      [{ toColumnId: 'done', at: T('2026-08-01T01:00:00Z') }],
      semantics,
      T('2026-08-02T00:00:00Z'),
    );
    expect(m.leadTimeMs).toBe(1 * HOUR);
    expect(m.cycleTimeMs).toBe(0); // left open exactly when done
  });

  it('unordered transition input is sorted', () => {
    const m = computeCardMetrics(
      T('2026-08-01T00:00:00Z'),
      'open',
      [
        { toColumnId: 'done', at: T('2026-08-01T05:00:00Z') },
        { toColumnId: 'doing', at: T('2026-08-01T02:00:00Z') },
      ],
      semantics,
      T('2026-08-01T05:00:00Z'),
    );
    expect(m.leadTimeMs).toBe(5 * HOUR);
    expect(m.cycleTimeMs).toBe(3 * HOUR);
  });

  it('reopened after done: lead/cycle stick to FIRST done arrival', () => {
    const m = computeCardMetrics(
      T('2026-08-01T00:00:00Z'),
      'open',
      [
        { toColumnId: 'done', at: T('2026-08-01T02:00:00Z') },
        { toColumnId: 'open', at: T('2026-08-02T02:00:00Z') }, // recurrence reopen
      ],
      semantics,
      T('2026-08-02T10:00:00Z'),
    );
    expect(m.leadTimeMs).toBe(2 * HOUR);
    // waiting counts only before first done
    expect(m.waitingTimeMs).toBe(2 * HOUR);
  });
});

describe('meanMs', () => {
  it('ignores nulls, null when empty', () => {
    expect(meanMs([HOUR, 3 * HOUR, null])).toBe(2 * HOUR);
    expect(meanMs([null, null])).toBeNull();
    expect(meanMs([])).toBeNull();
  });
});
