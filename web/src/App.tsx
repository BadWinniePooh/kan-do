import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, post } from './api';
import type { Me } from './types';
import LoginPage from './pages/LoginPage';
import BoardsPage from './pages/BoardsPage';
import BoardPage from './pages/BoardPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import CategoriesPage from './pages/CategoriesPage';
import OrgAdminPage from './pages/OrgAdminPage';
import GlobalAdminPage from './pages/GlobalAdminPage';
import NotificationBell from './components/NotificationBell';
import OrgSwitcher from './components/OrgSwitcher';
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
    { to: '/categories', label: 'Categories' },
    { to: '/settings', label: 'Settings' },
    ...(me.role === 'org_admin' ? [{ to: '/org-admin', label: 'Org Admin' }] : []),
  ];

  return (
    <Shell me={me} nav={nav}>
      <Routes>
        <Route path="/boards" element={<BoardsPage />} />
        <Route path="/boards/:boardId" element={<BoardPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/categories" element={<CategoriesPage />} />
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
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-gradient-to-r from-slate-900 via-slate-900 to-indigo-950 text-white px-4 py-2.5 flex items-center gap-4 shadow-md">
        <span className="font-bold text-lg tracking-tight">
          Kan<span className="text-indigo-400">-</span>Do
        </span>
        <OrgSwitcher me={me} />
        <nav className="flex gap-1" aria-label="Main navigation">
          {nav.map((n) => (
            <NavItem key={n.to} to={n.to} label={n.label} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {me.role !== 'global_admin' && <NotificationBell />}
          {me.avatarUrl ? (
            <img src={me.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover ring-1 ring-white/40" />
          ) : null}
          <span className="text-sm text-slate-300 hidden sm:inline">{me.displayName}</span>
          <button onClick={logout} className="text-sm bg-white/10 px-2.5 py-1 rounded-lg hover:bg-white/20 transition-colors">
            Log out
          </button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  const active = useLocation().pathname.startsWith(to);
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`text-sm px-2.5 py-1 rounded-lg transition-colors ${
        active ? 'bg-white/15 font-medium' : 'text-slate-300 hover:text-white hover:bg-white/10'
      }`}
    >
      {label}
    </Link>
  );
}
