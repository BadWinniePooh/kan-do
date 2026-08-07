import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, post } from './api';
import type { Me } from './types';
import LoginPage from './pages/LoginPage';
import BoardsPage from './pages/BoardsPage';
import BoardPage from './pages/BoardPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import OrgAdminPage from './pages/OrgAdminPage';
import GlobalAdminPage from './pages/GlobalAdminPage';
import NotificationBell from './components/NotificationBell';
import { Spinner } from './components/Loading';
import { useNotificationRealtime } from './realtime';

export default function App() {
  const { data: me, isLoading } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => get<Me>('/api/auth/me'),
    retry: false,
  });
  useNotificationRealtime();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" aria-busy="true">
        <Spinner label="Loading Kan-Do" />
      </div>
    );
  }
  // logged out: /login is the only route; every protected path redirects there
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Role tiers get separate UIs: global admin never sees boards UI.
  if (me.role === 'global_admin') {
    return (
      <Shell me={me} nav={[{ to: '/admin', label: 'Organizations' }]}>
        <Routes>
          <Route path="/admin" element={<GlobalAdminPage />} />
          <Route path="/login" element={<Navigate to="/admin" replace />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Shell>
    );
  }

  const nav = [
    { to: '/boards', label: 'Boards' },
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/settings', label: 'Settings' },
    ...(me.role === 'org_admin' ? [{ to: '/org-admin', label: 'Org Admin' }] : []),
  ];

  return (
    <Shell me={me} nav={nav}>
      <Routes>
        <Route path="/boards" element={<BoardsPage />} />
        <Route path="/boards/:boardId" element={<BoardPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage me={me} />} />
        {me.role === 'org_admin' && <Route path="/org-admin" element={<OrgAdminPage me={me} />} />}
        <Route path="/login" element={<Navigate to="/boards" replace />} />
        <Route path="*" element={<Navigate to="/boards" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ me, nav, children }: { me: Me; nav: { to: string; label: string }[]; children: React.ReactNode }) {
  const logout = async () => {
    await post('/api/auth/logout');
    // hard reload: guarantees every cache and socket is dropped with the session
    window.location.assign('/login');
  };
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-slate-800 text-white px-4 py-2 flex items-center gap-4">
        <span className="font-bold text-lg">Kan-Do</span>
        <nav className="flex gap-3" aria-label="Main navigation">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="hover:underline text-sm py-1">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {me.role !== 'global_admin' && <NotificationBell />}
          <span className="text-sm text-slate-300">{me.displayName}</span>
          <button onClick={logout} className="text-sm bg-slate-700 px-2 py-1 rounded hover:bg-slate-600">
            Log out
          </button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
