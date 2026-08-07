import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post, get, ApiError } from '../api';

export default function LoginPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<{ type: 'oidc' | 'saml'; display_name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const probeSso = async (slug: string) => {
    setOrgSlug(slug);
    if (slug.length >= 2) {
      try {
        const res = await get<{ providers: typeof providers }>(`/api/auth/providers/${slug}`);
        setProviders(res.providers);
      } catch {
        setProviders([]);
      }
    } else {
      setProviders([]);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post('/api/auth/login', { email, password, orgSlug: orgSlug || undefined });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? 'Wrong email or password.' : 'Login failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-4">
      <form onSubmit={submit} className="bg-white p-8 rounded-2xl shadow-xl max-w-sm w-full space-y-4" aria-label="Login form">
        <h1 className="text-3xl font-bold text-center tracking-tight">
          Kan<span className="text-indigo-600">-</span>Do
        </h1>
        <p className="text-center text-sm text-gray-500 -mt-2">Kanban with recurring tasks</p>
        <div>
          <label htmlFor="org" className="block text-sm font-medium">
            Organization <span className="text-gray-400">(optional)</span>
          </label>
          <input
            id="org"
            value={orgSlug}
            onChange={(e) => void probeSso(e.target.value)}
            className="mt-1 w-full border rounded px-3 py-2"
            placeholder="my-company"
            autoComplete="organization"
          />
        </div>
        {providers.map((p) => (
          <a
            key={p.type}
            href={`/api/auth/${p.type}/${orgSlug}/start`}
            className="block text-center bg-indigo-600 text-white rounded py-2 hover:bg-indigo-700"
          >
            Continue with {p.display_name}
          </a>
        ))}
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full border rounded px-3 py-2"
            autoComplete="email"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full border rounded px-3 py-2"
            autoComplete="current-password"
          />
        </div>
        {error && (
          <p role="alert" className="text-red-700 text-sm bg-red-50 border border-red-200 rounded p-2">
            ⚠ {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="w-full bg-slate-800 text-white rounded py-2 hover:bg-slate-700 disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
