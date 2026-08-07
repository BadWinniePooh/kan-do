import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
  AreaChart,
  Area,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { get, post, put } from '../api';
import type { Board } from '../types';
import { TileSkeleton } from '../components/Loading';
import { useDismiss } from '../useDismiss';

/* Validated reference palette (dataviz skill). Slots assigned in fixed order. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const C = {
  series1: SERIES[0]!,
  critical: '#d03b3b',
  inkPrimary: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  surface: '#fcfcfb',
};

type WidgetId =
  | 'lead'
  | 'cycle'
  | 'waiting'
  | 'doneAge'
  | 'perColumn'
  | 'overdueCount'
  | 'throughput'
  | 'policyOverrides'
  | 'custom';

const DIMENSIONS = [
  'board',
  'column',
  'lane',
  'category',
  'owner',
  'recurrenceStatus',
  'createdMonth',
  'closedMonth',
  'overrideStatus',
] as const;
const METRICS = ['count', 'leadTimeMs', 'cycleTimeMs', 'waitingTimeMs', 'timeInColumnMs', 'overrideCount'] as const;
const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max', 'median'] as const;

type Dimension = (typeof DIMENSIONS)[number];
type Metric = (typeof METRICS)[number];
type Aggregation = (typeof AGGREGATIONS)[number];
type Viz = 'table' | 'bar' | 'line' | 'area' | 'pie';

/** One line/bar/area on a multi-series widget. */
interface SeriesDef {
  label: string;
  metric: Metric;
  aggregation: Aggregation;
  /** plot this series over its own dimension instead of the shared axis */
  dimension?: Dimension;
  /** running total along the axis — this is what makes a burnup a burnup */
  cumulative?: boolean;
}

interface CustomDef {
  title: string;
  dimensions: Dimension[];
  metric: Metric;
  aggregation: Aggregation;
  viz: Viz;
  /** present and non-empty => multi-series; dimensions[0] is the shared axis */
  series?: SeriesDef[];
  /** axis buckets to drop, e.g. 'Not done' on a month axis */
  omitKeys?: string[];
}

const isMulti = (def: CustomDef) => Boolean(def.series?.length);

interface LayoutItem {
  id: string;
  widget: WidgetId;
  w: number;
  h: number;
  def?: CustomDef;
}

interface Metrics {
  columns: { id: string; name: string; semantic: string | null }[];
  perCard: { cardId: string; title: string; leadTimeMs: number | null; cycleTimeMs: number | null; waitingTimeMs: number | null }[];
  doneEvents: { at: string }[];
  overdueCount: number;
  overrides: {
    total: number;
    backwardsMoves: number;
    policiesSkipped: number;
    recent: { id: string; cardId: string; at: string; backwards: boolean; actorName: string | null; skipped: { label: string; kind: string }[] }[];
  };
  aggregates: {
    meanLeadTimeMs: number | null;
    meanCycleTimeMs: number | null;
    meanWaitingTimeMs: number | null;
    meanDoneAgeMs: number | null;
    perColumnMeanMs: { columnId: string; name: string; meanMs: number | null }[];
  };
}

const BUILTIN_WIDGETS: { id: Exclude<WidgetId, 'custom'>; label: string }[] = [
  { id: 'lead', label: 'Mean lead time' },
  { id: 'cycle', label: 'Mean cycle time' },
  { id: 'waiting', label: 'Waiting before work starts' },
  { id: 'doneAge', label: 'Time since done' },
  { id: 'overdueCount', label: 'Overdue cards' },
  { id: 'perColumn', label: 'Time in work columns' },
  { id: 'throughput', label: 'Throughput (done/week)' },
  { id: 'policyOverrides', label: 'Policy overrides' },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { id: 'w1', widget: 'lead', w: 4, h: 1 },
  { id: 'w2', widget: 'cycle', w: 4, h: 1 },
  { id: 'w3', widget: 'overdueCount', w: 4, h: 1 },
  { id: 'w4', widget: 'perColumn', w: 6, h: 2 },
  { id: 'w5', widget: 'throughput', w: 6, h: 2 },
];

const DIM_LABELS: Record<string, string> = {
  board: 'Board',
  column: 'Column',
  lane: 'Lane',
  category: 'Category',
  owner: 'Owner',
  recurrenceStatus: 'Recurrence status',
  createdMonth: 'Created (month)',
  closedMonth: 'Closed (month)',
  overrideStatus: 'Policy override status',
};
const METRIC_LABELS: Record<string, string> = {
  count: 'Card count',
  leadTimeMs: 'Lead time',
  cycleTimeMs: 'Cycle time',
  waitingTimeMs: 'Waiting time',
  timeInColumnMs: 'Time in current column',
  overrideCount: 'Policy overrides',
};

