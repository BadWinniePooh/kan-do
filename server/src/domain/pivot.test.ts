import { describe, it, expect } from 'vitest';
import { pivot, multiPivot, type CardFact } from './pivot.js';

const HOUR = 3_600_000;

const fact = (over: Partial<CardFact>): CardFact => ({
  board: 'Board 1',
  column: 'Doing',
  lane: 'Team A',
  category: 'Bug',
  owners: [],
  recurrenceStatus: 'open',
  createdMonth: '2026-07',
  closedMonth: 'Not done',
  overrideStatus: 'clean',
  leadTimeMs: null,
  cycleTimeMs: null,
  waitingTimeMs: null,
  timeInColumnMs: null,
  overrideCount: 0,
  ...over,
});

describe('pivot', () => {
  it('count by one dimension', () => {
    const rows = pivot(
      [fact({ category: 'Bug' }), fact({ category: 'Bug' }), fact({ category: 'Chore' })],
      { dimensions: ['category'], metric: 'count', aggregation: 'count' },
    );
    expect(rows).toEqual([
      { keys: ['Bug'], value: 2, n: 2 },
      { keys: ['Chore'], value: 1, n: 1 },
    ]);
  });

  it('avg cycle time by column, nulls excluded from the aggregate', () => {
    const rows = pivot(
      [
        fact({ column: 'Doing', cycleTimeMs: 2 * HOUR }),
        fact({ column: 'Doing', cycleTimeMs: 4 * HOUR }),
        fact({ column: 'Doing', cycleTimeMs: null }),
      ],
      { dimensions: ['column'], metric: 'cycleTimeMs', aggregation: 'avg' },
    );
    expect(rows[0]!.value).toBe(3 * HOUR);
    expect(rows[0]!.n).toBe(3);
  });

  it('median (odd and even counts)', () => {
    const odd = pivot(
      [fact({ leadTimeMs: 1 }), fact({ leadTimeMs: 9 }), fact({ leadTimeMs: 5 })],
      { dimensions: ['board'], metric: 'leadTimeMs', aggregation: 'median' },
    );
    expect(odd[0]!.value).toBe(5);
    const even = pivot(
      [fact({ leadTimeMs: 1 }), fact({ leadTimeMs: 3 })],
      { dimensions: ['board'], metric: 'leadTimeMs', aggregation: 'median' },
    );
    expect(even[0]!.value).toBe(2);
  });

  it('min/max/sum', () => {
    const facts = [fact({ waitingTimeMs: HOUR }), fact({ waitingTimeMs: 3 * HOUR })];
    const q = (aggregation: 'min' | 'max' | 'sum') =>
      pivot(facts, { dimensions: ['board'], metric: 'waitingTimeMs', aggregation })[0]!.value;
    expect(q('min')).toBe(HOUR);
    expect(q('max')).toBe(3 * HOUR);
    expect(q('sum')).toBe(4 * HOUR);
  });

  it('two dimensions produce a key per pair', () => {
    const rows = pivot(
      [
        fact({ category: 'Bug', column: 'Doing' }),
        fact({ category: 'Bug', column: 'Done' }),
        fact({ category: 'Chore', column: 'Doing' }),
      ],
      { dimensions: ['category', 'column'], metric: 'count', aggregation: 'count' },
    );
    expect(rows.map((r) => r.keys)).toEqual([
      ['Bug', 'Doing'],
      ['Bug', 'Done'],
      ['Chore', 'Doing'],
    ]);
  });

  it('owner dimension explodes multi-owner cards, empty -> Unassigned', () => {
    const rows = pivot(
      [fact({ owners: ['Ann', 'Ben'] }), fact({ owners: [] })],
      { dimensions: ['owner'], metric: 'count', aggregation: 'count' },
    );
    expect(rows).toEqual([
      { keys: ['Ann'], value: 1, n: 1 },
      { keys: ['Ben'], value: 1, n: 1 },
      { keys: ['Unassigned'], value: 1, n: 1 },
    ]);
  });

  it('missing dimension value becomes "None"', () => {
    const rows = pivot([fact({ category: '' })], { dimensions: ['category'], metric: 'count', aggregation: 'count' });
    expect(rows[0]!.keys).toEqual(['None']);
  });

  it('aggregate over all-null metric values is null (never NaN)', () => {
    const rows = pivot([fact({ leadTimeMs: null })], { dimensions: ['board'], metric: 'leadTimeMs', aggregation: 'avg' });
    expect(rows[0]!.value).toBeNull();
  });

  it('rejects zero dimensions', () => {
    expect(() => pivot([fact({})], { dimensions: [], metric: 'count', aggregation: 'count' })).toThrow();
  });
});

