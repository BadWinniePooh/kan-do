import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, put, post, patch } from '../api';
import type { Me } from '../types';

interface Setting {
  event: 'overdue' | 'reopen';
  channel: 'inapp' | 'email' | 'push';
  enabled: boolean;
}

const EVENTS = [
  { id: 'reopen' as const, label: 'Recurring task reopened' },
  { id: 'overdue' as const, label: 'Task became overdue' },
];
const CHANNELS = [
  { id: 'inapp' as const, label: 'In-app' },
  { id: 'email' as const, label: 'Email' },
  { id: 'push' as const, label: 'Android push' },
];

export default function SettingsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ['notification-settings'],
    queryFn: () => get('/api/me/notification-settings'),
  });
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(me.displayName);

  const isEnabled = (event: string, channel: string) =>
    settings.find((s) => s.event === event && s.channel === channel)?.enabled ?? true;

  const save = useMutation({
    mutationFn: (s: Setting) => put('/api/me/notification-settings', [s]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-settings'] }),
    onError: (e) => setError(e.message),
  });

  const uploadAvatar = async (file: File) => {
    setError(null);
    try {
      const { key, uploadUrl } = await post<{ key: string; uploadUrl: string }>('/api/me/uploads/presign', {
        filename: file.name,
        contentType: file.type,
        purpose: 'avatar',
      });
      const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      await patch('/api/me/profile', { avatarKey: key });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'avatar upload failed');
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      <section aria-label="Profile">
        <h1 className="text-2xl font-bold mb-3">Profile</h1>
        {error && (
          <p role="alert" className="text-sm text-red-700 mb-2">⚠ {error}</p>
        )}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <label className="block text-sm">
            Display name
            <span className="block text-xs text-gray-500">Initials for your badge come from capital letters, e.g. "BadWinniePooh" → BWP</span>
            <div className="flex gap-2 mt-1">
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="border rounded px-3 py-2 flex-1"
              />
              <button
                onClick={() =>
                  patch('/api/me/profile', { displayName }).then(() => qc.invalidateQueries({ queryKey: ['me'] }))
                }
                className="bg-slate-800 text-white rounded px-3"
              >
                Save
              </button>
            </div>
          </label>
          <label className="block text-sm">
            Profile picture
            <input
              type="file"
              accept="image/*"
              className="block mt-1 text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAvatar(f);
              }}
            />
          </label>
        </div>
      </section>

      <section aria-label="Notification settings">
        <h2 className="text-xl font-bold mb-3">Notifications</h2>
        <div className="bg-white rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-3">Event</th>
                {CHANNELS.map((c) => (
                  <th key={c.id} className="p-3">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENTS.map((ev) => (
                <tr key={ev.id} className="border-b last:border-0">
                  <td className="p-3">{ev.label}</td>
                  {CHANNELS.map((ch) => (
                    <td key={ch.id} className="p-3 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${ev.label} via ${ch.label}`}
                        checked={isEnabled(ev.id, ch.id)}
                        onChange={(e) => save.mutate({ event: ev.id, channel: ch.id, enabled: e.target.checked })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-2">Each channel toggles independently per event.</p>
      </section>
    </div>
  );
}
