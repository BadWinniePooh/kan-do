/** Global Admin UI — deployment-wide org management. No kanban UI here. */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, ApiError } from '../api';

interface Org {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  user_count: string | number;
}

interface OrgUser {
  id: string;
  email: string;
  display_name: string;
  role: string;
  active: boolean;
}

export default function GlobalAdminPage() {
  const qc = useQueryClient();
  const { data: orgs = [] } = useQuery<Org[]>({ queryKey: ['admin-orgs'], queryFn: () => get('/api/admin/orgs') });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    void qc.invalidateQueries({ queryKey: ['admin-org-users'] });
  };

  const create = useMutation({
    mutationFn: (v: { name: string; slug: string }) => post('/api/admin/orgs', v),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) =>
      setError(e instanceof ApiError && e.fields ? e.fields.map((f) => `${f.path}: ${f.message}`).join('; ') : e.message),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Organizations</h1>
      <form
        className="bg-white border rounded-lg p-4 flex gap-2 flex-wrap mb-4 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({ name: String(f.get('name')), slug: String(f.get('slug')) });
          (e.target as HTMLFormElement).reset();
        }}
      >
        <div>
          <label htmlFor="org-name" className="text-xs font-medium block">
            Name
          </label>
          <input id="org-name" name="name" required className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label htmlFor="org-slug" className="text-xs font-medium block">
            Slug (lowercase, for SSO URLs)
          </label>
          <input id="org-slug" name="slug" required pattern="[a-z0-9-]{2,50}" className="border rounded px-2 py-1 text-sm" />
        </div>
        <button type="submit" className="bg-slate-800 text-white rounded px-3 py-1.5 text-sm">
          Create organization
        </button>
        {error && (
          <p role="alert" className="text-red-700 text-sm w-full">⚠ {error}</p>
        )}
      </form>

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-3">Name</th>
              <th className="p-3">Slug</th>
              <th className="p-3">Users</th>
              <th className="p-3">Status</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{o.name}</td>
                <td className="p-3 font-mono text-xs">{o.slug}</td>
                <td className="p-3">{o.user_count}</td>
                <td className="p-3">{o.active ? 'active' : <span className="text-red-700">suspended</span>}</td>
                <td className="p-3 flex gap-3">
                  <button className="text-xs underline" onClick={() => setSelected(selected === o.id ? null : o.id)}>
                    {selected === o.id ? 'Hide users' : 'Manage users'}
                  </button>
                  <button
                    className="text-xs underline"
                    onClick={() => patch(`/api/admin/orgs/${o.id}`, { active: !o.active }).then(refresh)}
                  >
                    {o.active ? 'Suspend' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <OrgUsers orgId={selected} />}
    </div>
  );
}

function OrgUsers({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery<OrgUser[]>({
    queryKey: ['admin-org-users', orgId],
    queryFn: () => get(`/api/admin/orgs/${orgId}/users`),
  });
  return (
    <section aria-label="Organization users" className="mt-4 bg-white border rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            <th className="p-3">Name</th>
            <th className="p-3">Email</th>
            <th className="p-3">Role (promote/demote org admins)</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b last:border-0">
              <td className="p-3">{u.display_name}</td>
              <td className="p-3">{u.email}</td>
              <td className="p-3">
                <select
                  aria-label={`Role for ${u.display_name}`}
                  value={u.role}
                  onChange={(e) =>
                    patch(`/api/admin/orgs/${orgId}/users/${u.id}/role`, { role: e.target.value }).then(() =>
                      qc.invalidateQueries({ queryKey: ['admin-org-users', orgId] }),
                    )
                  }
                  className="border rounded px-1 py-0.5"
                >
                  <option value="user">User</option>
                  <option value="org_admin">Org admin</option>
                </select>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td className="p-3 text-gray-500" colSpan={3}>
                No users yet — the org admin can invite them, or users arrive via SSO.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
