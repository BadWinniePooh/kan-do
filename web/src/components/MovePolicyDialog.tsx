import { useMemo, useState } from 'react';
import { post, ApiError } from '../api';
import type { BlockerRef, MoveRequirements, PolicyRef } from '../types';
import { useDismiss } from '../useDismiss';

/**
 * The gate a card passes through on its way to another column.
 *
 * Shows the source column's "before leaving" checklist and the target column's
 * "before entering" checklist. Ticks are persisted on the card on every attempt
 * — including refused ones — so partial progress is never re-entered.
 *
 * Three things can block the move: unticked policies, moving backwards through
 * the lane's column order, and moving to a different lane. Each has an explicit,
 * separately-confirmed override. Overrides and discards both demand a written
 * reason, which lands in the card's audit timeline.
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
  laneId: string;
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

  const { applicable, backwards, laneMove, discarding, activeBlockers, fromColumn, toColumn } = requirements;
  const leaving = useMemo(() => applicable.filter((p) => p.kind === 'leave'), [applicable]);
  const entering = useMemo(() => applicable.filter((p) => p.kind === 'enter'), [applicable]);
  const unmet = applicable.filter((p) => !checked.has(p.id));
  const skippingPolicies = unmet.length > 0;
  const blocked = activeBlockers.length > 0;
  const overriding = skippingPolicies || backwards || laneMove || blocked;
  // discarding is not an override, but it still owes an explanation
  const needsReason = overriding || discarding;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const doMove = (withOverride: boolean) =>
    run(() =>
      post(`/api/cards/${cardId}/move`, {
        toColumnId: toColumn.id,
        laneId,
        position: Date.now(),
        acknowledgedPolicyIds: [...checked],
        ...(needsReason ? { reason: reason.trim() } : {}),
        ...(withOverride
          ? {
              override: {
                policies: skippingPolicies || undefined,
                backwards: backwards || undefined,
                lane: laneMove || undefined,
                blockers: blocked || undefined,
              },
            }
          : {}),
      }),
    );

  const saveProgressOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/cards/${cardId}/move-progress`, { toColumnId: toColumn.id, acknowledgedPolicyIds: [...checked] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save progress');
      setBusy(false);
    }
  };

  // a plain discard needs its reason but no override ceremony
  const canMoveNow = !overriding && (!discarding || reason.trim().length > 0);

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
            {fromColumn ? `${fromColumn.laneName} · ${fromColumn.name}` : 'Current column'} →{' '}
            {`${toColumn.laneName} · ${toColumn.name}`}
          </p>
        </div>

        {blocked && (
          <div role="alert" className="text-sm bg-rose-50 border border-rose-300 rounded p-3">
            <p className="font-semibold text-rose-900">
              This card is blocked by {activeBlockers.length} unresolved {activeBlockers.length === 1 ? 'blocker' : 'blockers'}.
            </p>
            <ul className="list-disc pl-5 mt-1 text-rose-900">
              {activeBlockers.map((b) => (
                <li key={b.id}>
                  {b.reason} <span className="text-rose-700 text-xs">(since {new Date(b.startedAt).toLocaleDateString()})</span>
                </li>
              ))}
            </ul>
            <p className="text-rose-900 mt-1">
              Resolve the blocker on the card to move normally, or override deliberately below.
            </p>
          </div>
        )}

        {laneMove && (
          <div role="alert" className="text-sm bg-amber-50 border border-amber-300 rounded p-3">
            <p className="font-semibold text-amber-900">This move changes the card&rsquo;s lane.</p>
            <p className="text-amber-900 mt-1">
              Each lane has its own independent columns and its own flow. Cards are not meant to travel between lanes, so
              this move is blocked unless it is explicitly overridden.
            </p>
          </div>
        )}

        {backwards && (
          <div role="alert" className="text-sm bg-amber-50 border border-amber-300 rounded p-3">
            <p className="font-semibold text-amber-900">This move goes backwards.</p>
            <p className="text-amber-900 mt-1">
              {toColumn.name} sits earlier than {fromColumn?.name ?? 'the current column'} in the {toColumn.laneName}{' '}
              lane&rsquo;s column order. Cards are not meant to travel backwards, so this move is blocked unless it is
              explicitly overridden.
            </p>
          </div>
        )}

        {discarding && !confirming && (
          <div className="text-sm bg-stone-100 border border-stone-300 rounded p-3">
            <p className="font-semibold text-stone-800">You are discarding this card.</p>
            <p className="text-stone-700 mt-1">
              {toColumn.name} is a discard column: the card counts as finished but reverted, not as completed work, and a
              recurring card stops recurring while it rests there. Say why below — it is kept in the card&rsquo;s history.
            </p>
          </div>
        )}

        {confirming ? (
          <OverrideConfirmation
            backwards={backwards}
            laneMove={laneMove}
            activeBlockers={activeBlockers}
            skipped={unmet}
            fromName={fromColumn?.name ?? 'the current column'}
            fromLane={fromColumn?.laneName ?? ''}
            toName={toColumn.name}
            toLane={toColumn.laneName}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
          />
        ) : applicable.length === 0 ? (
          !discarding && <p className="text-sm text-gray-600">No column policies apply to this move.</p>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              Work through the checklist below. The card only moves once every item is ticked — your ticks are saved on the
              card either way.
            </p>
            <PolicyChecklist
              title={`Before leaving ${fromColumn?.name ?? 'this column'}`}
              policies={leaving}
              checked={checked}
              onToggle={toggle}
            />
            <PolicyChecklist title={`Before entering ${toColumn.name}`} policies={entering} checked={checked} onToggle={toggle} />
          </>
        )}

        {needsReason && (
          <label className="block text-sm font-medium">
            Reason <span className="text-red-700">(required)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
              className="mt-1 w-full border rounded px-2 py-1 font-normal"
              placeholder={discarding && !overriding ? 'Why is this card being discarded?' : 'Why is this move being forced?'}
            />
            <span className="text-xs font-normal text-gray-500">Stored with the card and shown in its audit timeline.</span>
          </label>
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
                disabled={!acknowledged || !reason.trim() || busy}
                title={!reason.trim() ? 'A reason is required to override' : undefined}
                onClick={() => doMove(true)}
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
              {overriding ? (
                <button
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  className="border border-red-700 text-red-700 rounded px-3 py-1 text-sm disabled:opacity-50"
                >
                  Override…
                </button>
              ) : (
                <button
                  disabled={busy || !canMoveNow}
                  title={!canMoveNow ? 'A reason is required to discard a card' : undefined}
                  onClick={() => doMove(false)}
                  className="bg-slate-800 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                >
                  {busy ? 'Moving…' : discarding ? 'Discard card' : 'Move card'}
                </button>
              )}
            </>
          )}
        </div>
        {!confirming && overriding && (
          <p className="text-xs text-gray-500 text-right">
            {[
              skippingPolicies && `${unmet.length} unticked ${unmet.length === 1 ? 'policy' : 'policies'}`,
              blocked && `${activeBlockers.length} active ${activeBlockers.length === 1 ? 'blocker' : 'blockers'}`,
              backwards && 'a backwards move',
              laneMove && 'a lane change',
            ]
              .filter(Boolean)
              .join(' and ')}{' '}
            block this.
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
 * Deliberately unfriendly: it names exactly which rules are being broken and
 * says plainly that the override is recorded, so nobody clicks through it by
 * habit. The reason field lives outside this panel because a discard needs one
 * too, without any of this ceremony.
 */
