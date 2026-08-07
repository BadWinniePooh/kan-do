import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, del } from '../api';
import type { BoardDetail, Me } from '../types';
import { initialsOf } from '@kan-do/shared';
import { useDismiss } from '../useDismiss';

interface OrgUserLite {
  id: string;
  display_name: string;
  email: string;
}

/** Board settings: rename, membership, delete (owner only). */
export default function BoardSettings({ board, onClose }: { board: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const boardId = board.board.id;
  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => get('/api/auth/me') });
  const { data: orgUsers = [] } = useQuery<OrgUserLite[]>({
    queryKey: ['org-users'],
    queryFn: () => get('/api/me/org-users'),
  });
  const [name, setName] = useState(board.board.name);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useDismiss<HTMLDivElement>(onClose);

  const isOwner = board.members.some((m) => m.id === me?.id && m.is_owner);
  const memberIds = new Set(board.members.map((m) => m.id));
  const candidates = orgUsers.filter((u) => !memberIds.has(u.id));

  const refresh = () => qc.invalidateQueries({ queryKey: ['board', boardId] });

  const run = (p: Promise<unknown>) =>
    p
      .then(() => {
        setError(null);
        return refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'request failed'));

  const rename = useMutation({
    mutationFn: () => patch(`/api/boards/${boardId}`, { name: name.trim() }),
    onSuccess: () => {
      setError(null);
      void refresh();
      void qc.invalidateQueries({ queryKey: ['boards'] });
    },
    onError: (e) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => del(`/api/boards/${boardId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['boards'] });
      navigate('/boards');
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Board settings"
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 className="text-lg font-bold">Board settings</h2>
          <button onClick={onClose} aria-label="Close board settings" className="ml-auto text-gray-400 hover:text-gray-700 text-xl leading-none">
            ×
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            ⚠ {error}
          </p>
        )}

        <section aria-label="Rename board">
          <label htmlFor="board-name" className="text-sm font-semibold text-gray-500 block mb-1">
            Name
          </label>
          <div className="flex gap-2">
            <input
              id="board-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border rounded px-2 py-1 flex-1 text-sm"
            />
            <button
              onClick={() => name.trim() && rename.mutate()}
              disabled={rename.isPending || !name.trim() || name === board.board.name}
              className="bg-slate-800 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
            >
              Rename
            </button>
          </div>
        </section>

        <section aria-label="Members">
          <h3 className="text-sm font-semibold text-gray-500 mb-1">Members</h3>
          <ul className="space-y-1">
            {board.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                <span className="rounded-full bg-blue-600 text-white w-6 h-6 flex items-center justify-center text-xs font-semibold">
                  {initialsOf(m.display_name)}
                </span>
                {m.display_name}
                {m.is_owner && <span className="text-xs text-gray-400 border rounded px-1">owner</span>}
                {!m.is_owner && m.id !== me?.id && (
                  <button
                    className="ml-auto text-xs text-red-700 underline"
                    onClick={() => void run(del(`/api/boards/${boardId}/members/${m.id}`))}
                  >
                    remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {candidates.length > 0 && (
            <form
              className="flex gap-2 mt-2"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const userId = String(f.get('userId'));
                if (userId) void run(post(`/api/boards/${boardId}/members`, { userId }));
              }}
            >
              <label htmlFor="add-member" className="sr-only">
                Add member
              </label>
              <select id="add-member" name="userId" className="border rounded px-2 py-1 text-sm flex-1">
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} ({u.email})
                  </option>
                ))}
              </select>
              <button type="submit" className="bg-slate-800 text-white rounded px-3 py-1 text-sm">
                Add member
              </button>
            </form>
          )}
        </section>

        {isOwner && (
          <section aria-label="Danger zone" className="border-t pt-3">
            {!confirmDelete ? (
              <button className="text-sm text-red-700 underline" onClick={() => setConfirmDelete(true)}>
                Delete this board…
              </button>
            ) : (
              <div className="text-sm space-y-2">
                <p className="text-red-700 font-medium">
                  ⚠ Deletes the board with all its cards, notes and history. This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => remove.mutate()}
                    disabled={remove.isPending}
                    className="bg-red-700 text-white rounded px-3 py-1 disabled:opacity-50"
                  >
                    {remove.isPending ? 'Deleting…' : 'Delete board'}
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="border rounded px-3 py-1">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
