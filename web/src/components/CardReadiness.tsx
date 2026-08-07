import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../api';
import type { Column, MoveRequirements, PolicyRef } from '../types';
import { useDismiss } from '../useDismiss';

/**
 * "Is this card ready to move?" — answered WITHOUT attempting a move.
 *
 * Shows the current column's before-leaving checklist plus, once a destination
 * is picked, that column's before-entering checklist, and lets both be ticked
 * ahead of time. Ticks persist on the card exactly as they do during a real
 * move, so the work done here is the work the move will find already done.
 *
 * Deliberately has no "move" button: this is the preview, not the gate.
 */
export default function CardReadiness({
  cardId,
  cardTitle,
  laneColumns,
  currentColumnId,
  onClose,
  onSaved,
}: {
  cardId: string;
  cardTitle: string;
  /** the card's own lane's columns, in order — the realistic destinations */
  laneColumns: Column[];
  currentColumnId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useDismiss<HTMLDivElement>(onClose);
  const forward = laneColumns.filter((c) => c.id !== currentColumnId);
  const [target, setTarget] = useState<string>(() => {
    const here = laneColumns.findIndex((c) => c.id === currentColumnId);
    return laneColumns[here + 1]?.id ?? forward[0]?.id ?? '';
  });
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, error: loadError } = useQuery<MoveRequirements>({
    queryKey: ['move-requirements', cardId, target],
    queryFn: () => get(`/api/cards/${cardId}/move-requirements?toColumnId=${target}`),
    enabled: !!target,
  });

  // server state seeds the boxes; local state takes over once the user ticks
  const ticked = checked ?? new Set(data?.checkedIds ?? []);
  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
    setSaved(false);
  };

  const leaving = (data?.applicable ?? []).filter((p) => p.kind === 'leave');
  const entering = (data?.applicable ?? []).filter((p) => p.kind === 'enter');
  const outstanding = (data?.applicable ?? []).filter((p) => !ticked.has(p.id));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/cards/${cardId}/move-progress`, { toColumnId: target, acknowledgedPolicyIds: [...ticked] });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save progress');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Move readiness for ${cardTitle}`}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-bold">Ready to move?</h2>
          <p className="text-sm text-gray-500">
            “{cardTitle}” — tick things off now; nothing is moved from here.
          </p>
        </div>

        <label className="block text-sm">
          Check against destination
          <select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setChecked(null);
              setSaved(false);
            }}
            className="mt-1 w-full border rounded px-2 py-1"
          >
            {forward.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.semantic ? ` (${c.semantic})` : ''}
              </option>
            ))}
          </select>
        </label>

        {loadError && (
          <p role="alert" className="text-sm text-red-700">
            ⚠ {String(loadError)}
          </p>
        )}

        {data && (
          <>
            {data.activeBlockers.length > 0 && (
              <div role="alert" className="text-sm bg-rose-50 border border-rose-300 rounded p-3">
                <p className="font-semibold text-rose-900">
                  ⛔ Blocked by {data.activeBlockers.length} unresolved {data.activeBlockers.length === 1 ? 'blocker' : 'blockers'}.
                </p>
                <ul className="list-disc pl-5 mt-1 text-rose-900">
                  {data.activeBlockers.map((b) => (
                    <li key={b.id}>{b.reason}</li>
                  ))}
                </ul>
                <p className="text-rose-800 mt-1">Resolve them on the card, or the move will need an override.</p>
              </div>
            )}

            {data.applicable.length === 0 ? (
              <p className="text-sm text-gray-600">No column policies apply to this move.</p>
            ) : (
              <>
                <Checklist title={`Before leaving ${data.fromColumn?.name ?? 'this column'}`} policies={leaving} ticked={ticked} onToggle={toggle} />
                <Checklist title={`Before entering ${data.toColumn.name}`} policies={entering} ticked={ticked} onToggle={toggle} />
                <p className={`text-sm font-medium ${outstanding.length === 0 ? 'text-emerald-800' : 'text-amber-800'}`}>
                  {outstanding.length === 0
                    ? '✓ Every policy for this move is ticked.'
                    : `${outstanding.length} still outstanding.`}
                </p>
              </>
            )}

            {(data.backwards || data.laneMove || data.discarding) && (
              <p className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded p-2">
                Heads up: this move{' '}
                {[data.backwards && 'goes backwards', data.laneMove && 'changes lane', data.discarding && 'discards the card']
                  .filter(Boolean)
                  .join(', ')}
                , so it will ask for a reason{data.discarding && !data.backwards && !data.laneMove ? '' : ' and an override'}.
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-700">
            ⚠ {error}
          </p>
        )}

        <div className="flex gap-2 justify-end items-center pt-1">
          {saved && <span className="text-xs text-emerald-700 mr-auto">Progress saved.</span>}
          <button onClick={onClose} className="border rounded px-3 py-1 text-sm">
            Close
          </button>
          <button
            onClick={save}
            disabled={busy || !data || data.applicable.length === 0}
            className="bg-slate-800 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save progress'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Checklist({
  title,
  policies,
  ticked,
  onToggle,
}: {
  title: string;
  policies: PolicyRef[];
  ticked: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (policies.length === 0) return null;
  return (
    <fieldset className="border rounded p-3">
      <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500 px-1">{title}</legend>
      <ul className="space-y-2">
        {policies.map((p) => (
          <li key={p.id}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={ticked.has(p.id)} onChange={() => onToggle(p.id)} />
              <span>{p.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
