/**
 * Recurrence engine — pure logic, no I/O.
 *
 * Lifecycle (fixed semantics):
 *  1. Card moved to a done-mapped column  -> record closedAt, schedule reopen
 *     at the next RRULE occurrence strictly after closedAt.
 *  2. At reopenAt the card returns to the open-mapped column -> record
 *     reopenedAt, arm an overdue deadline at the next occurrence strictly
 *     after reopenedAt.
 *  3. If the card is not closed again before the deadline, it is overdue.
 *
 * "interval" is therefore always time-to-next-occurrence relative to the last
 * close/reopen, never a fixed calendar due date.
 */
import { RRule, Weekday } from 'rrule';
import type { RecurrenceRule, RecurrenceStatus } from '@kan-do/shared';

export interface RecurrenceState {
  status: RecurrenceStatus;
  closedAt: Date | null;
  /** when the scheduler must move the card back to open */
  reopenAt: Date | null;
  reopenedAt: Date | null;
  /** deadline: close again before this or the card is overdue */
  overdueAt: Date | null;
}

export const initialState: RecurrenceState = {
  status: 'open',
  closedAt: null,
  reopenAt: null,
  reopenedAt: null,
  overdueAt: null,
};

const WEEKDAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];

export function toRRule(rule: RecurrenceRule, dtstart: Date): RRule {
  const freqMap = {
    daily: RRule.DAILY,
    weekly: RRule.WEEKLY,
    monthly: RRule.MONTHLY,
    yearly: RRule.YEARLY,
  } as const;
  return new RRule({
    freq: freqMap[rule.freq],
    interval: Math.max(1, rule.interval),
    byweekday:
      rule.freq === 'weekly' && rule.byWeekday?.length
        ? rule.byWeekday.map((d): Weekday => WEEKDAYS[d]!)
        : undefined,
    bymonthday: rule.freq === 'monthly' && rule.byMonthDay ? rule.byMonthDay : undefined,
    dtstart,
  });
}

/** Next occurrence strictly after `after`, or null if the rule yields none. */
export function nextOccurrence(rule: RecurrenceRule, after: Date): Date | null {
  return toRRule(rule, after).after(after, false);
}

/** Card entered a done-mapped column. Also used to close an overdue/reopened card. */
export function onClosed(rule: RecurrenceRule, now: Date): RecurrenceState {
  const reopenAt = nextOccurrence(rule, now);
  return {
    status: reopenAt ? 'awaiting_reopen' : 'open',
    closedAt: now,
    reopenAt,
    reopenedAt: null,
    overdueAt: null,
  };
}

/**
 * Scheduler fired the reopen (or a user manually dragged the closed card back
 * to open — same effect: the overdue clock starts now).
 */
export function onReopened(rule: RecurrenceRule, now: Date): RecurrenceState {
  const overdueAt = nextOccurrence(rule, now);
  return {
    status: 'reopened',
    closedAt: null,
    reopenAt: null,
    reopenedAt: now,
    overdueAt,
  };
}

/** Periodic/deadline check. Only a reopened card past its deadline flips. */
export function onOverdueCheck(state: RecurrenceState, now: Date): RecurrenceState {
  if (state.status === 'reopened' && state.overdueAt && now >= state.overdueAt) {
    return { ...state, status: 'overdue' };
  }
  return state;
}

/** True when the scheduler should actually perform a pending reopen. */
export function reopenIsDue(state: RecurrenceState, now: Date): boolean {
  return state.status === 'awaiting_reopen' && state.reopenAt !== null && now >= state.reopenAt;
}

/** Non-recurring card overdue rule: past due date and not in a done column. */
export function plainDueOverdue(dueDate: Date | null, inDoneColumn: boolean, now: Date): boolean {
  return dueDate !== null && !inDoneColumn && now > dueDate;
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Plain-language description, used in card badges and notification text. */
export function describeRule(rule: RecurrenceRule): string {
  const n = Math.max(1, rule.interval);
  const every = (unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  switch (rule.freq) {
    case 'daily':
      return every('day');
    case 'weekly': {
      const base = every('week');
      if (rule.byWeekday?.length) {
        const days = rule.byWeekday.map((d) => WEEKDAY_NAMES[d]).join(' and ');
        return n === 1 ? `every ${days}` : `${base} on ${days}`;
      }
      return base;
    }
    case 'monthly':
      return rule.byMonthDay ? `${every('month')} on day ${rule.byMonthDay}` : every('month');
    case 'yearly':
      return every('year');
  }
}
