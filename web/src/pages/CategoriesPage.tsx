import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, del, ApiError } from '../api';
import type { Category } from '../types';

/** Validated categorical palette (dataviz reference) — presets keep colors
 * distinguishable, including for color-vision deficiencies. */
export const CATEGORY_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

export default function CategoriesPage() {
  const qc = useQueryClient();
  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ['categories'], queryFn: () => get('/api/me/categories') });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['categories'] });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof ApiError && e.status === 409 ? 'A category with this name already exists.' : e instanceof Error ? e.message : 'failed');

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Card categories</h1>
      <p className="text-sm text-gray-500 mb-4">
        Categories classify cards across every board in your organization. A card carries one category; its color shows
        on the card face.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700 mb-3 bg-red-50 border border-red-200 rounded p-2">
          ⚠ {error}
        </p>
      )}

      <CategoryForm
        key="new"
        onSubmit={(name, color) => post('/api/me/categories', { name, color }).then(refresh).catch(onError)}
        submitLabel="Create category"
      />

      <ul className="mt-5 space-y-2">
        {categories.map((c) =>
          editing === c.id ? (
            <li key={c.id} className="bg-white border rounded-lg p-3">
              <CategoryForm
                initialName={c.name}
                initialColor={c.color}
                submitLabel="Save"
                onCancel={() => setEditing(null)}
                onSubmit={(name, color) =>
                  patch(`/api/me/categories/${c.id}`, { name, color })
                    .then(() => {
                      setEditing(null);
                      refresh();
                    })
                    .catch(onError)
                }
              />
            </li>
          ) : (
            <li key={c.id} className="bg-white border rounded-lg p-3 flex items-center gap-3">
              <span aria-hidden className="w-4 h-4 rounded-full shrink-0" style={{ background: c.color }} />
              <span className="font-medium text-sm">{c.name}</span>
              <span className="ml-auto flex gap-3">
                <button className="text-xs underline" onClick={() => setEditing(c.id)}>
                  Edit
                </button>
                <button
                  className="text-xs underline text-red-700"
                  onClick={() => {
                    if (window.confirm(`Delete category "${c.name}"? Cards keep working, they just lose this label.`)) {
                      void del(`/api/me/categories/${c.id}`).then(refresh).catch(onError);
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ),
        )}
        {categories.length === 0 && <p className="text-sm text-gray-500">No categories yet — create the first one above.</p>}
      </ul>
    </div>
  );
}

function CategoryForm({
  initialName = '',
  initialColor = CATEGORY_COLORS[0]!,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName?: string;
  initialColor?: string;
  submitLabel: string;
  onSubmit: (name: string, color: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  return (
    <form
      className="bg-white border rounded-lg p-3 flex items-center gap-3 flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onSubmit(name.trim(), color);
          if (!onCancel) setName('');
        }
      }}
    >
      <label className="sr-only" htmlFor={`cat-name-${submitLabel}`}>
        Category name
      </label>
      <input
        id={`cat-name-${submitLabel}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Category name"
        required
        className="border rounded px-2 py-1 text-sm flex-1 min-w-[10rem]"
      />
      <div role="radiogroup" aria-label="Category color" className="flex gap-1">
        {CATEGORY_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
            className={`w-6 h-6 rounded-full border-2 ${color === c ? 'border-slate-900 ring-2 ring-slate-300' : 'border-white'}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <button type="submit" className="bg-slate-800 text-white rounded px-3 py-1 text-sm">
        {submitLabel}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} className="border rounded px-3 py-1 text-sm">
          Cancel
        </button>
      )}
    </form>
  );
}
