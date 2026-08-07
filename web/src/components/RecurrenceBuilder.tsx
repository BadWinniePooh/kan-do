import type { RecurrenceRule } from '@kan-do/shared';
import { describeRulePlain } from '../recurrenceText';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Plain-language recurrence builder. Produces a structured RecurrenceRule —
 * users never see RRULE syntax; the server converts to iCal RRULE semantics.
 */
export default function RecurrenceBuilder({
  value,
  onChange,
}: {
  value: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
}) {
  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onChange({ freq: 'weekly', interval: 1 })}
        className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50"
      >
        🔁 Make recurring…
      </button>
    );
  }

  const set = (patch: Partial<RecurrenceRule>) => onChange({ ...value, ...patch });

  return (
    <fieldset className="border rounded-lg p-3 space-y-2 bg-indigo-50/50">
      <legend className="text-sm font-medium px-1">Repeats {describeRulePlain(value)}</legend>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm">Every</span>
        <label className="sr-only" htmlFor="rec-interval">
          Interval
        </label>
        <input
          id="rec-interval"
          type="number"
          min={1}
          max={365}
          value={value.interval}
          onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
          className="w-16 border rounded px-2 py-1 text-sm"
        />
        <label className="sr-only" htmlFor="rec-freq">
          Frequency
        </label>
        <select
          id="rec-freq"
          value={value.freq}
          onChange={(e) =>
            set({ freq: e.target.value as RecurrenceRule['freq'], byWeekday: undefined, byMonthDay: undefined })
          }
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="daily">day(s)</option>
          <option value="weekly">week(s)</option>
          <option value="monthly">month(s)</option>
          <option value="yearly">year(s)</option>
        </select>
      </div>

      {value.freq === 'weekly' && (
        <div className="flex gap-1" role="group" aria-label="On which weekdays">
          {DAY_LABELS.map((label, i) => {
            const active = value.byWeekday?.includes(i) ?? false;
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const cur = new Set(value.byWeekday ?? []);
                  if (active) cur.delete(i);
                  else cur.add(i);
                  set({ byWeekday: cur.size ? [...cur].sort() : undefined });
                }}
                className={`text-xs rounded px-2 py-1 border ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white'}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {value.freq === 'monthly' && (
        <label className="text-sm flex items-center gap-2">
          On day
          <input
            type="number"
            min={1}
            max={31}
            value={value.byMonthDay ?? ''}
            placeholder="any"
            onChange={(e) => set({ byMonthDay: e.target.value ? Number(e.target.value) : undefined })}
            className="w-16 border rounded px-2 py-1"
          />
          of the month
        </label>
      )}

      <p className="text-xs text-gray-500">
        When done, this task automatically reopens after the period. If it isn't finished again in time, it's flagged
        overdue.
      </p>
      <button type="button" onClick={() => onChange(null)} className="text-xs text-red-700 underline">
        Remove recurrence
      </button>
    </fieldset>
  );
}
