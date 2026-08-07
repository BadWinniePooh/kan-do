import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { get, post, patch, del } from '../api';
import type { Blocker } from '../types';

/**
 * Blockers on a card: add, resolve, edit, delete, and discuss in markdown.
 *
 * An active blocker (no end) holds the card in place — moving it then needs a
 * deliberate override. Resolved blockers stay as history and feed the blocked-
 * duration metrics, so resolving is a stamp, not a delete.
 */
export default function Blockers({ cardId, onChanged }: { cardId: string; onChanged: () => void }) {
  const { data: blockers = [], refetch } = useQuery<Blocker[]>({
    queryKey: ['blockers', cardId],
    queryFn: () => get(`/api/cards/${cardId}/blockers`),
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>) =>
    p
      .then(() => {
        setError(null);
        void refetch();
        onChanged();
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed'));

  const active = blockers.filter((b) => !b.ended_at);
  const resolved = blockers.filter((b) => b.ended_at);

  return (
    <section aria-label="Blockers">
      <h3 className="text-sm font-semibold text-gray-500 mb-1">
        Blockers
        {active.length > 0 && <span className="ml-2 text-rose-700">⛔ {active.length} active</span>}
      </h3>
      {error && (
        <p role="alert" className="text-sm text-red-700 mb-1">
          ⚠ {error}
        </p>
      )}

      <form
        className="flex gap-2 items-start mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason.trim()) return;
          void run(post(`/api/cards/${cardId}/blockers`, { reason: reason.trim() })).then(() => setReason(''));
        }}
      >
        <label className="sr-only" htmlFor={`blocker-${cardId}`}>
          What is blocking this card?
        </label>
        <input
          id={`blocker-${cardId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What is blocking this card?"
          className="border rounded px-2 py-1 text-sm flex-1"
        />
        <button type="submit" className="bg-rose-700 text-white rounded px-3 py-1 text-sm whitespace-nowrap">
          Add blocker
        </button>
      </form>

      {blockers.length === 0 && <p className="text-sm text-gray-500">Nothing is blocking this card.</p>}

      <div className="space-y-3">
        {[...active, ...resolved].map((b) => (
          <BlockerItem key={b.id} cardId={cardId} blocker={b} onChanged={() => void run(Promise.resolve())} />
        ))}
      </div>
    </section>
  );
}

function BlockerItem({ cardId, blocker, onChanged }: { cardId: string; blocker: Blocker; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState(blocker.reason);
  const [draft, setDraft] = useState('');
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const active = !blocker.ended_at;

  const base = `/api/cards/${cardId}/blockers/${blocker.id}`;
  const run = (p: Promise<unknown>) => p.then(onChanged);

  const startedAt = new Date(blocker.started_at);
  const endedAt = blocker.ended_at ? new Date(blocker.ended_at) : null;
  const heldMs = (endedAt ?? new Date()).getTime() - startedAt.getTime();
  const heldHours = heldMs / 3_600_000;
  const held = heldHours < 48 ? `${heldHours.toFixed(1)} h` : `${(heldHours / 24).toFixed(1)} d`;

  return (
    <article className={`border rounded p-3 ${active ? 'border-rose-300 bg-rose-50' : 'bg-gray-50'}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden>{active ? '⛔' : '✓'}</span>
        {editing ? (
          <input
            aria-label="Blocker reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="border rounded px-2 py-1 text-sm flex-1"
          />
        ) : (
          <p className="text-sm font-medium flex-1">{blocker.reason}</p>
        )}
        <span className="text-xs text-gray-500 whitespace-nowrap">{active ? `blocked ${held}` : `held ${held}`}</span>
      </div>

      <p className="text-xs text-gray-500 mt-1">
        {startedAt.toLocaleString()}
        {blocker.created_by_name && ` · ${blocker.created_by_name}`}
        {endedAt && ` → resolved ${endedAt.toLocaleString()}`}
        {endedAt && blocker.resolved_by_name && ` by ${blocker.resolved_by_name}`}
      </p>

      <div className="flex gap-3 mt-1 text-xs">
        {editing ? (
          <>
            <button
              className="underline"
              onClick={() => {
                if (reason.trim()) void run(patch(base, { reason: reason.trim() })).then(() => setEditing(false));
              }}
            >
              save
            </button>
            <button
              className="underline"
              onClick={() => {
                setReason(blocker.reason);
                setEditing(false);
              }}
            >
              cancel
            </button>
          </>
        ) : (
          <button className="underline" onClick={() => setEditing(true)}>
            edit reason
          </button>
        )}
        {active ? (
          <button className="underline text-emerald-800 font-medium" onClick={() => void run(post(`${base}/resolve`))}>
            resolve
          </button>
        ) : (
          <button className="underline" onClick={() => void run(patch(base, { endedAt: null }))}>
            reopen
          </button>
        )}
        <button
          className="underline text-red-700"
          onClick={() => {
            if (window.confirm('Delete this blocker and its comments? Its blocked time disappears from the metrics.')) {
              void run(del(base));
            }
          }}
        >
          delete
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {(blocker.comments ?? []).map((c) =>
          editingComment === c.id ? (
            <div key={c.id}>
              <textarea
                aria-label="Edit comment (markdown)"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={3}
                className="w-full border rounded p-2 text-sm font-mono"
              />
              <div className="flex gap-2 mt-1">
                <button
                  className="text-xs bg-slate-800 text-white rounded px-2 py-1"
                  onClick={() =>
                    void run(patch(`${base}/comments/${c.id}`, { markdown: commentText })).then(() => setEditingComment(null))
                  }
                >
                  Save
                </button>
                <button className="text-xs border rounded px-2 py-1" onClick={() => setEditingComment(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div key={c.id} className="bg-white border rounded p-2">
              <div className="prose prose-sm max-w-none">
                <ReactMarkdown>{c.markdown}</ReactMarkdown>
              </div>
              <div className="flex gap-3 mt-1 text-xs text-gray-500">
                <span>
                  {new Date(c.created_at).toLocaleString()}
                  {c.author_name && ` · ${c.author_name}`}
                </span>
                <button
                  className="underline"
                  onClick={() => {
                    setEditingComment(c.id);
                    setCommentText(c.markdown);
                  }}
                >
                  edit markdown
                </button>
                <button
                  className="underline text-red-700"
                  onClick={() => {
                    if (window.confirm('Delete this comment? This cannot be undone.')) {
                      void run(del(`${base}/comments/${c.id}`));
                    }
                  }}
                >
                  delete
                </button>
              </div>
            </div>
          ),
        )}
      </div>

      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void run(post(`${base}/comments`, { markdown: draft })).then(() => setDraft(''));
        }}
      >
        <label className="sr-only" htmlFor={`bc-${blocker.id}`}>
          New comment (markdown supported)
        </label>
        <textarea
          id={`bc-${blocker.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Add a comment… (markdown supported)"
          className="w-full border rounded p-2 text-sm"
        />
        <button type="submit" className="mt-1 text-xs bg-slate-800 text-white rounded px-2 py-1">
          Add comment
        </button>
      </form>
    </article>
  );
}
