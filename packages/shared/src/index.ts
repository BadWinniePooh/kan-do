export type Role = 'global_admin' | 'org_admin' | 'user';

/**
 * Fixed column meanings; display names stay user-configurable.
 *  - 'open'    : queue / not started (mandatory, one per lane)
 *  - 'done'    : completed successfully (mandatory, one per lane)
 *  - 'discard' : finished but reverted (optional) — NOT a completed outcome,
 *                and recurrence stops while a card rests here
 */
export type ColumnSemantic = 'open' | 'done' | 'discard' | null;

/** How a card's life ended (or that it hasn't) — the honest completion split. */
export type CardOutcome = 'done' | 'discarded' | 'active';

/**
 * Column policy checklists.
 *  - 'leave': must be satisfied to move a card OUT of the column
 *  - 'enter': must be satisfied to move a card INTO the column
 */
export type PolicyKind = 'enter' | 'leave';

export interface PolicyRef {
  id: string;
  kind: PolicyKind;
  label: string;
  columnId: string;
  columnName: string;
}

/** An unresolved reason a card cannot progress. */
export interface BlockerRef {
  id: string;
  reason: string;
  startedAt: string;
}

/** Payload of the 409 a blocked move returns, so the UI can show the checklist. */
export interface MoveBlockedDetails {
  backwards: boolean;
  /** the move crosses into another lane — blocked by default */
  laneMove: boolean;
  /** blockers still open on the card, holding it in place */
  activeBlockers: BlockerRef[];
  /** every policy that applies to this move (source 'leave' + target 'enter') */
  applicable: PolicyRef[];
  /** the subset still unticked */
  unmet: PolicyRef[];
  /** policy ids already ticked and persisted on the card */
  checkedIds: string[];
}

/**
 * Plain-language recurrence rule built by the UI recurrence builder.
 * Serialized to an iCal RRULE string on the server (single source of truth
 * for scheduling math). Users never see RRULE syntax.
 */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** every N days/weeks/months/years */
  interval: number;
  /** weekly only: 0=Mon .. 6=Sun (iCal order) */
  byWeekday?: number[];
  /** monthly only: day of month 1..31 */
  byMonthDay?: number;
}

export type RecurrenceStatus =
  | 'open'            // open, clock not running
  | 'awaiting_reopen' // closed, will reopen at reopen_at
  | 'reopened'        // auto-reopened, must be closed before overdue_at
  | 'overdue';        // reopened and not closed in time

export type OwnerBadge =
  | { kind: 'user'; userId: string; displayName: string; avatarUrl: string | null; initials: string }
  | { kind: 'external'; externalOwnerId: string; displayName: string; initials: string };

export type NotificationEvent = 'overdue' | 'reopen';
export type NotificationChannel = 'inapp' | 'email' | 'push';

export interface MetricDefs {
  /** created -> first arrival in a done-mapped column */
  leadTimeMs: number | null;
  /** first departure from an open-mapped column -> first arrival in done */
  cycleTimeMs: number | null;
  /** total time spent in open-mapped columns */
  waitingTimeMs: number | null;
  /** columnId -> total ms spent in that column */
  perColumnMs: Record<string, number>;
}

/** Server->client realtime events, one Socket.IO room per board */
export type BoardEvent =
  | { type: 'card.created' | 'card.updated' | 'card.moved' | 'card.deleted'; cardId: string }
  | { type: 'column.changed' | 'lane.changed' }
  | { type: 'board.updated' };

export function initialsOf(displayName: string): string {
  const caps = displayName.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 3).join('');
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]!.toUpperCase()).join('');
  return displayName.slice(0, 2).toUpperCase();
}
