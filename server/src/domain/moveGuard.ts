/**
 * Move guard — pure rules deciding whether a card may leave one column for
 * another. No I/O: the service layer loads the columns, policies and progress
 * (already tenancy-scoped) and feeds them in.
 *
 * Three independent gates:
 *  1. policies  — the source column's 'leave' checklist plus the target
 *                 column's 'enter' checklist must all be ticked.
 *  2. direction — a card may not move to an earlier column. Column order is
 *                 LANE-SCOPED, so this compares positions inside the card's own
 *                 lane; across lanes there is no shared order to compare and
 *                 the lane gate governs instead.
 *  3. lane      — moving a card to a different lane is not intended and is
 *                 blocked by default.
 *
 * Discard columns are exempt from the direction gate in BOTH directions:
 *  - moving IN is a terminal exit from the flow ("throw this away"), never a
 *    step backwards, wherever the discard column happens to sit;
 *  - moving OUT is a resurrection, and the position the card was discarded from
 *    carries no meaning to measure against.
 * Policies still apply to discard columns exactly like any other column.
 *
 * Every gate can be overridden deliberately; the caller records the override
 * together with the justification the user had to type.
 */
import type { PolicyRef, MoveBlockedDetails, ColumnSemantic } from '@kan-do/shared';

export type { PolicyRef, MoveBlockedDetails };

export interface GuardColumn {
  id: string;
  laneId: string;
  position: number;
  semantic: ColumnSemantic;
}

export interface MoveGuardInput {
  fromColumn: GuardColumn;
  toColumn: GuardColumn;
  /** 'leave' policies of the source column */
  leavePolicies: PolicyRef[];
  /** 'enter' policies of the target column */
  enterPolicies: PolicyRef[];
  /** policy ids already ticked on the card (persisted progress + this attempt) */
  checkedIds: readonly string[];
  override: { policies?: boolean; backwards?: boolean; lane?: boolean };
}

export interface MoveGuardResult {
  /** the move changes column at all — a same-column reorder is never gated */
  columnChanged: boolean;
  backwards: boolean;
  laneMove: boolean;
  /** the card is being thrown away (target is a discard column) */
  discarding: boolean;
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

/**
 * Backwards = an earlier position in the SAME lane's column order. Cross-lane
 * moves and anything touching a discard column are out of scope by design (see
 * the module comment).
 */
export function isBackwards(from: GuardColumn, to: GuardColumn): boolean {
  if (from.laneId !== to.laneId) return false;
  if (from.semantic === 'discard' || to.semantic === 'discard') return false;
  return to.position < from.position;
}

export function evaluateMove(input: MoveGuardInput): MoveGuardResult {
  const columnChanged = input.fromColumn.id !== input.toColumn.id;
  if (!columnChanged) {
    return {
      columnChanged: false,
      backwards: false,
      laneMove: false,
      discarding: false,
      applicable: [],
      unmet: [],
      blocked: false,
      skipped: [],
      overrideUsed: false,
    };
  }

  const backwards = isBackwards(input.fromColumn, input.toColumn);
  const laneMove = input.fromColumn.laneId !== input.toColumn.laneId;
  const discarding = input.toColumn.semantic === 'discard';
  const applicable = applicablePolicies(input.leavePolicies, input.enterPolicies);
  const checked = new Set(input.checkedIds);
  const unmet = applicable.filter((p) => !checked.has(p.id));

  const policyBlock = unmet.length > 0 && !input.override.policies;
  const directionBlock = backwards && !input.override.backwards;
  const laneBlock = laneMove && !input.override.lane;

  // an override only counts as "used" when it actually let something through:
  // ticking every box then also sending override:true is not an override
  const skipped = unmet.length > 0 && input.override.policies ? unmet : [];
  const overrideUsed =
    skipped.length > 0 || (backwards && Boolean(input.override.backwards)) || (laneMove && Boolean(input.override.lane));

  return {
    columnChanged: true,
    backwards,
    laneMove,
    discarding,
    applicable,
    unmet,
    blocked: policyBlock || directionBlock || laneBlock,
    skipped,
    overrideUsed,
  };
}

/** Shape handed back to the client on a 409 so it can render the checklist. */
export function blockedDetails(result: MoveGuardResult, checkedIds: readonly string[]): MoveBlockedDetails {
  return {
    backwards: result.backwards,
    laneMove: result.laneMove,
    applicable: result.applicable,
    unmet: result.unmet,
    checkedIds: [...checkedIds],
  };
}

/**
 * Does this move need a written justification? Overrides must explain
 * themselves, and so must discarding — "we threw this away" is exactly the
 * decision that is worthless in an audit without a why.
 */
export function requiresReason(result: MoveGuardResult): boolean {
  return result.overrideUsed || result.discarding;
}
