import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { RecurrenceRule } from '@kan-do/shared';
import { get, post, patch, del } from '../api';
import type { BoardDetail, CardDetail } from '../types';
import OwnerBadge from './OwnerBadge';
import RecurrenceBuilder from './RecurrenceBuilder';
import OwnerPicker from './OwnerPicker';

export default function CardModal({ cardId, board, onClose }: { cardId: string; board: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, error } = useQuery<CardDetail>({ queryKey: ['card', cardId], queryFn: () => get(`/api/cards/${cardId}`) });
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['card', cardId] });
    void qc.invalidateQueries({ queryKey: ['board', board.board.id] });
  };

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/api/cards/${cardId}`, body),
    onSuccess: invalidate,
  });

  if (error)
    return (
      <Overlay onClose={onClose}>
        <p role="alert" className="p-6 text-red-700">⚠ Could not load card: {String(error)}</p>
      </Overlay>
    );
  if (!data) return null;
  const { card } = data;

  return (
    <Overlay onClose={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit card ${card.title}`}
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 space-y-5">
          <div className="flex items-start gap-2">
            <TitleEditor title={card.title} onSave={(t) => update.mutate({ title: t })} />
            <button onClick={onClose} aria-label="Close card" className="text-gray-400 hover:text-gray-700 text-xl leading-none">
              ×
            </button>
          </div>

          {card.is_overdue && (
            <p role="status" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              ⚠ This task is overdue.
            </p>
          )}
          {update.isError && (
            <p role="alert" className="text-sm text-red-700">⚠ Save failed: {update.error.message}</p>
          )}

          <section aria-label="Owners">
            <h3 className="text-sm font-semibold text-gray-500 mb-1">Owners</h3>
            <div className="flex items-center gap-2 flex-wrap">
              {data.owners.map((o, i) => (
                <OwnerBadge key={i} owner={o} />
              ))}
              <OwnerPicker card={card} board={board} current={data.owners} onChanged={invalidate} />
            </div>
          </section>

          <section aria-label="Schedule" className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-500">Schedule</h3>
            <RecurrenceBuilder
              value={card.recurrence_rule}
              onChange={(rule: RecurrenceRule | null) => update.mutate({ recurrenceRule: rule })}
            />
            {!card.recurrence_rule && (
              <label className="text-sm flex items-center gap-2">
                Due date
                <input
                  type="date"
                  value={card.due_date ? card.due_date.slice(0, 10) : ''}
                  onChange={(e) =>
                    update.mutate({ dueDate: e.target.value ? new Date(e.target.value + 'T23:59:59').toISOString() : null })
                  }
                  className="border rounded px-2 py-1"
                />
                {card.due_date && (
                  <button type="button" className="text-xs underline text-gray-500" onClick={() => update.mutate({ dueDate: null })}>
                    clear
                  </button>
                )}
              </label>
            )}
            {card.recurrence_status === 'awaiting_reopen' && card.reopen_at && (
              <p className="text-xs text-gray-500">Reopens {new Date(card.reopen_at).toLocaleString()}</p>
            )}
            {card.recurrence_status === 'reopened' && card.overdue_at && (
              <p className="text-xs text-gray-500">Finish before {new Date(card.overdue_at).toLocaleString()} or it goes overdue</p>
            )}
          </section>

          <DescriptionEditor value={card.description ?? ''} onSave={(d) => update.mutate({ description: d || null })} />

          <Gallery data={data} cardId={cardId} onChanged={invalidate} />

          <Notes cardId={cardId} notes={data.notes} onChanged={invalidate} />
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      {children}
    </div>
  );
}

function TitleEditor({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  return (
    <input
      aria-label="Card title"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value !== title && onSave(value.trim())}
      className="text-xl font-bold flex-1 border-b border-transparent focus:border-gray-300 outline-none"
    />
  );
}

function DescriptionEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <section aria-label="Description">
      <h3 className="text-sm font-semibold text-gray-500 mb-1">Description</h3>
      <textarea
        aria-label="Card description"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onSave(text)}
        rows={3}
        className="w-full border rounded p-2 text-sm"
        placeholder="Add a description…"
      />
    </section>
  );
}

