import { describe, it, expect } from 'vitest';
import { applicablePolicies, evaluateMove, isBackwards, requiresReason, type GuardColumn, type PolicyRef } from './moveGuard.js';

const policy = (id: string, kind: 'enter' | 'leave', columnId = 'c1'): PolicyRef => ({
  id,
  kind,
  label: `policy ${id}`,
  columnId,
  columnName: 'Column',
});

const col = (over: Partial<GuardColumn> & { id: string }): GuardColumn => ({
  laneId: 'laneA',
  position: 0,
  semantic: null,
  ...over,
});

const base = {
  fromColumn: col({ id: 'a', position: 0 }),
  toColumn: col({ id: 'b', position: 1 }),
  leavePolicies: [] as PolicyRef[],
  enterPolicies: [] as PolicyRef[],
  checkedIds: [] as string[],
  override: {},
};

describe('applicablePolicies', () => {
  it('is leave-then-enter and keeps the configured order', () => {
    const leave = [policy('l1', 'leave'), policy('l2', 'leave')];
    const enter = [policy('e1', 'enter'), policy('e2', 'enter')];
    expect(applicablePolicies(leave, enter).map((p) => p.id)).toEqual(['l1', 'l2', 'e1', 'e2']);
  });

  it('ignores a policy filed under the wrong kind', () => {
    expect(applicablePolicies([policy('x', 'enter')], [policy('y', 'leave')])).toEqual([]);
  });
});

describe('isBackwards', () => {
  it('only an earlier position in the SAME lane counts', () => {
    expect(isBackwards(col({ id: 'a', position: 2 }), col({ id: 'b', position: 1 }))).toBe(true);
    expect(isBackwards(col({ id: 'a', position: 1 }), col({ id: 'b', position: 2 }))).toBe(false);
    expect(isBackwards(col({ id: 'a', position: 1 }), col({ id: 'b', position: 1 }))).toBe(false);
  });

  it('across lanes there is no shared order, so nothing is backwards', () => {
    expect(isBackwards(col({ id: 'a', position: 5 }), col({ id: 'b', laneId: 'laneB', position: 0 }))).toBe(false);
  });

  it('discard is exempt in BOTH directions', () => {
    // in: throwing a card away is a terminal exit, wherever the bin sits
    expect(isBackwards(col({ id: 'a', position: 5 }), col({ id: 'bin', position: 1, semantic: 'discard' }))).toBe(false);
    // out: resurrecting it has no meaningful position to measure against
    expect(isBackwards(col({ id: 'bin', position: 9, semantic: 'discard' }), col({ id: 'open', position: 0 }))).toBe(false);
  });
});

