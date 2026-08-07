import { describe, it, expect } from 'vitest';
import { applicablePolicies, evaluateMove, isBackwards, type PolicyRef } from './moveGuard.js';

const policy = (id: string, kind: 'enter' | 'leave', columnId = 'c1'): PolicyRef => ({
  id,
  kind,
  label: `policy ${id}`,
  columnId,
  columnName: 'Column',
});

const base = {
  fromColumn: { id: 'a', position: 0 },
  toColumn: { id: 'b', position: 1 },
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
  it('only an earlier target position counts', () => {
    expect(isBackwards(2, 1)).toBe(true);
    expect(isBackwards(1, 2)).toBe(false);
    expect(isBackwards(1, 1)).toBe(false);
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
      override: { policies: true, backwards: true },
    });
    expect(r.overrideUsed).toBe(false);
    expect(r.skipped).toEqual([]);
  });

  it('backwards moves are blocked even with no policies', () => {
    const r = evaluateMove({ ...base, fromColumn: { id: 'a', position: 3 }, toColumn: { id: 'b', position: 1 } });
    expect(r.backwards).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it('a policy override alone does not unlock a backwards move', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: { id: 'a', position: 3 },
      toColumn: { id: 'b', position: 1 },
      leavePolicies: [policy('l1', 'leave')],
      override: { policies: true },
    });
    expect(r.blocked).toBe(true);
  });

  it('backwards override unlocks it and counts as an override', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: { id: 'a', position: 3 },
      toColumn: { id: 'b', position: 1 },
      override: { backwards: true },
    });
    expect(r.blocked).toBe(false);
    expect(r.overrideUsed).toBe(true);
    expect(r.skipped).toEqual([]);
  });

  it('both gates need both overrides', () => {
    const input = {
      ...base,
      fromColumn: { id: 'a', position: 3 },
      toColumn: { id: 'b', position: 1 },
      leavePolicies: [policy('l1', 'leave')],
    };
    expect(evaluateMove({ ...input, override: { backwards: true } }).blocked).toBe(true);
    const both = evaluateMove({ ...input, override: { backwards: true, policies: true } });
    expect(both.blocked).toBe(false);
    expect(both.skipped.map((p) => p.id)).toEqual(['l1']);
  });

  it('a same-column reorder is never gated', () => {
    const r = evaluateMove({
      ...base,
      fromColumn: { id: 'a', position: 2 },
      toColumn: { id: 'a', position: 2 },
      leavePolicies: [policy('l1', 'leave')],
    });
    expect(r.columnChanged).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.applicable).toEqual([]);
  });
});
