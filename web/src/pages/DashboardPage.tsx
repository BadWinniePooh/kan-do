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
} from 'recharts';
import { get, put } from '../api';
import type { Board } from '../types';

/* Validated reference palette (dataviz skill): single-series marks use
 * categorical slot 1; status-critical for overdue; ink/grid from chrome table. */
const C = {
  series1: '#2a78d6',
  critical: '#d03b3b',
  inkPrimary: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  surface: '#fcfcfb',
};

type WidgetId = 'lead' | 'cycle' | 'waiting' | 'perColumn' | 'overdueCount' | 'throughput';

interface LayoutItem {
  id: string;
  widget: WidgetId;
  w: number;
  h: number;
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
    perColumnMeanMs: { columnId: string; name: string; meanMs: number | null }[];
  };
}

const ALL_WIDGETS: { id: WidgetId; label: string }[] = [
  { id: 'lead', label: 'Mean lead time' },
  { id: 'cycle', label: 'Mean cycle time' },
  { id: 'waiting', label: 'Mean waiting time' },
  { id: 'overdueCount', label: 'Overdue cards' },
  { id: 'perColumn', label: 'Time per column' },
  { id: 'throughput', label: 'Throughput (done/week)' },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { id: 'w1', widget: 'lead', w: 4, h: 1 },
  { id: 'w2', widget: 'cycle', w: 4, h: 1 },
  { id: 'w3', widget: 'overdueCount', w: 4, h: 1 },
  { id: 'w4', widget: 'perColumn', w: 6, h: 2 },
  { id: 'w5', widget: 'throughput', w: 6, h: 2 },
];

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const { data: boards = [] } = useQuery<Board[]>({ queryKey: ['boards'], queryFn: () => get('/api/boards') });
  const [boardId, setBoardId] = useState<string | null>(null);
  const activeBoard = boardId ?? boards[0]?.id ?? null;
  const [configOpen, setConfigOpen] = useState(false);

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
      </div>

      {configOpen && (
        <WidgetConfig
          layout={layout}
          onChange={(l) => saveLayout.mutate(l)}
          onClose={() => setConfigOpen(false)}
        />
      )}

      {error && (
        <p role="alert" className="text-red-700 text-sm">⚠ Could not load metrics: {String(error)}</p>
      )}
      {!metrics ? (
        <p className="text-gray-500">Loading metrics…</p>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {layout.map((item) => (
            <div key={item.id} className={`col-span-12 md:col-span-${item.w}`} style={{ gridColumn: `span ${item.w} / span ${item.w}` }}>
              <Widget widget={item.widget} metrics={metrics} throughput={throughput} />
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
}: {
  layout: LayoutItem[];
  onChange: (l: LayoutItem[]) => void;
  onClose: () => void;
}) {
  return (
    <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm" role="region" aria-label="Dashboard configuration">
      <div className="flex flex-wrap gap-4">
        {ALL_WIDGETS.map((w) => {
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
        <p className="text-xs text-gray-500">Order & width:</p>
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
            <span className="flex-1">{ALL_WIDGETS.find((w) => w.id === item.widget)?.label}</span>
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

function Widget({ widget, metrics, throughput }: { widget: WidgetId; metrics: Metrics; throughput: { week: string; count: number }[] }) {
  switch (widget) {
    case 'lead':
      return <StatTile label="Mean lead time" value={fmtDuration(metrics.aggregates.meanLeadTimeMs)} sub="created → done" />;
    case 'cycle':
      return <StatTile label="Mean cycle time" value={fmtDuration(metrics.aggregates.meanCycleTimeMs)} sub="work started → done" />;
    case 'waiting':
      return <StatTile label="Mean waiting time" value={fmtDuration(metrics.aggregates.meanWaitingTimeMs)} sub="time in open columns" />;
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
      const data = metrics.aggregates.perColumnMeanMs.map((c) => ({
        name: c.name,
        hours: c.meanMs !== null ? +(c.meanMs / 3_600_000).toFixed(1) : 0,
      }));
      return (
        <ChartCard title="Mean time per column" subtitle="hours, averaged over all cards">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: C.grid }} tickLine={false} />
              <YAxis tick={{ fill: C.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={36} />
              <Tooltip
                cursor={{ fill: 'rgba(42,120,214,0.08)' }}
                formatter={(v: number) => [`${v} h`, 'mean time']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Bar dataKey="hours" fill={C.series1} radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
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
    <div className="bg-white rounded-lg border shadow-sm p-4 h-full" style={{ background: C.surface }}>
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
    <div className="bg-white rounded-lg border shadow-sm p-4" style={{ background: C.surface }}>
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
