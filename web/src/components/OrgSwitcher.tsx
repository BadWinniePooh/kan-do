import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../api';
import type { Me } from '../types';
import { useDismiss } from '../useDismiss';

interface OrgLite {
  id: string;
  name: string;
  slug: string;
}

/**
 * Persistent tenant indicator. Global admins see a fixed "Global" badge; org
 * users always see their org name, and get a switcher when the same email has
 * accounts in several orgs.
 */
export default function OrgSwitcher({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(() => setOpen(false), open);
  const { data: orgs = [] } = useQuery<OrgLite[]>({
    queryKey: ['my-orgs'],
    queryFn: () => get('/api/auth/my-orgs'),
    enabled: me.role !== 'global_admin',
  });

  if (me.role === 'global_admin') {
    return (
      <span className="text-xs font-semibold uppercase tracking-wide bg-violet-700/80 rounded-full px-2.5 py-1" title="Deployment-wide administration">
        ⛭ Global
      </span>
    );
  }

  const label = me.orgName ?? me.orgSlug ?? 'Organization';
  const switchable = orgs.length > 1;

  const switchTo = async (orgId: string) => {
    await post('/api/auth/switch-org', { orgId });
    window.location.assign('/'); // fresh session -> fresh caches
  };

  if (!switchable) {
    return (
      <span className="text-xs font-semibold bg-slate-700 rounded-full px-2.5 py-1" title="Your organization">
        🏢 {label}
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        aria-expanded={open}
        aria-label={`Current organization: ${label}. Switch organization`}
        onClick={() => setOpen(!open)}
        className="text-xs font-semibold bg-slate-700 hover:bg-slate-600 rounded-full px-2.5 py-1"
      >
        🏢 {label} ▾
      </button>
      {open && (
        <div className="absolute left-0 mt-1 bg-white text-gray-900 rounded-lg shadow-lg border z-50 min-w-[12rem] py-1">
          {orgs.map((o) => (
            <button
              key={o.id}
              onClick={() => (o.id === me.orgId ? setOpen(false) : void switchTo(o.id))}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${o.id === me.orgId ? 'font-semibold' : ''}`}
              aria-current={o.id === me.orgId ? 'true' : undefined}
            >
              {o.id === me.orgId ? '✓ ' : ''}
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