describe('multiPivot', () => {
  const HOUR_ = 3_600_000;

  it('plots several series on one shared axis', () => {
    const res = multiPivot(
      [
        fact({ createdMonth: '2026-01', cycleTimeMs: 2 * HOUR_ }),
        fact({ createdMonth: '2026-01', cycleTimeMs: 4 * HOUR_ }),
        fact({ createdMonth: '2026-02', cycleTimeMs: 6 * HOUR_ }),
      ],
      {
        dimension: 'createdMonth',
        series: [
          { label: 'Cards', metric: 'count', aggregation: 'count' },
          { label: 'Mean cycle', metric: 'cycleTimeMs', aggregation: 'avg' },
        ],
      },
    );
    expect(res.keys).toEqual(['2026-01', '2026-02']);
    expect(res.series[0]!.values).toEqual([2, 1]);
    expect(res.series[1]!.values).toEqual([3 * HOUR_, 6 * HOUR_]);
  });

  it('burnup: scope and completed over their own dimensions, cumulative', () => {
    const res = multiPivot(
      [
        fact({ createdMonth: '2026-01', closedMonth: '2026-01' }),
        fact({ createdMonth: '2026-01', closedMonth: '2026-03' }),
        fact({ createdMonth: '2026-02', closedMonth: 'Not done' }),
        fact({ createdMonth: '2026-03', closedMonth: 'Not done' }),
      ],
      {
        dimension: 'createdMonth',
        omitKeys: ['Not done'],
        series: [
          { label: 'Scope', metric: 'count', aggregation: 'count', dimension: 'createdMonth', cumulative: true },
          { label: 'Completed', metric: 'count', aggregation: 'count', dimension: 'closedMonth', cumulative: true },
        ],
      },
    );
    expect(res.keys).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(res.series[0]!.values).toEqual([2, 3, 4]); // scope only ever grows
    expect(res.series[1]!.values).toEqual([1, 1, 2]); // completed trails it
  });

  it('a bucket a series never saw is 0 for counts and null for durations', () => {
    const res = multiPivot([fact({ createdMonth: '2026-01', closedMonth: '2026-02', leadTimeMs: HOUR_ })], {
      dimension: 'createdMonth',
      series: [
        { label: 'Closed', metric: 'count', aggregation: 'count', dimension: 'closedMonth' },
        { label: 'Lead', metric: 'leadTimeMs', aggregation: 'avg', dimension: 'createdMonth' },
      ],
    });
    expect(res.keys).toEqual(['2026-01', '2026-02']);
    expect(res.series[0]!.values).toEqual([0, 1]);
    expect(res.series[1]!.values).toEqual([HOUR_, null]);
  });

  it('omitKeys drops the bucket from the axis entirely', () => {
    const res = multiPivot([fact({ closedMonth: 'Not done' }), fact({ closedMonth: '2026-05' })], {
      dimension: 'closedMonth',
      omitKeys: ['Not done'],
      series: [{ label: 'Done', metric: 'count', aggregation: 'count' }],
    });
    expect(res.keys).toEqual(['2026-05']);
    expect(res.series[0]!.values).toEqual([1]);
  });

  it('cumulative carries the running total across empty buckets', () => {
    const res = multiPivot([fact({ createdMonth: '2026-01' }), fact({ createdMonth: '2026-03' })], {
      dimension: 'createdMonth',
      series: [
        { label: 'All', metric: 'count', aggregation: 'count', dimension: 'createdMonth', cumulative: true },
        { label: 'Closed', metric: 'count', aggregation: 'count', dimension: 'closedMonth', cumulative: true },
      ],
    });
    // the closedMonth series contributes a 'Not done' bucket to the axis here
    expect(res.keys).toEqual(['2026-01', '2026-03', 'Not done']);
    expect(res.series[0]!.values).toEqual([1, 2, 2]);
  });

  it('overrideCount is aggregatable like any other metric', () => {
    const res = multiPivot([fact({ column: 'Doing', overrideCount: 2 }), fact({ column: 'Doing', overrideCount: 1 })], {
      dimension: 'column',
      series: [{ label: 'Overrides', metric: 'overrideCount', aggregation: 'sum' }],
    });
    expect(res.series[0]!.values).toEqual([3]);
  });

  it('rejects an empty series list', () => {
    expect(() => multiPivot([fact({})], { dimension: 'column', series: [] })).toThrow();
  });
});
