import type { RecurrenceRule } from '@kan-do/shared';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Same plain-language rendering the server uses for notifications. */
export function describeRulePlain(rule: RecurrenceRule): string {
  const n = Math.max(1, rule.interval);
  const every = (unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  switch (rule.freq) {
    case 'daily':
      return every('day');
    case 'weekly': {
      if (rule.byWeekday?.length) {
        const days = rule.byWeekday.map((d) => DAYS[d]).join(' and ');
        return n === 1 ? `every ${days}` : `${every('week')} on ${days}`;
      }
      return every('week');
    }
    case 'monthly':
      return rule.byMonthDay ? `${every('month')} on day ${rule.byMonthDay}` : every('month');
    case 'yearly':
      return every('year');
  }
}
