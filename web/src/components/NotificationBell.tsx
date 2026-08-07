import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api';
import type { AppNotification } from '../types';
import { useDismiss } from '../useDismiss';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(() => setOpen(false), open);
  const qc = useQueryClient();
  const { data: notifications = [] } = useQuery<AppNotification[]>({
    queryKey: ['notifications'],
    queryFn: () => get('/api/me/notifications'),
  });
  const unread = notifications.filter((n) => !n.read_at);
  const markRead = useMutation({
    mutationFn: (ids: string[]) => post('/api/me/notifications/read', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label={`Notifications, ${unread.length} unread`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && unread.length) markRead.mutate(unread.map((n) => n.id));
        }}
        className="relative p-1 rounded hover:bg-slate-700"
      >
        <span aria-hidden>🔔</span>
        {unread.length > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-600 text-white text-xs rounded-full px-1 min-w-[1.1rem] text-center">
            {unread.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white text-gray-900 rounded shadow-lg border z-50 max-h-96 overflow-auto">
          {notifications.length === 0 && <p className="p-4 text-sm text-gray-500">No notifications.</p>}
          {notifications.map((n) => (
            <div key={n.id} className={`px-4 py-2 border-b text-sm ${n.read_at ? '' : 'bg-blue-50'}`}>
              <p className="font-medium">
                {n.event === 'overdue' ? '⚠ ' : '🔁 '}
                {n.title}
              </p>
              <p className="text-gray-600">{n.body}</p>
              <p className="text-xs text-gray-400">{new Date(n.created_at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
