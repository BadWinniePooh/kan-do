import { describe, it, expect } from 'vitest';
import { pivot, type CardFact } from './pivot.js';

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
  leadTimeMs: null,
  cycleTimeMs: null,
  waitingTimeMs: null,
  timeInColumnMs: null,
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
