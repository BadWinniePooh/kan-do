import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import type { AuditColumn, AuditEntry, CardAudit } from '../types';
import { Spinner } from './Loading';

/**
 * The card's whole life, top to bottom: created, every column change, and every
 * time a rule was overridden — each with who, when and why.
 *
 * Read-only and built from records that already exist (the transition history
 * behind the cycle/lead metrics, plus the override audit), so it can never
 * disagree with them. Visible to anyone who can already see the card.
 */
export default function CardAuditView({ cardId }: { cardId: string }) {
  const { data, error } = useQuery<CardAudit>({ queryKey: ['card-audit', cardId], queryFn: () => get(`/api/cards/${cardId}/audit`) });

  if (error)
    return (
      <p role="alert" className="text-sm text-red-700">
        ⚠ Could not load history: {String(error)}
      </p>
    );
  if (!data) return <Spinner label="Loading history" />;

  return (
    <section aria-label="Card history">
      <ol className="relative border-l-2 border-gray-200 ml-2 space-y-4">
        {data.timeline.map((entry, i) => (
          <TimelineEntry key={i} entry={entry} />
        ))}
        <li className="ml-4 text-xs text-gray-400">— now —</li>
      </ol>
    </section>
  );
}

const place = (c: AuditColumn | null) => (c ? (c.laneName ? `${c.laneName} · ${c.name}` : c.name) : 'somewhere unknown');

function TimelineEntry({ entry }: { entry: AuditEntry }) {
  const when = new Date(entry.at).toLocaleString();
  const who = entry.actorName ?? 'the system';

  if (entry.kind === 'created') {
    return (
      <Item dot="bg-emerald-500" when={when}>
        <p className="text-sm">
          <strong>{who}</strong> created this card in <em>{place(entry.column)}</em>.
        </p>
      </Item>
    );
  }

  if (entry.kind === 'blocked') {
    return (
      <Item dot="bg-rose-600" when={when}>
        <p className="text-sm text-rose-900">
          ⛔ <strong>{who}</strong> blocked this card.
        </p>
        <Reason text={entry.reason} label="Blocker" />
      </Item>
    );
  }

  if (entry.kind === 'unblocked') {
    return (
      <Item dot="bg-emerald-500" when={when}>
        <p className="text-sm">
          <strong>{who}</strong> resolved the blocker.
        </p>
        <Reason text={entry.reason} label="Was blocked by" />
      </Item>
    );
  }

  if (entry.kind === 'moved') {
    return (
      <Item dot={entry.discarded ? 'bg-stone-500' : 'bg-blue-500'} when={when}>
        <p className="text-sm">
          <strong>{who}</strong> {entry.discarded ? 'discarded this card into' : 'moved it from'}{' '}
          {entry.discarded ? (
            <em>{place(entry.to)}</em>
          ) : (
            <>
              <em>{place(entry.from)}</em> to <em>{place(entry.to)}</em>
            </>
          )}
          {entry.laneChanged && <span className="text-amber-800"> (across lanes)</span>}.
        </p>
        {entry.reason && <Reason text={entry.reason} label={entry.discarded ? 'Discard reason' : 'Reason'} />}
      </Item>
    );
  }

  const broken = [
    entry.laneMove && 'moved the card to another lane',
    entry.backwards && 'moved the card backwards',
    entry.bypassedBlockers.length > 0 &&
      `moved it past ${entry.bypassedBlockers.length} active ${entry.bypassedBlockers.length === 1 ? 'blocker' : 'blockers'}`,
    entry.skipped.length > 0 && `skipped ${entry.skipped.length} ${entry.skipped.length === 1 ? 'policy' : 'policies'}`,
  ].filter(Boolean) as string[];

  return (
    <Item dot="bg-red-600" when={when}>
      <p className="text-sm text-red-900">
        ⚠ <strong>{who}</strong> overrode the rules: {broken.join(', ')}.
      </p>
      {entry.bypassedBlockers.length > 0 && (
        <ul className="list-disc pl-5 mt-1 text-sm text-red-900">
          {entry.bypassedBlockers.map((b, i) => (
            <li key={i}>
              {b.reason} <span className="text-red-700 text-xs">(blocker was still active)</span>
            </li>
          ))}
        </ul>
      )}
      {entry.skipped.length > 0 && (
        <ul className="list-disc pl-5 mt-1 text-sm text-red-900">
          {entry.skipped.map((s, i) => (
            <li key={i}>
              {s.label}{' '}
              <span className="text-red-700 text-xs">
                ({s.kind === 'leave' ? 'before leaving' : 'before entering'}
                {s.columnName ? ` ${s.columnName}` : ''})
              </span>
            </li>
          ))}
        </ul>
      )}
      <Reason text={entry.reason} label="Justification" missing="No reason was recorded (override predates this being required)." />
    </Item>
  );
}

function Reason({ text, label, missing }: { text: string | null; label: string; missing?: string }) {
  if (!text) return missing ? <p className="text-xs text-gray-500 italic mt-1">{missing}</p> : null;
  return (
    <p className="text-sm mt-1 bg-gray-50 border-l-2 border-gray-300 pl-2 py-1">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}: </span>
      {text}
    </p>
  );
}

function Item({ dot, when, children }: { dot: string; when: string; children: React.ReactNode }) {
  return (
    <li className="ml-4">
      <span aria-hidden className={`absolute -left-[7px] w-3 h-3 rounded-full ${dot} ring-2 ring-white`} />
      <time className="text-xs text-gray-500">{when}</time>
      {children}
    </li>
  );
}