describe('evaluateMove', () => {
  it('unticked policies block the move', () => {
    const r = evaluateMove({ ...base, leavePolicies: [policy('l1', 'leave')] });
    expect(r.blocked).toBe(true);
    expect(r.unmet.map((p) => p.id)).toEqual(['l1']);
    expect(r.overrideUsed).toBe(false);
  });

  it('every applicable policy ticked lets the move through', () => {
    const r = evaluateMove({
      ...base,
      leavePolicies: [policy('l1', 'leave')],
      enterPolicies: [policy('e1', 'enter')],
      checkedIds: ['l1', 'e1'],
    });
    expect(r.blocked).toBe(false);
    expect(r.unmet).toEqual([]);
    expect(r.overrideUsed).toBe(false);
  });

  it('a partially ticked list still blocks', () => {
    const r = evaluateMove({
      ...base,
      leavePolicies: [policy('l1', 'leave')],
      enterPolicies: [policy('e1', 'enter')],
      checkedIds: ['l1'],
    });
    expect(r.blocked).toBe(true);
    expect(r.unmet.map((p) => p.id)).toEqual(['e1']);
  });

  it('policy override passes the move and reports what was skipped', () => {
    const r = evaluateMove({
      ...base,
      leavePolicies: [policy('l1', 'leave'), policy('l2', 'leave')],
      checkedIds: ['l1'],
      override: { policies: true },
    });
    expect(r.blocked).toBe(false);
    expect(r.skipped.map((p) => p.id)).toEqual(['l2']);
    expect(r.overrideUsed).toBe(true);
  });

  it('an override that skipped nothing is not recorded as an override', () => {
    const r = evaluateMove({
      ...base,
      leavePolicies: [policy('l1', 'leave')],
      checkedIds: ['l1'],
      override: { policies: true, backwards: true, lane: true },
    });
    expect(r.overrideUsed).toBe(false);
    expect(r.skipped).toEqual([]);
  });

  it('backwards moves are blocked even with no policies', () => {
    const r = evaluateMove({ ...base, fromColumn: col({ id: 'a', position: 3 }), toColumn: col({ id: 'b', position: 1 }) });
    expect(r.backwards).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it('a policy override alone does not unlock a backwards move', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: col({ id: 'a', position: 3 }),
      toColumn: col({ id: 'b', position: 1 }),
      leavePolicies: [policy('l1', 'leave')],
      override: { policies: true },
    });
    expect(r.blocked).toBe(true);
  });

  it('backwards override unlocks it and counts as an override', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: col({ id: 'a', position: 3 }),
      toColumn: col({ id: 'b', position: 1 }),
      override: { backwards: true },
    });
    expect(r.blocked).toBe(false);
    expect(r.overrideUsed).toBe(true);
    expect(r.skipped).toEqual([]);
  });

  it('a lane change is blocked by default', () => {
    const r = evaluateMove({ ...base, toColumn: col({ id: 'b', laneId: 'laneB', position: 0 }) });
    expect(r.laneMove).toBe(true);
    expect(r.blocked).toBe(true);
    // no shared column order across lanes, so it is not ALSO a backwards move
    expect(r.backwards).toBe(false);
  });

  it('a lane override unlocks it and counts as an override', () => {
    const r = evaluateMove({
      ...base,
      toColumn: col({ id: 'b', laneId: 'laneB', position: 0 }),
      override: { lane: true },
    });
    expect(r.blocked).toBe(false);
    expect(r.laneMove).toBe(true);
    expect(r.overrideUsed).toBe(true);
  });

  it('a backwards override does not unlock a lane change', () => {
    const r = evaluateMove({
      ...base,
      toColumn: col({ id: 'b', laneId: 'laneB', position: 0 }),
      override: { backwards: true, policies: true },
    });
    expect(r.blocked).toBe(true);
  });

  it('all three gates need all three overrides', () => {
    const input = {
      ...base,
      fromColumn: col({ id: 'a', position: 3 }),
      toColumn: col({ id: 'b', laneId: 'laneB', position: 1 }),
      leavePolicies: [policy('l1', 'leave')],
    };
    // cross-lane, so backwards never fires — policies + lane are what matter
    expect(evaluateMove({ ...input, override: { lane: true } }).blocked).toBe(true);
    const both = evaluateMove({ ...input, override: { lane: true, policies: true } });
    expect(both.blocked).toBe(false);
    expect(both.skipped.map((p) => p.id)).toEqual(['l1']);
  });

  it('discarding is flagged and needs no direction override, wherever the bin sits', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: col({ id: 'a', position: 4 }),
      toColumn: col({ id: 'bin', position: 1, semantic: 'discard' }),
    });
    expect(r.discarding).toBe(true);
    expect(r.backwards).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.overrideUsed).toBe(false);
  });

  it('discard columns still enforce their policies', () => {
    const r = evaluateMove({
      ...base,
      toColumn: col({ id: 'bin', position: 9, semantic: 'discard' }),
      enterPolicies: [policy('e1', 'enter')],
    });
    expect(r.blocked).toBe(true);
    expect(r.unmet.map((p) => p.id)).toEqual(['e1']);
  });

  it('coming back out of discard is allowed without an override', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: col({ id: 'bin', position: 9, semantic: 'discard' }),
      toColumn: col({ id: 'open', position: 0, semantic: 'open' }),
    });
    expect(r.blocked).toBe(false);
    expect(r.backwards).toBe(false);
  });

  it('a same-column reorder is never gated', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: col({ id: 'a', position: 2 }),
      toColumn: col({ id: 'a', position: 2 }),
      leavePolicies: [policy('l1', 'leave')],
    });
    expect(r.columnChanged).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.applicable).toEqual([]);
  });
});

describe('requiresReason', () => {
  it('is true for any exercised override', () => {
    const r = evaluateMove({ ...base, toColumn: col({ id: 'b', laneId: 'laneB' }), override: { lane: true } });
    expect(requiresReason(r)).toBe(true);
  });

  it('is true for a discard even when nothing was overridden', () => {
    const r = evaluateMove({ ...base, toColumn: col({ id: 'bin', position: 5, semantic: 'discard' }) });
    expect(r.overrideUsed).toBe(false);
    expect(requiresReason(r)).toBe(true);
  });

  it('is false for an ordinary forward move', () => {
    expect(requiresReason(evaluateMove(base))).toBe(false);
  });
});
