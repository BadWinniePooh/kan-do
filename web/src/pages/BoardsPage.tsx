import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api';
import type { Board } from '../types';
import { TileSkeleton } from '../components/Loading';

export default function BoardsPage() {
  const qc = useQueryClient();
  const { data: boards = [], isLoading } = useQuery<Board[]>({ queryKey: ['boards'], queryFn: () => get('/api/boards') });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (n: string) => post<Board>('/api/boards', { name: n }),
    onSuccess: () => {
      setName('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['boards'] });
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Your boards</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name.trim());
        }}
        className="flex gap-2 mb-6"
      >
        <label htmlFor="new-board" className="sr-only">
          New board name
        </label>
        <input
          id="new-board"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New board name"
          className="border rounded px-3 py-2 flex-1"
        />
        <button type="submit" disabled={create.isPending} className="bg-slate-800 text-white px-4 rounded disabled:opacity-50">
          Create
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-700 text-sm mb-4">
          ⚠ {error}
        </p>
      )}
      {isLoading ? (
        <TileSkeleton rows={3} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {boards.map((b) => (
            <li key={b.id}>
              <Link to={`/boards/${b.id}`} className="block bg-white rounded-lg shadow p-4 hover:shadow-md font-medium">
                {b.name}
              </Link>
            </li>
          ))}
          {boards.length === 0 && <p className="text-gray-500">No boards yet — create one above.</p>}
        </ul>
      )}
    </div>
  );
}