/** A burnup needs two differently-dimensioned cumulative counts — preset it. */
const BURNUP_PRESET: Pick<CustomDef, 'dimensions' | 'viz' | 'series' | 'omitKeys'> = {
  dimensions: ['createdMonth'],
  viz: 'line',
  omitKeys: ['Not done'],
  series: [
    { label: 'Scope', metric: 'count', aggregation: 'count', dimension: 'createdMonth', cumulative: true },
    { label: 'Completed', metric: 'count', aggregation: 'count', dimension: 'closedMonth', cumulative: true },
  ],
};

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

const fmtValue = (metric: string, v: number | null) =>
  v === null ? '—' : metric === 'count' || metric === 'overrideCount' ? String(Math.round(v)) : fmtDuration(v);

export default function DashboardPage() {
  const qc = useQueryClient();
  const { data: boards = [] } = useQuery<Board[]>({ queryKey: ['boards'], queryFn: () => get('/api/boards') });
  const [boardId, setBoardId] = useState<string | null>(null);
  const activeBoard = boardId ?? boards[0]?.id ?? null;
  const [configOpen, setConfigOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState<LayoutItem | 'new' | null>(null);

  const { data: savedLayout } = useQuery<{ layout: LayoutItem[] | null }>({
    queryKey: ['dashboard-config', activeBoard],
    queryFn: () => get(`/api/me/dashboard?boardId=${activeBoard}`),
    enabled: !!activeBoard,
  });
  const layout = savedLayout?.layout?.length ? savedLayout.layout : DEFAULT_LAYOUT;

  const saveLayout = useMutation({
    mutationFn: (l: LayoutItem[]) => put('/api/me/dashboard', { boardId: activeBoard, layout: l }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard-config', activeBoard] }),
  });

  const { data: metrics, error } = useQuery<Metrics>({
    queryKey: ['metrics', activeBoard],
    queryFn: () => get(`/api/boards/${activeBoard}/metrics`),
    enabled: !!activeBoard,
  });

  const throughput = useMemo(() => {
    if (!metrics) return [];
    const byWeek = new Map<string, number>();
    for (const e of metrics.doneEvents) {
      const d = new Date(e.at);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = monday.toISOString().slice(0, 10);
      byWeek.set(key, (byWeek.get(key) ?? 0) + 1);
    }
    return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, count }));
  }, [metrics]);

  if (!activeBoard) return <p className="p-6 text-gray-500">Create a board first — the dashboard reads its history.</p>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <label className="sr-only" htmlFor="board-select">
          Board
        </label>
        <select
          id="board-select"
          value={activeBoard}
          onChange={(e) => setBoardId(e.target.value)}
          className="border rounded px-2 py-1 text-sm bg-white"
        >
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button onClick={() => setConfigOpen(!configOpen)} className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50">
          ⚙ Configure widgets
        </button>
        <button onClick={() => setBuilderOpen('new')} className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50">
          ＋ Custom widget
        </button>
      </div>

      {configOpen && (
        <WidgetConfig layout={layout} onChange={(l) => saveLayout.mutate(l)} onClose={() => setConfigOpen(false)} onEditCustom={setBuilderOpen} />
      )}

      {builderOpen && (
        <WidgetBuilder
          initial={builderOpen === 'new' ? null : builderOpen}
          boardId={activeBoard}
          onClose={() => setBuilderOpen(null)}
          onSave={(def, existing) => {
            const next = existing
              ? layout.map((l) => (l.id === existing.id ? { ...l, def } : l))
              : [...layout, { id: `c-${Date.now()}`, widget: 'custom' as const, w: 6, h: 2, def }];
            saveLayout.mutate(next);
            setBuilderOpen(null);
          }}
        />
      )}

      {error && (
        <p role="alert" className="text-red-700 text-sm">⚠ Could not load metrics: {String(error)}</p>
      )}
      {!metrics && !error ? (
        <TileSkeleton rows={3} />
      ) : !metrics ? null : (
        <div className="grid grid-cols-12 gap-4">
          {layout.map((item) => (
            <div key={item.id} className="col-span-12" style={{ gridColumn: `span ${item.w} / span ${item.w}` }}>
              <Widget widget={item.widget} def={item.def} metrics={metrics} throughput={throughput} boardId={activeBoard} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetConfig({
  layout,
  onChange,
  onClose,
  onEditCustom,
}: {
  layout: LayoutItem[];
  onChange: (l: LayoutItem[]) => void;
  onClose: () => void;
  onEditCustom: (item: LayoutItem) => void;
}) {
  return (
    <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm" role="region" aria-label="Dashboard configuration">
      <div className="flex flex-wrap gap-4">
        {BUILTIN_WIDGETS.map((w) => {
          const item = layout.find((l) => l.widget === w.id);
          return (
            <label key={w.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={!!item}
                onChange={(e) => {
                  if (e.target.checked) {
                    const wide = w.id === 'perColumn' || w.id === 'throughput';
                    onChange([...layout, { id: `w-${w.id}`, widget: w.id, w: wide ? 6 : 4, h: wide ? 2 : 1 }]);
                  } else {
                    onChange(layout.filter((l) => l.widget !== w.id));
                  }
                }}
              />
              {w.label}
            </label>
          );
        })}
      </div>
      <div className="mt-3 space-y-1">
        <p className="text-xs text-gray-500">Order & width (custom widgets are edited or removed here too):</p>
        {layout.map((item, i) => (
          <div key={item.id} className="flex items-center gap-2 text-sm">
            <button
              aria-label="Move widget up"
              disabled={i === 0}
              onClick={() => {
                const next = [...layout];
                [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                onChange(next);
              }}
              className="disabled:opacity-30"
            >
              ↑
            </button>
            <button
              aria-label="Move widget down"
              disabled={i === layout.length - 1}
              onClick={() => {
                const next = [...layout];
                [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                onChange(next);
              }}
              className="disabled:opacity-30"
            >
              ↓
            </button>
            <span className="flex-1">
              {item.widget === 'custom' ? `📊 ${item.def?.title ?? 'Custom'}` : BUILTIN_WIDGETS.find((w) => w.id === item.widget)?.label}
            </span>
            {item.widget === 'custom' && (
              <>
                <button className="text-xs underline" onClick={() => onEditCustom(item)}>
                  edit
                </button>
                <button className="text-xs underline text-red-700" onClick={() => onChange(layout.filter((l) => l.id !== item.id))}>
                  remove
                </button>
              </>
            )}
            <select
              aria-label="Widget width"
              value={item.w}
              onChange={(e) => onChange(layout.map((l) => (l.id === item.id ? { ...l, w: Number(e.target.value) } : l)))}
              className="border rounded px-1"
            >
              <option value={4}>⅓ width</option>
              <option value={6}>½ width</option>
              <option value={12}>full width</option>
            </select>
          </div>
        ))}
      </div>
      <button onClick={onClose} className="mt-3 text-sm border rounded px-3 py-1">
        Done
      </button>
    </div>
  );
}

/** Debounce so the live preview follows typing without one request per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

/**
 * Pivot-style builder: dimensions x metric(s) x aggregation, viz independent.
 *
 * Everything is previewed live against the user's real data while it is being
 * configured — the preview hits the same access-scoped query endpoint the saved
 * widget will, so it can never show more than the widget itself would.
 */
function WidgetBuilder({
  initial,
  boardId,
  onClose,
  onSave,
}: {
  initial: LayoutItem | null;
  boardId: string;
  onClose: () => void;
  onSave: (def: CustomDef, existing: LayoutItem | null) => void;
}) {
  const dialogRef = useDismiss<HTMLDivElement>(onClose);
  const [def, setDef] = useState<CustomDef>(
    initial?.def ?? { title: '', dimensions: ['category'], metric: 'count', aggregation: 'count', viz: 'bar' },
  );
  const set = (p: Partial<CustomDef>) => setDef({ ...def, ...p });
  const countMode = def.metric === 'count';
  const multi = isMulti(def);
  // preview trails the form by a beat so dragging a select doesn't fire a
  // request per intermediate value; the title is not part of the query
  const previewDef = useDebounced(def, 350);

  const setSeries = (next: SeriesDef[]) => set({ series: next });
  const enableMulti = () =>
    set({
      viz: def.viz === 'pie' || def.viz === 'table' ? 'line' : def.viz,
      dimensions: [def.dimensions[0]!],
      series: [
        { label: METRIC_LABELS[def.metric] ?? 'Series 1', metric: def.metric, aggregation: def.aggregation },
        { label: 'Card count', metric: 'count', aggregation: 'count' },
      ],
    });

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Custom widget builder"
        className="bg-white rounded-xl shadow-xl w-full max-w-3xl p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">{initial ? 'Edit widget' : 'New custom widget'}</h2>
        <label className="block text-sm">
          Title
          <input
            value={def.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="e.g. Cycle time by category"
            className="mt-1 w-full border rounded px-2 py-1"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            {multi ? 'Axis (group by)' : 'Group by'}
            <select
              value={def.dimensions[0]}
              onChange={(e) => set({ dimensions: [e.target.value as Dimension, ...(def.dimensions[1] ? [def.dimensions[1]!] : [])] })}
              className="mt-1 w-full border rounded px-2 py-1"
            >
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIM_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
          {!multi && (
            <label className="block text-sm">
              Then by (optional)
              <select
                value={def.dimensions[1] ?? ''}
                onChange={(e) => set({ dimensions: e.target.value ? [def.dimensions[0]!, e.target.value as Dimension] : [def.dimensions[0]!] })}
                className="mt-1 w-full border rounded px-2 py-1"
              >
                <option value="">—</option>
                {DIMENSIONS.filter((d) => d !== def.dimensions[0]).map((d) => (
                  <option key={d} value={d}>
                    {DIM_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!multi && (
            <>
              <label className="block text-sm">
                Metric
                <select
                  value={def.metric}
                  onChange={(e) => {
                    const metric = e.target.value as Metric;
                    set({ metric, aggregation: metric === 'count' ? 'count' : def.aggregation === 'count' ? 'avg' : def.aggregation });
                  }}
                  className="mt-1 w-full border rounded px-2 py-1"
                >
                  {METRICS.map((m) => (
                    <option key={m} value={m}>
                      {METRIC_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Aggregation
                <select
                  value={def.aggregation}
                  disabled={countMode}
                  onChange={(e) => set({ aggregation: e.target.value as Aggregation })}
                  className="mt-1 w-full border rounded px-2 py-1 disabled:opacity-50"
                  title={countMode ? 'Card count is always a count' : undefined}
                >
                  {AGGREGATIONS.filter((a) => a !== 'count').map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                  {countMode && <option value="count">count</option>}
                </select>
              </label>
            </>
          )}
        </div>

        <fieldset className="text-sm border-t pt-3">
          <legend className="sr-only">Series</legend>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-medium">Series</span>
            <div className="flex gap-2" role="radiogroup" aria-label="Number of series">
              <button
                type="button"
                role="radio"
                aria-checked={!multi}
                onClick={() => set({ series: undefined, omitKeys: undefined })}
                className={`border rounded px-3 py-1 ${!multi ? 'bg-slate-800 text-white' : 'bg-white'}`}
              >
                one
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={multi}
                onClick={() => (multi ? undefined : enableMulti())}
                className={`border rounded px-3 py-1 ${multi ? 'bg-slate-800 text-white' : 'bg-white'}`}
              >
                several on one chart
              </button>
            </div>
            <button
              type="button"
              onClick={() => set({ ...BURNUP_PRESET, title: def.title || 'Burnup' })}
              className="ml-auto text-xs border rounded px-2 py-1 bg-gray-50 hover:bg-gray-100"
              title="Cumulative scope vs cumulative completed, over months"
            >
              ↗ Burnup preset
            </button>
          </div>
          {multi && (
            <SeriesEditor
              series={def.series!}
              axis={def.dimensions[0]!}
              omitKeys={def.omitKeys ?? []}
              onChange={setSeries}
              onOmitKeys={(keys) => set({ omitKeys: keys.length ? keys : undefined })}
            />
          )}
        </fieldset>

        <fieldset className="text-sm">
          <legend className="mb-1">Show as</legend>
          <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label="Visualization">
            {(['table', 'bar', 'line', 'area', 'pie'] as const).map((v) => {
              const disabled = multi && v === 'pie';
              return (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={def.viz === v}
                  disabled={disabled}
                  title={disabled ? 'A pie chart can only show one series' : undefined}
                  onClick={() => set({ viz: v })}
                  className={`border rounded px-3 py-1 disabled:opacity-40 ${def.viz === v ? 'bg-slate-800 text-white' : 'bg-white'}`}
                >
                  {v === 'table' ? '▦ table' : v === 'bar' ? '▮ bar' : v === 'line' ? '⟋ line' : v === 'area' ? '◣ area' : '◔ pie'}
                </button>
              );
            })}
          </div>
          {!multi && def.viz !== 'table' && def.dimensions.length === 2 && (
            <p className="text-xs text-gray-500 mt-1">Charts use the first dimension; the second shows in the table view only.</p>
          )}
        </fieldset>

        <div className="border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: C.inkSecondary }}>
            Live preview — your real data
          </p>
          <CustomWidget def={{ ...previewDef, title: def.title.trim() || 'Untitled widget' }} boardId={boardId} />
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className="border rounded px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            disabled={!def.title.trim() || (multi && def.series!.some((s) => !s.label.trim()))}
            title={!def.title.trim() ? 'Give the widget a title first' : undefined}
            onClick={() => onSave({ ...def, title: def.title.trim() }, initial)}
            className="bg-slate-800 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
          >
            Save widget
          </button>
        </div>
      </div>
    </div>
  );
}

/** Add / remove / reorder the metrics plotted together on one chart. */
function SeriesEditor({
  series,
  axis,
  omitKeys,
  onChange,
  onOmitKeys,
}: {
  series: SeriesDef[];
  axis: Dimension;
  omitKeys: string[];
  onChange: (next: SeriesDef[]) => void;
  onOmitKeys: (keys: string[]) => void;
}) {
  const patch = (i: number, p: Partial<SeriesDef>) => onChange(series.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const swap = (i: number, j: number) => {
    if (j < 0 || j >= series.length) return;
    const next = [...series];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="mt-2 space-y-2">
      {series.map((s, i) => (
        <div key={i} className="border rounded p-2 grid grid-cols-12 gap-2 items-end">
          <span aria-hidden className="col-span-1 w-3 h-3 rounded-sm self-center" style={{ background: SERIES[i % SERIES.length] }} />
          <label className="col-span-4 text-xs">
            Name
            <input
              value={s.label}
              onChange={(e) => patch(i, { label: e.target.value })}
              className="mt-0.5 w-full border rounded px-2 py-1 text-sm"
            />
          </label>
          <label className="col-span-3 text-xs">
            Metric
            <select
              value={s.metric}
              onChange={(e) => {
                const metric = e.target.value as Metric;
                patch(i, { metric, aggregation: metric === 'count' ? 'count' : s.aggregation === 'count' ? 'avg' : s.aggregation });
              }}
              className="mt-0.5 w-full border rounded px-1 py-1 text-sm"
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs">
            Aggregation
            <select
              value={s.aggregation}
              disabled={s.metric === 'count'}
              onChange={(e) => patch(i, { aggregation: e.target.value as Aggregation })}
              className="mt-0.5 w-full border rounded px-1 py-1 text-sm disabled:opacity-50"
            >
              {AGGREGATIONS.filter((a) => a !== 'count').map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              {s.metric === 'count' && <option value="count">count</option>}
            </select>
          </label>
          <div className="col-span-2 flex gap-1 justify-end pb-1">
            <button aria-label={`Move ${s.label} up`} disabled={i === 0} onClick={() => swap(i, i - 1)} className="disabled:opacity-30">
              ↑
            </button>
            <button
              aria-label={`Move ${s.label} down`}
              disabled={i === series.length - 1}
              onClick={() => swap(i, i + 1)}
              className="disabled:opacity-30"
            >
              ↓
            </button>
            <button
              aria-label={`Remove ${s.label}`}
              disabled={series.length <= 1}
              onClick={() => onChange(series.filter((_, j) => j !== i))}
              className="text-red-600 disabled:opacity-30"
            >
              🗑
            </button>
          </div>
          <label className="col-span-6 text-xs">
            Plot over
            <select
              value={s.dimension ?? ''}
              onChange={(e) => patch(i, { dimension: (e.target.value || undefined) as Dimension | undefined })}
              className="mt-0.5 w-full border rounded px-1 py-1 text-sm"
              title="A series can use its own dimension — that is how scope and completed share one time axis"
            >
              <option value="">same as axis ({DIM_LABELS[axis]})</option>
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIM_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-6 flex items-center gap-2 text-xs pb-1">
            <input type="checkbox" checked={Boolean(s.cumulative)} onChange={(e) => patch(i, { cumulative: e.target.checked })} />
            Running total along the axis
          </label>
        </div>
      ))}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={series.length >= 6}
          onClick={() => onChange([...series, { label: `Series ${series.length + 1}`, metric: 'count', aggregation: 'count' }])}
          className="text-xs border rounded px-2 py-1 bg-gray-50 hover:bg-gray-100 disabled:opacity-40"
        >
          + Add series
        </button>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={omitKeys.includes('Not done')}
            onChange={(e) => onOmitKeys(e.target.checked ? [...new Set([...omitKeys, 'Not done'])] : omitKeys.filter((k) => k !== 'Not done'))}
          />
          Drop the &ldquo;Not done&rdquo; bucket from the axis
        </label>
      </div>
    </div>
  );
}

interface PivotResponse {
  rows: { keys: string[]; value: number | null; n: number }[];
}
interface MultiPivotResponse {
  keys: string[];
  series: { label: string; metric: Metric; values: (number | null)[]; ns: number[] }[];
}

/** Durations plot in hours; counts plot raw. */
const toPlot = (metric: Metric, v: number | null) =>
  v === null ? null : metric === 'count' || metric === 'overrideCount' ? v : +(v / 3_600_000).toFixed(1);
const unitOf = (metric: Metric) => (metric === 'count' || metric === 'overrideCount' ? '' : ' h');

function subtitleOf(def: CustomDef): string {
  if (isMulti(def)) {
    const names = def.series!.map((s) => s.label).join(' · ');
    return `${names} — over ${DIM_LABELS[def.dimensions[0]!]}`;
  }
  return `${METRIC_LABELS[def.metric]} · ${def.aggregation} · by ${def.dimensions.map((d) => DIM_LABELS[d]).join(' and ')}`;
}

/**
 * Renders a custom widget from its definition. Used both on the dashboard and
 * as the builder's live preview, so what is previewed is exactly what is saved.
 */
function CustomWidget({ def, boardId }: { def: CustomDef; boardId: string }) {
  const multi = isMulti(def);
  const { data, error } = useQuery<PivotResponse | MultiPivotResponse>({
    // title deliberately excluded: renaming a widget must not refetch it
    queryKey: ['pivot', boardId, def.dimensions, def.metric, def.aggregation, def.series ?? null, def.omitKeys ?? null],
    queryFn: () =>
      post(
        '/api/me/dashboard/query',
        multi
          ? { dimension: def.dimensions[0], series: def.series, omitKeys: def.omitKeys, boardIds: [boardId] }
          : { dimensions: def.dimensions, metric: def.metric, aggregation: def.aggregation, boardIds: [boardId] },
      ),
  });

  const sub = subtitleOf(def);

  if (error)
    return (
      <ChartCard title={def.title} subtitle={sub}>
        <p role="alert" className="text-sm text-red-700 py-4">⚠ {String(error)}</p>
      </ChartCard>
    );
  if (!data)
    return (
      <ChartCard title={def.title} subtitle={sub}>
        <div className="h-24 animate-pulse bg-gray-100 rounded" aria-busy="true" />
      </ChartCard>
    );

  return multi ? (
    <MultiSeriesView def={def} data={data as MultiPivotResponse} subtitle={sub} />
  ) : (
    <SingleSeriesView def={def} rows={(data as PivotResponse).rows} subtitle={sub} />
  );
}

function SingleSeriesView({ def, rows, subtitle }: { def: CustomDef; rows: PivotResponse['rows']; subtitle: string }) {
  if (rows.length === 0)
    return (
      <ChartCard title={def.title} subtitle={subtitle}>
        <p className="text-sm text-gray-500 py-6 text-center">No data yet.</p>
      </ChartCard>
    );

  if (def.viz === 'table' || def.dimensions.length === 2) {
    return (
      <ChartCard title={def.title} subtitle={subtitle}>
        <div className="overflow-x-auto max-h-64">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ color: C.inkSecondary }}>
                {def.dimensions.map((d) => (
                  <th key={d} className="py-1 pr-3">
                    {DIM_LABELS[d]}
                  </th>
                ))}
                <th className="py-1 text-right">{METRIC_LABELS[def.metric]}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0">
                  {r.keys.map((k, j) => (
                    <td key={j} className="py-1 pr-3">
                      {k}
                    </td>
                  ))}
                  <td className="py-1 text-right tabular-nums">{fmtValue(def.metric, r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    );
  }

  const chartData = rows.map((r) => ({ name: r.keys[0]!, value: toPlot(def.metric, r.value) ?? 0 }));
  const unit = unitOf(def.metric);
  const tooltipFmt = (v: number) => [`${v}${unit}`, METRIC_LABELS[def.metric]];

  return (
    <ChartCard title={def.title} subtitle={`${subtitle}${unit ? ' (hours)' : ''}`}>
      <ResponsiveContainer width="100%" height={220}>
        {def.viz === 'bar' ? (
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />
            <YAxis tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={36} />
            <Tooltip cursor={{ fill: 'rgba(42,120,214,0.08)' }} formatter={tooltipFmt} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Bar dataKey="value" fill={C.series1} radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        ) : def.viz === 'line' ? (
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />
            <YAxis tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={36} />
            <Tooltip formatter={tooltipFmt} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Line type="monotone" dataKey="value" stroke={C.series1} strokeWidth={2} dot={{ r: 4, fill: C.series1 }} />
          </LineChart>
        ) : def.viz === 'area' ? (
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />
            <YAxis tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={36} />
            <Tooltip formatter={tooltipFmt} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Area type="monotone" dataKey="value" stroke={C.series1} fill={C.series1} fillOpacity={0.18} strokeWidth={2} />
          </AreaChart>
        ) : (
          <PieChart>
            <Pie data={chartData.slice(0, 8)} dataKey="value" nameKey="name" outerRadius={80} label={(e) => e.name}>
              {chartData.slice(0, 8).map((_, i) => (
                <Cell key={i} fill={SERIES[i % SERIES.length]} stroke={C.surface} strokeWidth={2} />
              ))}
            </Pie>
            <Tooltip formatter={tooltipFmt} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          </PieChart>
        )}
      </ResponsiveContainer>
      {def.viz === 'pie' && chartData.length > 8 && (
        <p className="text-xs" style={{ color: C.muted }}>
          Showing the first 8 groups — switch to table for the full list.
        </p>
      )}
    </ChartCard>
  );
}

/** Several metrics on one axis: burnup, scope-vs-done, count-vs-duration. */
function MultiSeriesView({ def, data, subtitle }: { def: CustomDef; data: MultiPivotResponse; subtitle: string }) {
  const { keys, series } = data;
  if (keys.length === 0 || series.length === 0)
    return (
      <ChartCard title={def.title} subtitle={subtitle}>
        <p className="text-sm text-gray-500 py-6 text-center">No data yet.</p>
      </ChartCard>
    );

  const units = new Set(series.map((s) => unitOf(s.metric)));
  const mixedUnits = units.size > 1;
  const note = mixedUnits ? ' — mixed units on one axis (durations in hours)' : units.has(' h') ? ' (hours)' : '';

  // recharts wants row-per-axis-point: { name, s0, s1, ... }
  const chartData = keys.map((name, i) => {
    const row: Record<string, string | number | null> = { name };
    series.forEach((s, si) => {
      row[`s${si}`] = toPlot(s.metric, s.values[i] ?? null);
    });
    return row;
  });
  const color = (i: number) => SERIES[i % SERIES.length]!;
  const tooltipFmt = (v: number, name: string) => {
    const idx = series.findIndex((s) => s.label === name);
    return [`${v}${idx >= 0 ? unitOf(series[idx]!.metric) : ''}`, name];
  };

  if (def.viz === 'table') {
    return (
      <ChartCard title={def.title} subtitle={subtitle}>
        <div className="overflow-x-auto max-h-64">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ color: C.inkSecondary }}>
                <th className="py-1 pr-3">{DIM_LABELS[def.dimensions[0]!]}</th>
                {series.map((s) => (
                  <th key={s.label} className="py-1 text-right pl-3">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((k, i) => (
                <tr key={k} className="border-b last:border-0">
                  <td className="py-1 pr-3">{k}</td>
                  {series.map((s) => (
                    <td key={s.label} className="py-1 text-right tabular-nums pl-3">
                      {fmtValue(s.metric, s.values[i] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    );
  }

  // recharts inspects its direct children to discover axes/legend, so these are
  // written out per chart rather than shared through a fragment
  const grid = <CartesianGrid stroke={C.grid} vertical={false} />;
  const xAxis = <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />;
  const yAxis = <YAxis tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={40} />;
  const tip = <Tooltip formatter={tooltipFmt} contentStyle={{ fontSize: 12, borderRadius: 8 }} />;
  const legend = <Legend wrapperStyle={{ fontSize: 12 }} />;

  return (
    <ChartCard title={def.title} subtitle={`${subtitle}${note}`}>
      <ResponsiveContainer width="100%" height={240}>
        {def.viz === 'bar' ? (
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tip}
            {legend}
            {series.map((s, i) => (
              <Bar key={s.label} dataKey={`s${i}`} name={s.label} fill={color(i)} radius={[4, 4, 0, 0]} maxBarSize={28} />
            ))}
          </BarChart>
        ) : def.viz === 'area' ? (
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tip}
            {legend}
            {series.map((s, i) => (
              <Area
                key={s.label}
                type="monotone"
                dataKey={`s${i}`}
                name={s.label}
                stroke={color(i)}
                fill={color(i)}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tip}
            {legend}
            {series.map((s, i) => (
              <Line
                key={s.label}
                type="monotone"
                dataKey={`s${i}`}
                name={s.label}
                stroke={color(i)}
                strokeWidth={2}
                dot={{ r: 3, fill: color(i) }}
                connectNulls
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </ChartCard>
  );
}

function Widget({
  widget,
  def,
  metrics,
  throughput,
  boardId,
}: {
  widget: WidgetId;
  def?: CustomDef;
  metrics: Metrics;
  throughput: { week: string; count: number }[];
  boardId: string;
}) {
  switch (widget) {
    case 'custom':
      return def ? <CustomWidget def={def} boardId={boardId} /> : null;
    case 'lead':
      return <StatTile label="Mean lead time" value={fmtDuration(metrics.aggregates.meanLeadTimeMs)} sub="created → first done" />;
    case 'cycle':
      return <StatTile label="Mean cycle time" value={fmtDuration(metrics.aggregates.meanCycleTimeMs)} sub="work started → done" />;
    case 'waiting':
      return (
        <StatTile
          label="Waiting before work starts"
          value={fmtDuration(metrics.aggregates.meanWaitingTimeMs)}
          sub="time in the backlog (open column) — queue time, not a bottleneck signal"
        />
      );
    case 'doneAge':
      return (
        <StatTile
          label="Time since done"
          value={fmtDuration(metrics.aggregates.meanDoneAgeMs)}
          sub="how long finished cards have been resting in done — aging, not delay"
        />
      );
    case 'overdueCount':
      return (
        <StatTile
          label="Overdue cards"
          value={String(metrics.overdueCount)}
          sub={metrics.overdueCount > 0 ? '⚠ needs attention' : 'all on track'}
          accent={metrics.overdueCount > 0 ? C.critical : undefined}
        />
      );
    case 'perColumn': {
      // deliberately ONLY in-between work columns: open is a queue and done is
      // an archive — long dwell there is expected, so mixing them into this
      // chart would fake bottlenecks. They get their own tiles instead.
      const data = metrics.aggregates.perColumnMeanMs
        .filter((c) => {
          const col = metrics.columns.find((x) => x.id === c.columnId);
          return col?.semantic == null;
        })
        .map((c) => ({ name: c.name, hours: c.meanMs !== null ? +(c.meanMs / 3_600_000).toFixed(1) : 0 }));
      return (
        <ChartCard
          title="Time in work columns"
          subtitle="mean hours per in-progress column — open (queue) and done (archive) are excluded on purpose; see the waiting and time-since-done tiles"
        >
          {data.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">This board has no in-between columns yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />
                <YAxis tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={36} />
                <Tooltip
                  cursor={{ fill: 'rgba(42,120,214,0.08)' }}
                  formatter={(v: number) => [`${v} h`, 'mean dwell — long bars here suggest a bottleneck']}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Bar dataKey="hours" fill={C.series1} radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      );
    }
    case 'policyOverrides': {
      // deliberate rule bypasses are recorded, not just warned about — this is
      // the board-level readout of how often that happens
      const o = metrics.overrides ?? { total: 0, backwardsMoves: 0, policiesSkipped: 0, recent: [] };
      return (
        <StatTile
          label="Policy overrides"
          value={String(o.total)}
          sub={
            o.total === 0
              ? 'no rules have been bypassed'
              : `${o.policiesSkipped} policy check(s) skipped · ${o.backwardsMoves} forced backwards move(s)`
          }
          accent={o.total > 0 ? C.critical : undefined}
        />
      );
    }
    case 'throughput':
      return (
        <ChartCard title="Throughput" subtitle="cards finished per week">
          {throughput.length === 0 ? (
            <p className="text-sm text-gray-500 py-8 text-center">No finished cards yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={throughput} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Line type="monotone" dataKey="count" stroke={C.series1} strokeWidth={2} dot={{ r: 4, fill: C.series1 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      );
  }
}

function StatTile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div className="rounded-xl border shadow-sm p-4 h-full" style={{ background: C.surface }}>
      <p className="text-sm" style={{ color: C.inkSecondary }}>
        {label}
      </p>
      <p className="text-3xl font-semibold mt-1" style={{ color: accent ?? C.inkPrimary }}>
        {value}
      </p>
      <p className="text-xs mt-1" style={{ color: C.muted }}>
        {sub}
      </p>
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border shadow-sm p-4" style={{ background: C.surface }}>
      <p className="text-sm font-semibold" style={{ color: C.inkPrimary }}>
        {title}
      </p>
      <p className="text-xs mb-2" style={{ color: C.muted }}>
        {subtitle}
      </p>
      {children}
    </div>
  );
}
