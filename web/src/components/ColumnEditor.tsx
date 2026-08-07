import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '../api';
import type { BoardDetail, Column, ColumnPolicy, PolicyKind } from '../types';
import { useDismiss } from '../useDismiss';

interface ColDraft {
  /** stable across reorders and deletions — policy drafts hang off it */
  key: string;
  id?: string;
  name: string;
  semantic: 'open' | 'done' | null;
}

interface LaneDraft {
  id?: string;
  name: string;
}

interface PolicyDraft {
  id?: string;
  kind: PolicyKind;
  label: string;
}

let draftSeq = 0;

/**
 * Column/lane editor. Columns are freely renamed/reordered/added; the board
 * must keep >=1 "open" and >=1 "done" mapped column (validated inline here and
 * enforced server-side).
 *
 * Each column also carries its movement policies — checklists a card must
 * satisfy before entering or before leaving it. They are saved after the
 * columns, so policies can be written for a column created in the same dialog.
 */
export default function ColumnEditor({ board, onClose }: { board: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [cols, setCols] = useState<ColDraft[]>(
    board.columns.map((c) => ({ key: c.id, id: c.id, name: c.name, semantic: c.semantic })),
  );
  const [lanes, setLanes] = useState<LaneDraft[]>(board.lanes.map((l) => ({ id: l.id, name: l.name })));
  const [policies, setPolicies] = useState<Record<string, PolicyDraft[]>>(() => initialPolicies(board.columns, board.policies));
  const [openPolicies, setOpenPolicies] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDismiss<HTMLDivElement>(onClose);

  const missingOpen = !cols.some((c) => c.semantic === 'open');
  const missingDone = !cols.some((c) => c.semantic === 'done');
  const blankPolicy = Object.values(policies).some((list) => list.some((p) => !p.label.trim()));

  const save = useMutation({
    mutationFn: async () => {
      const saved = await put<Column[]>(
        `/api/boards/${board.board.id}/columns`,
        cols.map((c, i) => ({ ...c, position: i })),
      );
      await put(`/api/boards/${board.board.id}/lanes`, lanes.map((l, i) => ({ ...l, position: i })));
      // the columns come back in the order they were sent, which is how a
      // brand-new column's policies find the id they belong to
      for (let i = 0; i < cols.length; i++) {
        const drafts = policies[cols[i]!.key] ?? [];
        const had = board.policies.some((p) => p.column_id === cols[i]!.id);
        if (drafts.length === 0 && !had) continue;
        await put(
          `/api/boards/${board.board.id}/columns/${saved[i]!.id}/policies`,
          drafts.map((d, j) => ({ ...d, label: d.label.trim(), position: j })),
        );
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board', board.board.id] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const moveCol = (i: number, dir: -1 | 1) => {
    const next = [...cols];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setCols(next);
  };

  const setColPolicies = (key: string, list: PolicyDraft[]) => setPolicies({ ...policies, [key]: list });

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit columns and lanes"
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Columns</h2>
        {(missingOpen || missingDone) && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            ⚠ The board needs at least one column mapped to {missingOpen ? '"open"' : '"done"'} — recurrence and metrics
            depend on it. The name can be anything.
          </p>
        )}
        {cols.map((c, i) => {
          const key = c.key;
          const list = policies[key] ?? [];
          return (
            <div key={key} className="border rounded p-2 space-y-2">
              <div className="flex items-center gap-2">
                <button aria-label={`Move ${c.name} left`} onClick={() => moveCol(i, -1)} className="text-gray-400 hover:text-gray-700">
                  ↑
                </button>
                <button aria-label={`Move ${c.name} right`} onClick={() => moveCol(i, 1)} className="text-gray-400 hover:text-gray-700">
                  ↓
                </button>
                <input
                  aria-label={`Column ${i + 1} name`}
                  value={c.name}
                  onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="border rounded px-2 py-1 flex-1 text-sm"
                />
                <select
                  aria-label={`Column ${i + 1} meaning`}
                  value={c.semantic ?? ''}
                  onChange={(e) =>
                    setCols(cols.map((x, j) => (j === i ? { ...x, semantic: (e.target.value || null) as ColDraft['semantic'] } : x)))
                  }
                  className="border rounded px-2 py-1 text-sm"
                >
                  <option value="">plain</option>
                  <option value="open">= open</option>
                  <option value="done">= done</option>
                </select>
                <button
                  aria-expanded={openPolicies === key}
                  onClick={() => setOpenPolicies(openPolicies === key ? null : key)}
                  className="text-xs border rounded px-2 py-1 whitespace-nowrap hover:bg-gray-50"
                >
                  ☑ Policies{list.length ? ` (${list.length})` : ''}
                </button>
                <button
                  aria-label={`Delete column ${c.name}`}
                  onClick={() => {
                    setCols(cols.filter((_, j) => j !== i));
                    setPolicies(Object.fromEntries(Object.entries(policies).filter(([k]) => k !== key)));
                  }}
                  className="text-red-600 hover:text-red-800"
                >
                  🗑
                </button>
              </div>
              {openPolicies === key && (
                <PolicyEditor columnName={c.name} policies={list} onChange={(next) => setColPolicies(key, next)} />
              )}
            </div>
          );
        })}
        <button
          onClick={() => setCols([...cols, { key: `new-${++draftSeq}`, name: 'New column', semantic: null }])}
          className="text-sm border rounded px-2 py-1 bg-gray-50 hover:bg-gray-100"
        >
          + Add column
        </button>

        <h2 className="text-lg font-bold pt-2">Lanes (swimlanes)</h2>
        {lanes.map((l, i) => (
          <div key={l.id ?? `newlane-${i}`} className="flex items-center gap-2">
            <input
              aria-label={`Lane ${i + 1} name`}
              value={l.name}
              onChange={(e) => setLanes(lanes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              className="border rounded px-2 py-1 flex-1 text-sm"
            />
            <button
              aria-label={`Delete lane ${l.name}`}
              onClick={() => setLanes(lanes.filter((_, j) => j !== i))}
              className="text-red-600 hover:text-red-800"
            >
              🗑
            </button>
          </div>
        ))}
        <button
          onClick={() => setLanes([...lanes, { name: 'New lane' }])}
          className="text-sm border rounded px-2 py-1 bg-gray-50 hover:bg-gray-100"
        >
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
            disabled={missingOpen || missingDone || save.isPending || cols.some((c) => !c.name.trim()) || blankPolicy}
            className="bg-slate-800 text-white rounded px-3 py-1 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Drafts keyed by column key, which for a saved column is its id. */
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
 * they apply. Ordering within a group is what the move checklist follows.
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
        explicit override, which is recorded.
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
