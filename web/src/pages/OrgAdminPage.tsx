/** Org Admin UI — user + IdP management for one org. Separate from board UI. */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, del, ApiError } from '../api';
import type { Me } from '../types';

interface OrgUser {
  id: string;
  email: string;
  display_name: string;
  role: 'org_admin' | 'user';
  active: boolean;
}

interface Idp {
  id: string;
  type: 'oidc' | 'saml';
  display_name: string;
  enabled: boolean;
}

export default function OrgAdminPage({ me }: { me: Me }) {
  const orgId = me.orgId!;
  const qc = useQueryClient();
  const { data: users = [] } = useQuery<OrgUser[]>({ queryKey: ['org-users'], queryFn: () => get(`/api/orgs/${orgId}/users`) });
  const { data: idps = [] } = useQuery<Idp[]>({ queryKey: ['org-idps'], queryFn: () => get(`/api/orgs/${orgId}/idps`) });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['org-users'] });
    void qc.invalidateQueries({ queryKey: ['org-idps'] });
  };

  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.fields) {
      setFieldErrors(Object.fromEntries(e.fields.map((f) => [f.path, f.message])));
      setError(null);
    } else {
      setError(e instanceof Error ? e.message : 'request failed');
    }
  };

  const invite = useMutation({
    mutationFn: (v: { email: string; displayName: string; password: string; role: string }) =>
      post(`/api/orgs/${orgId}/users`, v),
    onSuccess: () => {
      setFieldErrors({});
      setError(null);
      refresh();
    },
    onError,
  });

  const resetPassword = (u: OrgUser) => {
    const pw = window.prompt(`New password for ${u.display_name} (min 8 characters):`);
    if (pw === null) return;
    patch(`/api/orgs/${orgId}/users/${u.id}`, { password: pw })
      .then(() => {
        setError(null);
        refresh();
      })
      .catch(onError);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <section aria-label="User management">
        <h1 className="text-2xl font-bold mb-3">Organization users</h1>
        {error && (
          <p role="alert" className="text-sm text-red-700 mb-2">⚠ {error}</p>
        )}
        <form
          className="bg-white border rounded-lg p-4 grid gap-2 sm:grid-cols-4 mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            invite.mutate({
              email: String(f.get('email')),
              displayName: String(f.get('displayName')),
              password: String(f.get('password')),
              role: String(f.get('role')),
            });
          }}
        >
          <div>
            <label htmlFor="inv-email" className="text-xs font-medium">
              Email
            </label>
            <input id="inv-email" name="email" type="email" required className="border rounded px-2 py-1 w-full text-sm" />
            {fieldErrors.email && (
              <p role="alert" className="text-xs text-red-700">{fieldErrors.email}</p>
            )}
          </div>
          <div>
            <label htmlFor="inv-name" className="text-xs font-medium">
              Display name
            </label>
            <input id="inv-name" name="displayName" required className="border rounded px-2 py-1 w-full text-sm" />
          </div>
          <div>
            <label htmlFor="inv-pass" className="text-xs font-medium">
              Initial password
            </label>
            <input id="inv-pass" name="password" type="password" required minLength={8} className="border rounded px-2 py-1 w-full text-sm" />
            {fieldErrors.password && (
              <p role="alert" className="text-xs text-red-700">{fieldErrors.password}</p>
            )}
          </div>
          <div>
            <label htmlFor="inv-role" className="text-xs font-medium">
              Role
            </label>
            <select id="inv-role" name="role" className="border rounded px-2 py-1 w-full text-sm">
              <option value="user">User</option>
              <option value="org_admin">Org admin</option>
            </select>
          </div>
          <button type="submit" className="bg-slate-800 text-white rounded px-3 self-end py-1.5 text-sm">
            Invite user
          </button>
        </form>

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                <th className="p-3">Name</th>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                <th className="p-3">Status</th>
                <th className="p-3">Actions</th>
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
                      disabled={u.id === me.id}
                      onChange={(e) =>
                        patch(`/api/orgs/${orgId}/users/${u.id}`, { role: e.target.value }).then(refresh).catch(onError)
                      }
                      className="border rounded px-1 py-0.5"
                    >
                      <option value="user">User</option>
                      <option value="org_admin">Org admin</option>
                    </select>
                  </td>
                  <td className="p-3">{u.active ? 'active' : <span className="text-red-700">deactivated</span>}</td>
                  <td className="p-3 flex gap-3">
                    {u.id !== me.id && (
                      <button
                        className="text-xs underline"
                        onClick={() => patch(`/api/orgs/${orgId}/users/${u.id}`, { active: !u.active }).then(refresh).catch(onError)}
                      >
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                    <button className="text-xs underline" onClick={() => resetPassword(u)}>
                      Reset password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Single sign-on">
        <h2 className="text-xl font-bold mb-3">Single sign-on (IdP)</h2>
        <ul className="space-y-2 mb-4">
          {idps.map((idp) => (
            <li key={idp.id} className="bg-white border rounded-lg p-3 flex items-center gap-3 text-sm">
              <span className="font-mono uppercase text-xs bg-gray-100 rounded px-1.5 py-0.5">{idp.type}</span>
              <span className="font-medium">{idp.display_name}</span>
              <label className="ml-auto flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={idp.enabled}
                  onChange={(e) => patch(`/api/orgs/${orgId}/idps/${idp.id}`, { enabled: e.target.checked }).then(refresh).catch(onError)}
                />
                enabled
              </label>
              <button className="text-xs text-red-700 underline" onClick={() => del(`/api/orgs/${orgId}/idps/${idp.id}`).then(refresh).catch(onError)}>
                remove
              </button>
            </li>
          ))}
          {idps.length === 0 && <p className="text-sm text-gray-500">No IdP configured — users sign in with passwords.</p>}
        </ul>
        <IdpForm orgId={orgId} onSaved={refresh} />
      </section>

      <ExternalOwnersSection orgId={orgId} />
    </div>
  );
}

