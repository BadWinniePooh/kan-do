import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '../api';
import type { BoardDetail, Column, ColumnPolicy, ColumnSemantic, Lane, PolicyKind } from '../types';
import { useDismiss } from '../useDismiss';

interface ColDraft {
  /** stable across reorders and deletions — policy drafts hang off it */
  key: string;
  id?: string;
  name: string;
  semantic: ColumnSemantic;
}

interface LaneDraft {
  key: string;
  id?: string;
  name: string;
}

interface PolicyDraft {
  id?: string;
  kind: PolicyKind;
  label: string;
}

let draftSeq = 0;
const nextKey = () => `new-${++draftSeq}`;

const SEMANTIC_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: '', label: 'plain', hint: 'ordinary work column' },
  { value: 'open', label: '= open', hint: 'the queue — required, one per lane' },
  { value: 'done', label: '= done', hint: 'completed successfully — required, one per lane' },
  { value: 'discard', label: '= discard', hint: 'finished but reverted — optional, never counts as completed' },
];

/**
 * Lane and column editor.
 *
 * Columns are lane-scoped: every lane owns its own independent set, with its own
 * names, order, semantics and policies. Two lanes on one board may look nothing
 * alike. Each lane must keep at least one "open" and one "done" column; a
 * "discard" column is optional.
 *
 * Save order is lanes → each lane's columns → each column's policies, so a lane
 * and the columns created inside it in the same sitting can find their ids.
 */
