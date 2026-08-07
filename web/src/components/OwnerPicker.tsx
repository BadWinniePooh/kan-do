import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post, put } from '../api';
import type { BoardDetail, Card, OwnerRow } from '../types';

interface ExternalOwner {
  id: string;
  display_name: string;
}

/** Assign zero..n owners: board members (users) + org external owners. */
export default function OwnerPicker({
  card,
  board,
  current,
  onChanged,
}: {
  card: Card;
  board: BoardDetail;
  current: OwnerRow[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newExternal, setNewExternal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data: externals = [], refetch } = useQuery<ExternalOwner[]>({
    queryKey: ['external-owners'],
    queryFn: () => get('/api/me/external-owners'),
    enabled: open,
  });

  const selected = new Set(current.map((o) => (o.kind === 'user' ? `u:${o.user_id}` : `e:${o.external_owner_id}`)));

  const save = async (next: Set<string>) => {
    setError(null);
    try {
      await put(
        `/api/cards/${card.id}/owners`,
        [...next].map((k) => {
          const [kind, id] = k.split(':');
          return { kind: kind === 'u' ? 'user' : 'external', id };
        }),
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    }
  };

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    void save(next);
  };

  return (
    <div className="relative">
      <button
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-sm border rounded-full w-7 h-7 bg-white hover:bg-gray-50"
        aria-label="Edit owners"
      >
        +
      </button>
      {open && (
        <div className="absolute z-50 mt-1 bg-white border rounded shadow-lg w-64 p-2 text-sm">
          {error && (
            <p role="alert" className="text-red-700 text-xs mb-1">⚠ {error}</p>
          )}
          <p className="font-semibold text-gray-500 text-xs mb-1">Board members</p>
          {board.members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
              <input type="checkbox" checked={selected.has(`u:${m.id}`)} onChange={() => toggle(`u:${m.id}`)} />
              {m.display_name}
            </label>
          ))}
          <p className="font-semibold text-gray-500 text-xs mt-2 mb-1">External (no account)</p>
          {externals.map((x) => (
            <label key={x.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
              <input type="checkbox" checked={selected.has(`e:${x.id}`)} onChange={() => toggle(`e:${x.id}`)} />
              {x.display_name} <span className="text-amber-700 text-xs">(external)</span>
            </label>
          ))}
          <form
            className="flex gap-1 mt-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newExternal.trim()) return;
              await post('/api/me/external-owners', { displayName: newExternal.trim() });
              setNewExternal('');
              void refetch();
            }}
          >
            <input
              aria-label="New external owner name"
              value={newExternal}
              onChange={(e) => setNewExternal(e.target.value)}
              placeholder="Add external…"
              className="border rounded px-2 py-1 flex-1 text-xs"
            />
            <button type="submit" className="border rounded px-2 text-xs bg-gray-50">
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
