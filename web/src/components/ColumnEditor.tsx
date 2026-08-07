import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { put } from '../api';
import type { BoardDetail } from '../types';
import { useDismiss } from '../useDismiss';

interface ColDraft {
  id?: string;
  name: string;
  semantic: 'open' | 'done' | null;
}

interface LaneDraft {
  id?: string;
  name: string;
}

/**
 * Column/lane editor. Columns are freely renamed/reordered/added; the board
 * must keep >=1 "open" and >=1 "done" mapped column (validated inline here and
 * enforced server-side).
 */
export default function ColumnEditor({ board, onClose }: { board: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [cols, setCols] = useState<ColDraft[]>(board.columns.map((c) => ({ id: c.id, name: c.name, semantic: c.semantic })));
  const [lanes, setLanes] = useState<LaneDraft[]>(board.lanes.map((l) => ({ id: l.id, name: l.name })));
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDismiss<HTMLDivElement>(onClose);

  const missingOpen = !cols.some((c) => c.semantic === 'open');
  const missingDone = !cols.some((c) => c.semantic === 'done');

  const save = useMutation({
    mutationFn: async () => {
      await put(`/api/boards/${board.board.id}/columns`, cols.map((c, i) => ({ ...c, position: i })));
      await put(`/api/boards/${board.board.id}/lanes`, lanes.map((l, i) => ({ ...l, position: i })));
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

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit columns and lanes"
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Columns</h2>
        {(missingOpen || missingDone) && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            ⚠ The board needs at least one column mapped to {missingOpen ? '"open"' : '"done"'} — recurrence and metrics
            depend on it. The name can be anything.
          </p>
        )}
        {cols.map((c, i) => (
          <div key={c.id ?? `new-${i}`} className="flex items-center gap-2">
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
              aria-label={`Delete column ${c.name}`}
              onClick={() => setCols(cols.filter((_, j) => j !== i))}
              className="text-red-600 hover:text-red-800"
            >
              🗑
            </button>
          </div>
        ))}
        <button
          onClick={() => setCols([...cols, { name: 'New column', semantic: null }])}
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
            disabled={missingOpen || missingDone || save.isPending || cols.some((c) => !c.name.trim())}
            className="bg-slate-800 text-white rounded px-3 py-1 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
