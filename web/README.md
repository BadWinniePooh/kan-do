# @kan-do/web

React 18 + Vite + Tailwind SPA — the user-facing kanban UI, the Org Admin UI,
and the Global Admin UI (role decides which shell renders; they never blend).
Also the source for the Android app via Capacitor ([ANDROID.md](ANDROID.md)).

## Layout

| Path | Purpose |
|---|---|
| `src/pages/` | Route-level views: Boards, Board (drag-drop via dnd-kit), Dashboard (Recharts widgets), Settings, OrgAdmin, GlobalAdmin, Login. |
| `src/components/` | CardTile, CardModal (markdown notes, gallery, recurrence builder, owners), ColumnEditor, OwnerBadge (user vs external styles), NotificationBell. |
| `src/api.ts` | fetch wrapper — every failure surfaces to the UI (no silent errors). |
| `src/realtime.ts` | Socket.IO client; board rooms invalidate the query cache on events. |
| `src/push.ts` | FCM token registration (Android only). |

Server state lives in TanStack Query; board drag-drop is optimistic with
visible rollback on failure.

## Commands

```bash
pnpm dev       # http://localhost:5173 (proxies /api + /socket.io to :3001)
pnpm build     # typecheck + production bundle
pnpm lint
```

Accessibility: keyboard-drag via dnd-kit sensors, labeled icon controls,
`role=alert` on inline errors, overdue = border+tint+⚠ text (never color
alone).