interface ExternalOwner {
  id: string;
  display_name: string;
}

/** Org-wide directory of non-account owners (external dependencies). */
function ExternalOwnersSection({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: externals = [] } = useQuery<ExternalOwner[]>({
    queryKey: ['org-external-owners'],
    queryFn: () => get(`/api/orgs/${orgId}/external-owners`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['org-external-owners'] });
    void qc.invalidateQueries({ queryKey: ['external-owners'] });
  };
  return (
    <section aria-label="External owners">
      <h2 className="text-xl font-bold mb-3">External owners</h2>
      <p className="text-sm text-gray-500 mb-2">
        People or teams without an account, assignable as card owners to model external dependencies.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700 mb-2">⚠ {error}</p>
      )}
      <ul className="space-y-2 mb-3">
        {externals.map((x) => (
          <li key={x.id} className="bg-white border rounded-lg p-3 flex items-center gap-3 text-sm">
            <span className="rounded-md bg-amber-100 text-amber-900 border-2 border-dashed border-amber-500 px-1.5 py-0.5 text-xs font-semibold">
              external
            </span>
            <span className="font-medium">{x.display_name}</span>
            <button
              className="ml-auto text-xs text-red-700 underline"
              onClick={() =>
                window.confirm(`Remove external owner "${x.display_name}"? They will disappear from all cards.`) &&
                del(`/api/orgs/${orgId}/external-owners/${x.id}`)
                  .then(() => {
                    setError(null);
                    refresh();
                  })
                  .catch((e) => setError(e instanceof Error ? e.message : 'delete failed'))
              }
            >
              remove
            </button>
          </li>
        ))}
        {externals.length === 0 && <p className="text-sm text-gray-500">None yet.</p>}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const name = String(f.get('name')).trim();
          if (!name) return;
          post(`/api/orgs/${orgId}/external-owners`, { displayName: name })
            .then(() => {
              setError(null);
              refresh();
            })
            .catch((err) => setError(err instanceof Error ? err.message : 'create failed'));
          (e.target as HTMLFormElement).reset();
        }}
      >
        <label htmlFor="ext-name" className="sr-only">
          External owner name
        </label>
        <input id="ext-name" name="name" required placeholder="Name (e.g. Vendor X)" className="border rounded px-2 py-1 text-sm" />
        <button type="submit" className="bg-slate-800 text-white rounded px-3 py-1 text-sm">
          Add
        </button>
      </form>
    </section>
  );
}

function IdpForm({ orgId, onSaved }: { orgId: string; onSaved: () => void }) {
  const [type, setType] = useState<'oidc' | 'saml'>('oidc');
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="bg-white border rounded-lg p-4 space-y-2 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const f = new FormData(e.currentTarget);
        const body =
          type === 'oidc'
            ? {
                type,
                displayName: String(f.get('displayName')),
                config: { issuer: String(f.get('issuer')), clientId: String(f.get('clientId')), clientSecret: String(f.get('clientSecret')) },
              }
            : {
                type,
                displayName: String(f.get('displayName')),
                config: { entryPoint: String(f.get('entryPoint')), issuer: String(f.get('samlIssuer')), cert: String(f.get('cert')) },
              };
        try {
          await post(`/api/orgs/${orgId}/idps`, body);
          (e.target as HTMLFormElement).reset();
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError && err.fields ? err.fields.map((x) => `${x.path}: ${x.message}`).join(', ') : String(err));
        }
      }}
    >
      <h3 className="font-semibold">Add identity provider</h3>
      <div className="flex gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" checked={type === 'oidc'} onChange={() => setType('oidc')} /> OIDC
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={type === 'saml'} onChange={() => setType('saml')} /> SAML
        </label>
      </div>
      <input name="displayName" required placeholder="Display name (e.g. Okta)" className="border rounded px-2 py-1 w-full" />
      {type === 'oidc' ? (
        <>
          <input name="issuer" required placeholder="Issuer URL (https://…)" className="border rounded px-2 py-1 w-full" />
          <input name="clientId" required placeholder="Client ID" className="border rounded px-2 py-1 w-full" />
          <input name="clientSecret" required type="password" placeholder="Client secret" className="border rounded px-2 py-1 w-full" />
        </>
      ) : (
        <>
          <input name="entryPoint" required placeholder="IdP SSO URL (https://…)" className="border rounded px-2 py-1 w-full" />
          <input name="samlIssuer" required placeholder="SP entity ID / issuer" className="border rounded px-2 py-1 w-full" />
          <textarea name="cert" required placeholder="IdP signing certificate (PEM)" rows={3} className="border rounded px-2 py-1 w-full font-mono text-xs" />
        </>
      )}
      {error && (
        <p role="alert" className="text-red-700 text-xs">⚠ {error}</p>
      )}
      <button type="submit" className="bg-slate-800 text-white rounded px-3 py-1">
        Add IdP
      </button>
    </form>
  );
}