function Gallery({ data, cardId, onChanged }: { data: CardDetail; cardId: string; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File, asCover: boolean) => {
    setError(null);
    setUploading(true);
    try {
      const { key, uploadUrl } = await post<{ key: string; uploadUrl: string }>('/api/me/uploads/presign', {
        filename: file.name,
        contentType: file.type,
        purpose: 'card',
        cardId,
      });
      const putRes = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`);
      await post('/api/me/uploads/confirm', {
        key,
        cardId,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        asCover,
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <section aria-label="Pictures">
      <h3 className="text-sm font-semibold text-gray-500 mb-1">Pictures</h3>
      <div className="grid grid-cols-3 gap-2">
        {data.attachments
          .filter((a) => a.content_type.startsWith('image/'))
          .map((a) => (
            <figure key={a.id} className="relative group">
              <img src={a.url} alt={a.filename} className="rounded h-24 w-full object-cover" />
              {data.card.cover_attachment_id === a.id ? (
                <figcaption className="absolute top-1 left-1 text-xs bg-black/60 text-white rounded px-1">cover</figcaption>
              ) : (
                <button
                  className="absolute top-1 left-1 text-xs bg-white/80 rounded px-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  onClick={() => patch(`/api/cards/${cardId}`, { coverAttachmentId: a.id }).then(onChanged)}
                >
                  set cover
                </button>
              )}
            </figure>
          ))}
      </div>
      <div className="mt-2 flex gap-3 items-center">
        <label className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50 cursor-pointer">
          {uploading ? 'Uploading…' : '📷 Add picture'}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f, !data.card.cover_attachment_id);
              e.target.value = '';
            }}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">⚠ {error}</p>
        )}
      </div>
    </section>
  );
}

function Notes({ cardId, notes, onChanged }: { cardId: string; notes: CardDetail['notes']; onChanged: () => void }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>) =>
    p.then(onChanged).catch((e) => setError(e instanceof Error ? e.message : 'failed'));

  return (
    <section aria-label="Notes">
      <h3 className="text-sm font-semibold text-gray-500 mb-1">Notes</h3>
      {error && (
        <p role="alert" className="text-sm text-red-700 mb-1">⚠ {error}</p>
      )}
      <div className="space-y-3">
        {notes.map((n) =>
          editing === n.id ? (
            <div key={n.id}>
              <textarea
                aria-label="Edit note (markdown)"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={4}
                className="w-full border rounded p-2 text-sm font-mono"
              />
              <div className="flex gap-2 mt-1">
                <button
                  className="text-sm bg-slate-800 text-white rounded px-2 py-1"
                  onClick={() => run(patch(`/api/cards/${cardId}/notes/${n.id}`, { markdown: editText })).then(() => setEditing(null))}
                >
                  Save
                </button>
                <button className="text-sm border rounded px-2 py-1" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <article key={n.id} className="border rounded p-3 bg-gray-50">
              <div className="prose prose-sm max-w-none">
                <ReactMarkdown>{n.markdown}</ReactMarkdown>
              </div>
              <div className="flex gap-3 mt-1 text-xs text-gray-500">
                <span>{new Date(n.created_at).toLocaleString()}</span>
                <button
                  className="underline"
                  onClick={() => {
                    setEditing(n.id);
                    setEditText(n.markdown);
                  }}
                >
                  edit markdown
                </button>
                <button className="underline text-red-700" onClick={() => run(del(`/api/cards/${cardId}/notes/${n.id}`))}>
                  delete
                </button>
              </div>
            </article>
          ),
        )}
      </div>
      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            void run(post(`/api/cards/${cardId}/notes`, { markdown: draft })).then(() => setDraft(''));
          }
        }}
      >
        <textarea
          aria-label="New note (markdown supported)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Write a note… (markdown supported)"
          className="w-full border rounded p-2 text-sm"
        />
        <button type="submit" className="mt-1 text-sm bg-slate-800 text-white rounded px-3 py-1">
          Add note
        </button>
      </form>
    </section>
  );
}
