import { useQuery } from '@tanstack/react-query';
import { post } from '../api';

export interface FactField {
  key: string;
  label: string;
  kind: 'dimension' | 'metric';
  format: 'text' | 'count' | 'duration';
}

export interface FactsResponse {
  fields: FactField[];
  rows: Record<string, unknown>[];
  total: number;
  boardCount: number;
}

/** What each selected column is doing in the widget. */
export type FieldRole = 'group' | 'then' | 'measure';

export interface Selection {
  /** dimension keys, in the order they were picked (max 2) */
  groups: string[];
  /** metric keys, in the order they were picked (1 = single series, 2+ = multi) */
  measures: string[];
}

/**
 * Spreadsheet-style data browser.
 *
 * Instead of choosing abstract field names out of dropdowns, the user sees the
 * actual rows behind their widget and clicks the column headers they want:
 * text columns become grouping, numeric columns become measures. What you point
 * at is what gets plotted.
 *
 * Rows come from the same access-scoped collector the charts use, so this can
 * never show data a saved widget could not.
 */
export default function FieldBrowser({
  boardId,
  selection,
  onChange,
  maxGroups = 2,
  maxMeasures = 6,
}: {
  boardId: string;
  selection: Selection;
  onChange: (next: Selection) => void;
  maxGroups?: number;
  maxMeasures?: number;
}) {
  const { data, error } = useQuery<FactsResponse>({
    queryKey: ['facts', boardId],
    queryFn: () => post('/api/me/dashboard/facts', { boardIds: [boardId], limit: 200 }),
  });

  const roleOf = (field: FactField): FieldRole | null => {
    if (field.kind === 'metric') return selection.measures.includes(field.key) ? 'measure' : null;
    const i = selection.groups.indexOf(field.key);
    return i === 0 ? 'group' : i > 0 ? 'then' : null;
  };

  const toggle = (field: FactField) => {
    if (field.kind === 'metric') {
      const picked = selection.measures.includes(field.key);
      const measures = picked
        ? selection.measures.filter((k) => k !== field.key)
        : [...selection.measures, field.key].slice(-maxMeasures);
      // never leave a widget with nothing to measure
      onChange({ ...selection, measures: measures.length ? measures : ['count'] });
      return;
    }
    const picked = selection.groups.includes(field.key);
    const groups = picked
      ? selection.groups.filter((k) => k !== field.key)
      : [...selection.groups, field.key].slice(-maxGroups);
    // and never with nothing to group by
    onChange({ ...selection, groups: groups.length ? groups : [field.key] });
  };

  if (error)
    return (
      <p role="alert" className="text-sm text-red-700">
        ⚠ Could not load the data: {String(error)}
      </p>
    );
  if (!data) return <div className="h-40 animate-pulse bg-gray-100 rounded" aria-busy="true" />;

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        Click a column header to use it. <strong>Text columns</strong> group the data (up to {maxGroups});{' '}
        <strong>number columns</strong> are what gets measured (pick several to plot them together).
      </p>

      <div className="border rounded overflow-auto max-h-72">
        <table className="text-xs border-collapse">
          <thead className="sticky top-0 bg-white shadow-sm">
            <tr>
              {data.fields.map((f) => {
                const role = roleOf(f);
                return (
                  <th key={f.key} className="p-0 border-b border-r last:border-r-0 align-top">
                    <button
                      type="button"
                      onClick={() => toggle(f)}
                      aria-pressed={role !== null}
                      title={`${f.label} — ${f.kind === 'metric' ? 'measurable number' : 'groupable text'}. Click to ${
                        role ? 'remove' : 'use'
                      }.`}
                      className={`w-full h-full text-left px-2 py-1.5 whitespace-nowrap transition-colors ${
                        role === 'group'
                          ? 'bg-slate-800 text-white'
                          : role === 'then'
                            ? 'bg-slate-500 text-white'
                            : role === 'measure'
                              ? 'bg-emerald-700 text-white'
                              : 'hover:bg-gray-100'
                      }`}
                    >
                      <span className="block font-semibold">{f.label}</span>
                      <span className={`block text-[10px] ${role ? 'text-white/80' : 'text-gray-400'}`}>
                        {role === 'group'
                          ? 'GROUP BY'
                          : role === 'then'
                            ? 'THEN BY'
                            : role === 'measure'
                              ? 'MEASURE'
                              : f.kind === 'metric'
                                ? '123'
                                : 'abc'}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i} className="odd:bg-gray-50">
                {data.fields.map((f) => (
                  <td
                    key={f.key}
                    className={`px-2 py-1 border-b border-r last:border-r-0 whitespace-nowrap ${
                      roleOf(f) ? 'bg-amber-50 font-medium' : ''
                    } ${f.kind === 'metric' ? 'text-right tabular-nums' : ''}`}
                  >
                    {formatCell(row[f.key], f.format)}
                  </td>
                ))}
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={data.fields.length} className="px-2 py-6 text-center text-gray-500">
                  No cards on this board yet — the widget will fill in as work arrives.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        {data.rows.length < data.total
          ? `Showing the first ${data.rows.length} of ${data.total} cards. The widget always uses all of them.`
          : `${data.total} card${data.total === 1 ? '' : 's'}, one row each.`}
      </p>
    </div>
  );
}

function formatCell(value: unknown, format: FactField['format']): string {
  if (value === null || value === undefined || value === '') return '—';
  if (format === 'duration') {
    const h = Number(value) / 3_600_000;
    return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
  }
  if (format === 'count') return String(Math.round(Number(value)));
  return String(value);
}
