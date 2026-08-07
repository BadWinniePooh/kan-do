import { useMemo, useState } from 'react';
import { post, ApiError } from '../api';
import type { MoveRequirements, PolicyRef } from '../types';
import { useDismiss } from '../useDismiss';

/**
 * The gate a card passes through on its way to another column.
 *
 * Shows the source column's "before leaving" checklist and the target column's
 * "before entering" checklist. Ticks are persisted on the card on every attempt
 * — including refused ones — so partial progress is never re-entered.
 *
 * Two things can block the move: unticked policies, and the board's rule that
 * cards never move backwards. Each has an explicit, separately-confirmed
 * override, and every override is recorded.
 */
export default function MovePolicyDialog({
  cardId,
  cardTitle,
  laneId,
  requirements,
  onClose,
  onMoved,
}: {
  cardId: string;
  cardTitle: string;
  laneId: string | null;
  requirements: MoveRequirements;
  onClose: () => void;
  onMoved: () => void;
}) {
  const dialogRef = useDismiss<HTMLDivElement>(onClose);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(requirements.checkedIds));
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { applicable, backwards, fromColumn, toColumn } = requirements;
  const leaving = useMemo(() => applicable.filter((p) => p.kind === 'leave'), [applicable]);
  const entering = useMemo(() => applicable.filter((p) => p.kind === 'enter'), [applicable]);
  const unmet = applicable.filter((p) => !checked.has(p.id));
  const skippingPolicies = unmet.length > 0;
  const clean = !skippingPolicies && !backwards;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ackIds = () => [...checked];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onMoved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'move failed');
      setBusy(false);
    }
  };

  const doMove = (override?: { policies?: boolean; backwards?: boolean; reason?: string }) =>
    run(() =>
      post(`/api/cards/${cardId}/move`, {
        toColumnId: toColumn.id,
        laneId,
        position: Date.now(),
        acknowledgedPolicyIds: ackIds(),
        ...(override ? { override } : {}),
      }),
    );

  const saveProgressOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/cards/${cardId}/move-progress`, { toColumnId: toColumn.id, acknowledgedPolicyIds: ackIds() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save progress');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Move "${cardTitle}" to ${toColumn.name}`}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-bold">Move “{cardTitle}”</h2>
          <p className="text-sm text-gray-500">
            {fromColumn?.name ?? 'Current column'} → {toColumn.name}
          </p>
        </div>

        {backwards && (
          <div role="alert" className="text-sm bg-amber-50 border border-amber-300 rounded p-3">
            <p className="font-semibold text-amber-900">This move goes backwards on the board.</p>
            <p className="text-amber-900 mt-1">
              {toColumn.name} sits earlier in this board&rsquo;s column order than {fromColumn?.name ?? 'the current column'}.
              Cards are not meant to travel backwards, so this move is blocked unless it is explicitly overridden.
            </p>
          </div>
        )}

        {confirming ? (
          <OverrideConfirmation
            backwards={backwards}
            skipped={unmet}
            fromName={fromColumn?.name ?? 'the current column'}
            toName={toColumn.name}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
            reason={reason}
            onReason={setReason}
          />
        ) : applicable.length === 0 ? (
          <p className="text-sm text-gray-600">No column policies apply to this move.</p>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              Work through the checklist below. The card only moves once every item is ticked — your ticks are saved on the
              card either way.
            </p>
            <PolicyChecklist title={`Before leaving ${fromColumn?.name ?? 'this column'}`} policies={leaving} checked={checked} onToggle={toggle} />
            <PolicyChecklist title={`Before entering ${toColumn.name}`} policies={entering} checked={checked} onToggle={toggle} />
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            ⚠ {error}
          </p>
        )}

        <div className="flex gap-2 justify-end flex-wrap pt-1">
          {confirming ? (
            <>
              <button onClick={() => setConfirming(false)} disabled={busy} className="border rounded px-3 py-1 text-sm">
                Back
              </button>
              <button
                disabled={!acknowledged || busy}
                onClick={() =>
                  doMove({
                    policies: skippingPolicies || undefined,
                    backwards: backwards || undefined,
                    reason: reason.trim() || undefined,
                  })
                }
                className="bg-red-700 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                {busy ? 'Moving…' : 'Override and move'}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} disabled={busy} className="border rounded px-3 py-1 text-sm">
                Cancel
              </button>
              {applicable.length > 0 && (
                <button onClick={saveProgressOnly} disabled={busy} className="border rounded px-3 py-1 text-sm">
                  Save progress, don&rsquo;t move
                </button>
              )}
              {clean ? (
                <button
                  disabled={busy}
                  onClick={() => doMove()}
                  className="bg-slate-800 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                >
                  {busy ? 'Moving…' : 'Move card'}
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  className="border border-red-700 text-red-700 rounded px-3 py-1 text-sm disabled:opacity-50"
                >
                  Override…
                </button>
              )}
            </>
          )}
        </div>
        {!confirming && !clean && (
          <p className="text-xs text-gray-500 text-right">
            {skippingPolicies && backwards
              ? `${unmet.length} unticked ${unmet.length === 1 ? 'policy' : 'policies'} and a backwards move block this.`
              : skippingPolicies
                ? `${unmet.length} ${unmet.length === 1 ? 'policy is' : 'policies are'} still unticked.`
                : 'A backwards move blocks this.'}
          </p>
        )}
      </div>
    </div>
  );
}

function PolicyChecklist({
  title,
  policies,
  checked,
  onToggle,
}: {
  title: string;
  policies: PolicyRef[];
  checked: Set<string>;
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
              <input type="checkbox" className="mt-0.5" checked={checked.has(p.id)} onChange={() => onToggle(p.id)} />
              <span>{p.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * Deliberately unfriendly: it names exactly what is being skipped and says
 * plainly that the override is recorded, so nobody clicks through it by habit.
 */
function OverrideConfirmation({
  backwards,
  skipped,
  fromName,
  toName,
  acknowledged,
  onAcknowledge,
  reason,
  onReason,
}: {
  backwards: boolean;
  skipped: PolicyRef[];
  fromName: string;
  toName: string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  reason: string;
  onReason: (v: string) => void;
}) {
  return (
    <div className="border-2 border-red-300 bg-red-50 rounded p-3 space-y-3">
      <h3 className="font-bold text-red-900">You are about to override this board&rsquo;s rules</h3>

      {backwards && (
        <p className="text-sm text-red-900">
          <strong>Backwards move.</strong> {toName} comes before {fromName} in this board&rsquo;s column order. Normal moves
          may not go backwards.
        </p>
      )}

      {skipped.length > 0 && (
        <div className="text-sm text-red-900">
          <p>
            <strong>
              {skipped.length} {skipped.length === 1 ? 'policy' : 'policies'} will be skipped
            </strong>{' '}
            without being completed:
          </p>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            {skipped.map((p) => (
              <li key={p.id}>
                {p.label} <span className="text-red-700">({p.kind === 'leave' ? `before leaving ${p.columnName}` : `before entering ${p.columnName}`})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="block text-sm text-red-900">
        Reason (optional, stored with the override)
        <textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={2}
          className="mt-1 w-full border rounded px-2 py-1 bg-white"
          placeholder="Why is this move being forced?"
        />
      </label>

      <label className="flex items-start gap-2 text-sm font-medium text-red-900">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
        <span>
          I understand this is a deliberate override, not the normal path, and that it will be recorded against this card
          with my name and the time.
        </span>
      </label>
    </div>
  );
}