export default function ColumnEditor({ board, onClose }: { board: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [lanes, setLanes] = useState<LaneDraft[]>(board.lanes.map((l) => ({ key: l.id, id: l.id, name: l.name })));
  const [cols, setCols] = useState<Record<string, ColDraft[]>>(() => initialColumns(board.lanes, board.columns));
  const [policies, setPolicies] = useState<Record<string, PolicyDraft[]>>(() => initialPolicies(board.columns, board.policies));
  const [openPolicies, setOpenPolicies] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDismiss<HTMLDivElement>(onClose);

  const laneColumns = (laneKey: string) => cols[laneKey] ?? [];
  const laneProblem = (laneKey: string): string | null => {
    const list = laneColumns(laneKey);
    if (!list.some((c) => c.semantic === 'open')) return 'needs a column mapped to "open"';
    if (!list.some((c) => c.semantic === 'done')) return 'needs a column mapped to "done"';
    if (list.some((c) => !c.name.trim())) return 'has a column with no name';
    return null;
  };
  const problems = lanes.map((l) => ({ lane: l, problem: laneProblem(l.key) })).filter((p) => p.problem);
  const blankPolicy = Object.values(policies).some((list) => list.some((p) => !p.label.trim()));

  const save = useMutation({
    mutationFn: async () => {
      const savedLanes = await put<Lane[]>(
        `/api/boards/${board.board.id}/lanes`,
        lanes.map((l, i) => ({ id: l.id, name: l.name.trim(), position: i })),
      );
      for (let i = 0; i < lanes.length; i++) {
        const laneKey = lanes[i]!.key;
        const laneId = savedLanes[i]!.id;
        const savedCols = await put<Column[]>(
          `/api/boards/${board.board.id}/lanes/${laneId}/columns`,
          laneColumns(laneKey).map((c, j) => ({ id: c.id, name: c.name.trim(), position: j, semantic: c.semantic })),
        );
        for (let j = 0; j < laneColumns(laneKey).length; j++) {
          const colKey = laneColumns(laneKey)[j]!.key;
          const drafts = policies[colKey] ?? [];
          const had = board.policies.some((p) => p.column_id === laneColumns(laneKey)[j]!.id);
          if (drafts.length === 0 && !had) continue;
          await put(
            `/api/boards/${board.board.id}/columns/${savedCols[j]!.id}/policies`,
            drafts.map((d, k) => ({ ...d, label: d.label.trim(), position: k })),
          );
        }
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board', board.board.id] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const swapLane = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= lanes.length) return;
    const next = [...lanes];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setLanes(next);
  };

  const addLane = () => {
    const key = nextKey();
    setLanes([...lanes, { key, name: 'New lane' }]);
    // a new lane is born valid: the server seeds exactly this trio too
    setCols({
      ...cols,
      [key]: [
        { key: nextKey(), name: 'Open', semantic: 'open' },
        { key: nextKey(), name: 'In progress', semantic: null },
        { key: nextKey(), name: 'Done', semantic: 'done' },
      ],
    });
  };

  const removeLane = (laneKey: string) => {
    const lane = lanes.find((l) => l.key === laneKey);
    const holdsCards = lane?.id && board.cards.some((c) => c.lane_id === lane.id);
    if (holdsCards) {
      setError('That lane still holds cards. Move them to another lane before deleting it.');
      return;
    }
    setError(null);
    setLanes(lanes.filter((l) => l.key !== laneKey));
    setCols(Object.fromEntries(Object.entries(cols).filter(([k]) => k !== laneKey)));
  };

  const setLaneColumns = (laneKey: string, next: ColDraft[]) => setCols({ ...cols, [laneKey]: next });

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit lanes and columns"
        className="bg-white rounded-xl shadow-xl w-full max-w-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-bold">Lanes & columns</h2>
          <p className="text-sm text-gray-500">
            Every lane has its own columns — own names, own order, own policies. Two lanes can look completely different.
          </p>
        </div>

        {problems.length > 0 && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            ⚠ {problems.map((p) => `“${p.lane.name || 'Unnamed lane'}” ${p.problem}`).join('; ')}. Recurrence and metrics
            depend on the open/done mapping; the names can be anything.
          </p>
        )}

        {lanes.map((lane, li) => (
          <section key={lane.key} className="border rounded-lg p-3 space-y-2" aria-label={`Lane ${lane.name}`}>
            <div className="flex items-center gap-2">
              <button aria-label={`Move lane ${lane.name} up`} disabled={li === 0} onClick={() => swapLane(li, -1)} className="text-gray-400 disabled:opacity-30">
                ↑
              </button>
              <button
                aria-label={`Move lane ${lane.name} down`}
                disabled={li === lanes.length - 1}
                onClick={() => swapLane(li, 1)}
                className="text-gray-400 disabled:opacity-30"
              >
                ↓
              </button>
              <input
                aria-label={`Lane ${li + 1} name`}
                value={lane.name}
                onChange={(e) => setLanes(lanes.map((x, j) => (j === li ? { ...x, name: e.target.value } : x)))}
                className="border rounded px-2 py-1 flex-1 font-semibold text-sm"
              />
              <button
                aria-label={`Delete lane ${lane.name}`}
                disabled={lanes.length === 1}
                title={lanes.length === 1 ? 'A board needs at least one lane' : undefined}
                onClick={() => removeLane(lane.key)}
                className="text-red-600 hover:text-red-800 disabled:opacity-30"
              >
                🗑
              </button>
            </div>

            {laneColumns(lane.key).map((c, i) => (
              <div key={c.key} className="ml-6 border rounded p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    aria-label={`Move ${c.name} left`}
                    disabled={i === 0}
                    onClick={() => {
                      const next = [...laneColumns(lane.key)];
                      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                      setLaneColumns(lane.key, next);
                    }}
                    className="text-gray-400 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${c.name} right`}
                    disabled={i === laneColumns(lane.key).length - 1}
                    onClick={() => {
                      const next = [...laneColumns(lane.key)];
                      [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                      setLaneColumns(lane.key, next);
                    }}
                    className="text-gray-400 disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <input
                    aria-label={`${lane.name} column ${i + 1} name`}
                    value={c.name}
                    onChange={(e) =>
                      setLaneColumns(lane.key, laneColumns(lane.key).map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                    className="border rounded px-2 py-1 flex-1 text-sm"
                  />
                  <select
                    aria-label={`${lane.name} column ${i + 1} meaning`}
                    value={c.semantic ?? ''}
                    onChange={(e) =>
                      setLaneColumns(
                        lane.key,
                        laneColumns(lane.key).map((x, j) =>
                          j === i ? { ...x, semantic: (e.target.value || null) as ColumnSemantic } : x,
                        ),
                      )
                    }
                    className="border rounded px-2 py-1 text-sm"
                    title={SEMANTIC_OPTIONS.find((o) => (o.value || null) === c.semantic)?.hint}
                  >
                    {SEMANTIC_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value} title={o.hint}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    aria-expanded={openPolicies === c.key}
                    onClick={() => setOpenPolicies(openPolicies === c.key ? null : c.key)}
                    className="text-xs border rounded px-2 py-1 whitespace-nowrap hover:bg-gray-50"
                  >
                    ☑ Policies{(policies[c.key] ?? []).length ? ` (${policies[c.key]!.length})` : ''}
                  </button>
                  <button
                    aria-label={`Delete column ${c.name}`}
                    onClick={() => {
                      setLaneColumns(lane.key, laneColumns(lane.key).filter((_, j) => j !== i));
                      setPolicies(Object.fromEntries(Object.entries(policies).filter(([k]) => k !== c.key)));
                    }}
                    className="text-red-600 hover:text-red-800"
                  >
                    🗑
                  </button>
                </div>
                {openPolicies === c.key && (
                  <PolicyEditor
                    columnName={c.name}
                    policies={policies[c.key] ?? []}
                    onChange={(next) => setPolicies({ ...policies, [c.key]: next })}
                  />
                )}
              </div>
            ))}
            <button
              onClick={() => setLaneColumns(lane.key, [...laneColumns(lane.key), { key: nextKey(), name: 'New column', semantic: null }])}
              className="ml-6 text-sm border rounded px-2 py-1 bg-gray-50 hover:bg-gray-100"
            >
              + Add column to {lane.name || 'this lane'}
            </button>
          </section>
        ))}

        <button onClick={addLane} className="text-sm border rounded px-2 py-1 bg-gray-50 hover:bg-gray-100">
          + Add lane
        </button>

        {error && (
          <p role="alert" className="text-sm text-red-700">⚠ {error}</p>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="border rounded px-3 py-1">
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={problems.length > 0 || save.isPending || blankPolicy || lanes.some((l) => !l.name.trim())}
            className="bg-slate-800 text-white rounded px-3 py-1 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Column drafts keyed by lane key, which for a saved lane is its id. */
function initialColumns(lanes: Lane[], columns: Column[]): Record<string, ColDraft[]> {
  const out: Record<string, ColDraft[]> = {};
  for (const lane of lanes) {
    out[lane.id] = columns
      .filter((c) => c.lane_id === lane.id)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ key: c.id, id: c.id, name: c.name, semantic: c.semantic }));
  }
  return out;
}

/** Policy drafts keyed by column key, which for a saved column is its id. */
function initialPolicies(columns: Column[], policies: ColumnPolicy[]): Record<string, PolicyDraft[]> {
  const out: Record<string, PolicyDraft[]> = {};
  for (const c of columns) {
    out[c.id] = policies
      .filter((p) => p.column_id === c.id)
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ id: p.id, kind: p.kind, label: p.label }));
  }
  return out;
}

/**
 * One column's policies: create / edit / delete / reorder, split by the moment
 * they apply. These belong to THIS lane's column — a same-named column in
 * another lane is a different column with its own policies.
 */
function PolicyEditor({
  columnName,
  policies,
  onChange,
}: {
  columnName: string;
  policies: PolicyDraft[];
  onChange: (next: PolicyDraft[]) => void;
}) {
  const groups: { kind: PolicyKind; title: string; hint: string }[] = [
    { kind: 'enter', title: `Before entering ${columnName || 'this column'}`, hint: 'Checked when a card moves into this column.' },
    { kind: 'leave', title: `Before leaving ${columnName || 'this column'}`, hint: 'Checked when a card moves out of this column.' },
  ];

  // reorder within a kind, keeping the flat list's relative order intact
  const swap = (kind: PolicyKind, a: number, b: number) => {
    const idx = policies.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === kind);
    if (b < 0 || b >= idx.length) return;
    const next = [...policies];
    [next[idx[a]!.i], next[idx[b]!.i]] = [next[idx[b]!.i]!, next[idx[a]!.i]!];
    onChange(next);
  };

  return (
    <div className="bg-gray-50 border rounded p-3 space-y-3">
      <p className="text-xs text-gray-500">
        A policy is a checklist item. Every applicable policy must be ticked before the card moves; skipping one needs an
        explicit override with a written reason, which is recorded.
      </p>
      {groups.map((g) => {
        const items = policies.filter((p) => p.kind === g.kind);
        return (
          <fieldset key={g.kind}>
            <legend className="text-xs font-semibold uppercase tracking-wide text-gray-600">{g.title}</legend>
            <p className="text-xs text-gray-400 mb-1">{g.hint}</p>
            {items.map((p, i) => (
              <div key={p.id ?? `new-${g.kind}-${i}`} className="flex items-center gap-1 mb-1">
                <button
                  aria-label="Move policy up"
                  disabled={i === 0}
                  onClick={() => swap(g.kind, i, i - 1)}
                  className="text-gray-400 hover:text-gray-700 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  aria-label="Move policy down"
                  disabled={i === items.length - 1}
                  onClick={() => swap(g.kind, i, i + 1)}
                  className="text-gray-400 hover:text-gray-700 disabled:opacity-30"
                >
                  ↓
                </button>
                <input
                  aria-label={`${g.title}, policy ${i + 1}`}
                  value={p.label}
                  placeholder="e.g. Code reviewed by a second person"
                  onChange={(e) => {
                    const flat = policies.indexOf(p);
                    onChange(policies.map((x, j) => (j === flat ? { ...x, label: e.target.value } : x)));
                  }}
                  className="border rounded px-2 py-1 flex-1 text-sm"
                />
                <button
                  aria-label={`Delete policy ${p.label || i + 1}`}
                  onClick={() => onChange(policies.filter((x) => x !== p))}
                  className="text-red-600 hover:text-red-800"
                >
                  🗑
                </button>
              </div>
            ))}
            <button
              onClick={() => onChange([...policies, { kind: g.kind, label: '' }])}
              className="text-xs border rounded px-2 py-0.5 bg-white hover:bg-gray-100"
            >
              + Add policy
            </button>
          </fieldset>
        );
      })}
    </div>
  );
}