function OverrideConfirmation({
  backwards,
  laneMove,
  activeBlockers,
  skipped,
  fromName,
  fromLane,
  toName,
  toLane,
  acknowledged,
  onAcknowledge,
}: {
  backwards: boolean;
  laneMove: boolean;
  activeBlockers: BlockerRef[];
  skipped: PolicyRef[];
  fromName: string;
  fromLane: string;
  toName: string;
  toLane: string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  return (
    <div className="border-2 border-red-300 bg-red-50 rounded p-3 space-y-3">
      <h3 className="font-bold text-red-900">You are about to override this board&rsquo;s rules</h3>

      {activeBlockers.length > 0 && (
        <div className="text-sm text-red-900">
          <p>
            <strong>
              The card is still blocked by {activeBlockers.length} unresolved{' '}
              {activeBlockers.length === 1 ? 'blocker' : 'blockers'}
            </strong>{' '}
            — moving it does not resolve them:
          </p>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            {activeBlockers.map((b) => (
              <li key={b.id}>
                {b.reason} <span className="text-red-700 text-xs">(blocked since {new Date(b.startedAt).toLocaleString()})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {laneMove && (
        <p className="text-sm text-red-900">
          <strong>Lane change.</strong> The card leaves the {fromLane} lane for {toLane}. Lanes have independent columns
          and independent flows; cards are not meant to cross between them.
        </p>
      )}

      {backwards && (
        <p className="text-sm text-red-900">
          <strong>Backwards move.</strong> {toName} comes before {fromName} in the {toLane} lane&rsquo;s column order.
          Normal moves may not go backwards.
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
                {p.label}{' '}
                <span className="text-red-700">
                  ({p.kind === 'leave' ? `before leaving ${p.columnName}` : `before entering ${p.columnName}`})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex items-start gap-2 text-sm font-medium text-red-900">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
        <span>
          I understand this is a deliberate override, not the normal path, and that it will be recorded against this card
          with my name, the time and my reason.
        </span>
      </label>
    </div>
  );
}
