import { describe, it, expect } from 'vitest';
import {
  onClosed,
  onReopened,
  onOverdueCheck,
  reopenIsDue,
  nextOccurrence,
  plainDueOverdue,
  describeRule,
  initialState,
} from './recurrence.js';
import type { RecurrenceRule } from '@kan-do/shared';

const daily: RecurrenceRule = { freq: 'daily', interval: 1 };
const every2Weeks: RecurrenceRule = { freq: 'weekly', interval: 2 };
const monThu: RecurrenceRule = { freq: 'weekly', interval: 1, byWeekday: [0, 3] };
const monthly15: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: 15 };

const T = (s: string) => new Date(s);

describe('nextOccurrence', () => {
  it('daily: next day', () => {
    expect(nextOccurrence(daily, T('2026-08-07T10:00:00Z'))).toEqual(T('2026-08-08T10:00:00Z'));
  });

  it('every 2 weeks: +14 days', () => {
    expect(nextOccurrence(every2Weeks, T('2026-08-07T10:00:00Z'))).toEqual(T('2026-08-21T10:00:00Z'));
  });

  it('Mon+Thu: from a Friday close, next is Monday', () => {
    // 2026-08-07 is a Friday
    const next = nextOccurrence(monThu, T('2026-08-07T10:00:00Z'))!;
    expect(next.getUTCDay()).toBe(1); // Monday
    expect(next.toISOString().slice(0, 10)).toBe('2026-08-10');
  });

  it('Mon+Thu: from a Monday close, next is Thursday (strictly after)', () => {
    const next = nextOccurrence(monThu, T('2026-08-10T10:00:00Z'))!;
    expect(next.getUTCDay()).toBe(4);
    expect(next.toISOString().slice(0, 10)).toBe('2026-08-13');
  });

  it('monthly on day 15: from Aug 20, next is Sep 15', () => {
    const next = nextOccurrence(monthly15, T('2026-08-20T10:00:00Z'))!;
    expect(next.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('monthly on day 31 skips short months', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: 31 };
    const next = nextOccurrence(rule, T('2026-08-31T10:00:00Z'))!;
    // September has 30 days -> October 31
    expect(next.toISOString().slice(0, 10)).toBe('2026-10-31');
  });
});

describe('state machine: close -> reopen -> overdue', () => {
  it('closing schedules reopen at closed_at + interval', () => {
    const s = onClosed(daily, T('2026-08-07T09:00:00Z'));
    expect(s.status).toBe('awaiting_reopen');
    expect(s.closedAt).toEqual(T('2026-08-07T09:00:00Z'));
    expect(s.reopenAt).toEqual(T('2026-08-08T09:00:00Z'));
    expect(s.reopenedAt).toBeNull();
    expect(s.overdueAt).toBeNull();
  });

  it('reopen is due only at/after reopenAt and only in awaiting_reopen', () => {
    const s = onClosed(daily, T('2026-08-07T09:00:00Z'));
    expect(reopenIsDue(s, T('2026-08-08T08:59:59Z'))).toBe(false);
    expect(reopenIsDue(s, T('2026-08-08T09:00:00Z'))).toBe(true);
    expect(reopenIsDue(initialState, T('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('reopening arms overdue deadline relative to reopen time, not close time', () => {
    // closed Friday, reopened Monday (Mon+Thu rule): deadline = Thursday
    const s = onReopened(monThu, T('2026-08-10T09:00:00Z'));
    expect(s.status).toBe('reopened');
    expect(s.reopenedAt).toEqual(T('2026-08-10T09:00:00Z'));
    expect(s.overdueAt!.toISOString().slice(0, 10)).toBe('2026-08-13');
    expect(s.closedAt).toBeNull();
    expect(s.reopenAt).toBeNull();
  });

  it('reopened card NOT closed before deadline -> overdue', () => {
    const s = onReopened(daily, T('2026-08-10T09:00:00Z'));
    const after = onOverdueCheck(s, T('2026-08-11T09:00:00Z'));
    expect(after.status).toBe('overdue');
  });

  it('reopened card checked before deadline stays reopened', () => {
    const s = onReopened(daily, T('2026-08-10T09:00:00Z'));
    expect(onOverdueCheck(s, T('2026-08-11T08:59:59Z')).status).toBe('reopened');
  });

  it('closing a reopened card before deadline resets the cycle', () => {
    const reopened = onReopened(daily, T('2026-08-10T09:00:00Z'));
    const closed = onClosed(daily, T('2026-08-10T15:00:00Z'));
    expect(reopened.status).toBe('reopened');
    expect(closed.status).toBe('awaiting_reopen');
    expect(closed.reopenAt).toEqual(T('2026-08-11T15:00:00Z'));
    expect(closed.overdueAt).toBeNull(); // overdue clock cleared
  });

  it('closing an already-overdue card clears overdue and reschedules', () => {
    const overdue = onOverdueCheck(onReopened(daily, T('2026-08-10T09:00:00Z')), T('2026-08-12T09:00:00Z'));
    expect(overdue.status).toBe('overdue');
    const closed = onClosed(daily, T('2026-08-12T10:00:00Z'));
    expect(closed.status).toBe('awaiting_reopen');
  });

  it('overdue check is a no-op for awaiting_reopen and open states', () => {
    const waiting = onClosed(daily, T('2026-08-07T09:00:00Z'));
    expect(onOverdueCheck(waiting, T('2030-01-01T00:00:00Z')).status).toBe('awaiting_reopen');
    expect(onOverdueCheck(initialState, T('2030-01-01T00:00:00Z')).status).toBe('open');
  });

  it('overdue is relative to time-since-reopen: late close -> late next deadline', () => {
    // every 2 weeks; reopened Aug 21, deadline Sep 4 regardless of original close
    const s = onReopened(every2Weeks, T('2026-08-21T09:00:00Z'));
    expect(s.overdueAt).toEqual(T('2026-09-04T09:00:00Z'));
  });
});

describe('non-recurring due dates', () => {
  it('past due + not done -> overdue', () => {
    expect(plainDueOverdue(T('2026-08-01T00:00:00Z'), false, T('2026-08-07T00:00:00Z'))).toBe(true);
  });
  it('past due but in done column -> not overdue', () => {
    expect(plainDueOverdue(T('2026-08-01T00:00:00Z'), true, T('2026-08-07T00:00:00Z'))).toBe(false);
  });
  it('no due date -> never overdue', () => {
    expect(plainDueOverdue(null, false, T('2026-08-07T00:00:00Z'))).toBe(false);
  });
  it('not yet due -> not overdue', () => {
    expect(plainDueOverdue(T('2026-08-08T00:00:00Z'), false, T('2026-08-07T00:00:00Z'))).toBe(false);
  });
});

describe('describeRule (plain language)', () => {
  it('common cases', () => {
    expect(describeRule(daily)).toBe('every day');
    expect(describeRule(every2Weeks)).toBe('every 2 weeks');
    expect(describeRule(monThu)).toBe('every Monday and Thursday');
    expect(describeRule(monthly15)).toBe('every month on day 15');
    expect(describeRule({ freq: 'yearly', interval: 1 })).toBe('every year');
  });
});
