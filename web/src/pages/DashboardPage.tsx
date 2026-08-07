import { useMemo, useState } from 'react';
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

type WidgetId = 'lead' | 'cycle' | 'waiting' | 'doneAge' | 'perColumn' | 'overdueCount' | 'throughput' | 'custom';

const DIMENSIONS = ['board', 'column', 'lane', 'category', 'owner', 'recurrenceStatus', 'createdMonth', 'closedMonth'] as const;
const METRICS = ['count', 'leadTimeMs', 'cycleTimeMs', 'waitingTimeMs', 'timeInColumnMs'] as const;
const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max', 'median'] as const;

interface CustomDef {
  title: string;
  dimensions: (typeof DIMENSIONS)[number][];
  metric: (typeof METRICS)[number];
  aggregation: (typeof AGGREGATIONS)[number];
  viz: 'table' | 'bar' | 'line' | 'pie';
}

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
};
const METRIC_LABELS: Record<string, string> = {
  count: 'Card count',
  leadTimeMs: 'Lead time',
  cycleTimeMs: 'Cycle time',
  waitingTimeMs: 'Waiting time',
  timeInColumnMs: 'Time in current column',
};

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

const fmtValue = (metric: string, v: number | null) =>
  v === null ? '—' : metric === 'count' ? String(Math.round(v)) : fmtDuration(v);

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

/** Pivot-style builder: dimensions x metric x aggregation, viz independent. */
function WidgetBuilder({
  initial,
  onClose,
  onSave,
}: {
  initial: LayoutItem | null;
  onClose: () => void;
  onSave: (def: CustomDef, existing: LayoutItem | null) => void;
}) {
  const dialogRef = useDismiss<HTMLDivElement>(onClose);
  const [def, setDef] = useState<CustomDef>(
    initial?.def ?? { title: '', dimensions: ['category'], metric: 'count', aggregation: 'count', viz: 'bar' },
  );
  const set = (p: Partial<CustomDef>) => setDef({ ...def, ...p });
  const countMode = def.metric === 'count';

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Custom widget builder"
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3"
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
            Group by
            <select
              value={def.dimensions[0]}
              onChange={(e) => set({ dimensions: [e.target.value as CustomDef['dimensions'][0], ...(def.dimensions[1] ? [def.dimensions[1]] : [])] })}
              className="mt-1 w-full border rounded px-2 py-1"
            >
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIM_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Then by (optional)
            <select
              value={def.dimensions[1] ?? ''}
              onChange={(e) =>
                set({ dimensions: e.target.value ? [def.dimensions[0]!, e.target.value as CustomDef['dimensions'][0]] : [def.dimensions[0]!] })
              }
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
          <label className="block text-sm">
            Metric
            <select
              value={def.metric}
              onChange={(e) => {
                const metric = e.target.value as CustomDef['metric'];
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
              onChange={(e) => set({ aggregation: e.target.value as CustomDef['aggregation'] })}
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
        </div>
        <fieldset className="text-sm">
          <legend className="mb-1">Show as</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="Visualization">
            {(['table', 'bar', 'line', 'pie'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={def.viz === v}
                onClick={() => set({ viz: v })}
                className={`border rounded px-3 py-1 ${def.viz === v ? 'bg-slate-800 text-white' : 'bg-white'}`}
              >
                {v === 'table' ? '▦ table' : v === 'bar' ? '▮ bar' : v === 'line' ? '⟋ line' : '◔ pie'}
              </button>
            ))}
          </div>
          {def.viz !== 'table' && def.dimensions.length === 2 && (
            <p className="text-xs text-gray-500 mt-1">Charts use the first dimension; the second shows in the table view only.</p>
          )}
        </fieldset>
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className="border rounded px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            disabled={!def.title.trim()}
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

function CustomWidget({ def, boardId }: { def: CustomDef; boardId: string }) {
  const { data, error } = useQuery<{ rows: { keys: string[]; value: number | null; n: number }[] }>({
    queryKey: ['pivot', boardId, def],
    queryFn: () =>
      post('/api/me/dashboard/query', {
        dimensions: def.dimensions,
        metric: def.metric,
        aggregation: def.aggregation,
        boardIds: [boardId],
      }),
  });

  const sub = `${METRIC_LABELS[def.metric]} · ${def.aggregation} · by ${def.dimensions.map((d) => DIM_LABELS[d]).join(' and ')}`;

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

  const rows = data.rows;
  if (rows.length === 0)
    return (
      <ChartCard title={def.title} subtitle={sub}>
        <p className="text-sm text-gray-500 py-6 text-center">No data yet.</p>
      </ChartCard>
    );

  if (def.viz === 'table' || def.dimensions.length === 2) {
    return (
      <ChartCard title={def.title} subtitle={sub}>
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

  const chartData = rows.map((r) => ({
    name: r.keys[0]!,
    value: def.metric === 'count' ? (r.value ?? 0) : +(((r.value ?? 0) / 3_600_000).toFixed(1)),
  }));
  const unit = def.metric === 'count' ? '' : ' h';
  const tooltipFmt = (v: number) => [`${v}${unit}`, METRIC_LABELS[def.metric]];

  return (
    <ChartCard title={def.title} subtitle={`${sub}${unit ? ' (hours)' : ''}`}>
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
