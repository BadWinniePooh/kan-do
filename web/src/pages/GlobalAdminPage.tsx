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
                <td className="p-3 font-medium">
                  <OrgName org={o} onSaved={refresh} />
                </td>
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

function OrgName({ org, onSaved }: { org: Org; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        {org.name}
        <button aria-label={`Rename ${org.name}`} className="text-xs text-gray-400 underline" onClick={() => setEditing(true)}>
          rename
        </button>
      </span>
    );
  }
  return (
    <form
      className="flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && name !== org.name) {
          void patch(`/api/admin/orgs/${org.id}`, { name: name.trim() }).then(() => {
            setEditing(false);
            onSaved();
          });
        } else {
          setEditing(false);
        }
      }}
    >
      <input
        aria-label="Organization name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
        className="border rounded px-2 py-0.5 text-sm"
      />
      <button type="submit" className="text-xs underline">
        save
      </button>
    </form>
  );
}

function OrgUsers({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery<OrgUser[]>({
    queryKey: ['admin-org-users', orgId],
    queryFn: () => get(`/api/admin/orgs/${orgId}/users`),
  });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    // global admin bootstraps a fresh org by creating its first users/admins
    mutationFn: (v: { email: string; displayName: string; password: string; role: string }) =>
      post(`/api/orgs/${orgId}/users`, v),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['admin-org-users', orgId] });
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.fields
          ? e.fields.map((f) => `${f.path}: ${f.message}`).join('; ')
          : e instanceof ApiError && e.status === 409
            ? 'A user with this email already exists in the organization.'
            : e.message,
      ),
  });
  return (
    <section aria-label="Organization users" className="mt-4 bg-white border rounded-lg overflow-x-auto">
      <form
        className="p-3 border-b flex gap-2 flex-wrap items-end"
        aria-label="Create user in organization"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({
            email: String(f.get('email')),
            displayName: String(f.get('displayName')),
            password: String(f.get('password')),
            role: String(f.get('role')),
          });
          (e.target as HTMLFormElement).reset();
        }}
      >
        <div>
          <label htmlFor={`cu-email-${orgId}`} className="text-xs font-medium block">
            Email
          </label>
          <input id={`cu-email-${orgId}`} name="email" type="email" required className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label htmlFor={`cu-name-${orgId}`} className="text-xs font-medium block">
            Display name
          </label>
          <input id={`cu-name-${orgId}`} name="displayName" required className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label htmlFor={`cu-pass-${orgId}`} className="text-xs font-medium block">
            Initial password (min 8)
          </label>
          <input id={`cu-pass-${orgId}`} name="password" type="password" required minLength={8} className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label htmlFor={`cu-role-${orgId}`} className="text-xs font-medium block">
            Role
          </label>
          <select id={`cu-role-${orgId}`} name="role" className="border rounded px-2 py-1 text-sm">
            <option value="user">User</option>
            <option value="org_admin">Org admin</option>
          </select>
        </div>
        <button type="submit" className="bg-slate-800 text-white rounded px-3 py-1.5 text-sm">
          Create user
        </button>
        {error && (
          <p role="alert" className="text-red-700 text-sm w-full">⚠ {error}</p>
        )}
      </form>
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
