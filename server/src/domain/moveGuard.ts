/**
 * Move guard — pure rules deciding whether a card may leave one column for
 * another. No I/O: the service layer loads the policies and progress (already
 * tenancy-scoped) and feeds them in.
 *
 * Two independent gates:
 *  1. policies  — the source column's 'leave' checklist plus the target
 *                 column's 'enter' checklist must all be ticked.
 *  2. direction — a card may never move to an earlier column in the board's
 *                 configured order.
 *
 * Either gate can be overridden deliberately; the caller records the override.
 */
import type { PolicyRef, MoveBlockedDetails } from '@kan-do/shared';

export type { PolicyRef, MoveBlockedDetails };

export interface MoveGuardInput {
  fromColumn: { id: string; position: number };
  toColumn: { id: string; position: number };
  /** 'leave' policies of the source column */
  leavePolicies: PolicyRef[];
  /** 'enter' policies of the target column */
  enterPolicies: PolicyRef[];
  /** policy ids already ticked on the card (persisted progress + this attempt) */
  checkedIds: readonly string[];
  override: { policies?: boolean; backwards?: boolean };
}

export interface MoveGuardResult {
  /** the move changes column at all — a same-column reorder is never gated */
  columnChanged: boolean;
  backwards: boolean;
  applicable: PolicyRef[];
  unmet: PolicyRef[];
  /** true when the caller must refuse the move */
  blocked: boolean;
  /** policies the caller is knowingly skipping (empty unless overriding) */
  skipped: PolicyRef[];
  /** an override was actually exercised — write an audit row */
  overrideUsed: boolean;
}

/**
 * The policies that apply to a move: everything the card must satisfy to leave
 * where it is, plus everything it must satisfy to arrive where it is going.
 * Leave-then-enter so the checklist reads chronologically; within each group the
 * caller's order is preserved (the service loads them by configured position).
 */
export function applicablePolicies(leavePolicies: PolicyRef[], enterPolicies: PolicyRef[]): PolicyRef[] {
  return [...leavePolicies.filter((p) => p.kind === 'leave'), ...enterPolicies.filter((p) => p.kind === 'enter')];
}

/** Backwards = the target sits earlier in the board's column order. */
export function isBackwards(fromPosition: number, toPosition: number): boolean {
  return toPosition < fromPosition;
}

export function evaluateMove(input: MoveGuardInput): MoveGuardResult {
  const columnChanged = input.fromColumn.id !== input.toColumn.id;
  if (!columnChanged) {
    return {
      columnChanged: false,
      backwards: false,
      applicable: [],
      unmet: [],
      blocked: false,
      skipped: [],
      overrideUsed: false,
    };
  }

  const backwards = isBackwards(input.fromColumn.position, input.toColumn.position);
  const applicable = applicablePolicies(input.leavePolicies, input.enterPolicies);
  const checked = new Set(input.checkedIds);
  const unmet = applicable.filter((p) => !checked.has(p.id));

  const policyBlock = unmet.length > 0 && !input.override.policies;
  const directionBlock = backwards && !input.override.backwards;

  // an override only counts as "used" when it actually let something through:
  // ticking every box then also sending override:true is not an override
  const skipped = unmet.length > 0 && input.override.policies ? unmet : [];
  const overrideUsed = skipped.length > 0 || (backwards && Boolean(input.override.backwards));

  return {
    columnChanged: true,
    backwards,
    applicable,
    unmet,
    blocked: policyBlock || directionBlock,
    skipped,
    overrideUsed,
  };
}

/** Shape handed back to the client on a 409 so it can render the checklist. */
export function blockedDetails(result: MoveGuardResult, checkedIds: readonly string[]): MoveBlockedDetails {
  return {
    backwards: result.backwards,
    applicable: result.applicable,
    unmet: result.unmet,
    checkedIds: [...checkedIds],
  };
}
