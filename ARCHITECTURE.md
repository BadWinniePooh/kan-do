# Kan-Do — Architecture

## Stack & why

| Layer | Choice | Why |
|---|---|---|
| Web + Android | React 18 + Vite + Tailwind, wrapped by **Capacitor** for Android | One codebase → consistent terminology/hierarchy across platforms (a spec requirement). Android is online-only, so a webview shell is a perfect fit and FCM push still works natively. |
| Backend | Node 22 + TypeScript + **Fastify** + **Socket.IO** | First-class WebSockets, tiny surface, same language as frontend (shared types in `packages/shared`), trivial to Dockerize. |
| Database | **PostgreSQL 16** via Kysely (typed SQL) + node-pg-migrate | Spec-mandated; Kysely keeps queries explicit and indexable; migrations are versioned and reversible (`up`/`down`, exercised in CI). |
| Jobs | **pg-boss** (Postgres-backed queue) | Recurrence scheduling must survive restarts and never double-fire: pg-boss persists jobs in Postgres, leases them transactionally, and `singletonKey` makes re-scheduling idempotent. No extra infra (no Redis). |
| Object storage | Any S3 API (**MinIO** in compose) via AWS SDK v3 | App needs only endpoint + credentials from env. Browsers upload/download through presigned URLs, so image bytes never pass through the API. |
| Auth | Local (bcrypt) + **OIDC** (`openid-client`) + **SAML** (`@node-saml/node-saml`) | IdP configs are per-org DB rows managed in the admin UI — wiring a new IdP is config, not code. SSO users are JIT-provisioned. Session = signed JWT in an httpOnly cookie. |

## Layering (maintainability + testability)

```
web/ (React SPA)  ──HTTP/WS──▶  server/src/api        (routes: validation + auth glue only)
                                server/src/services   (orchestration: DB + queue + realtime)
                                server/src/domain     (PURE: recurrence, metrics, RBAC — no I/O)
                                server/src/adapters   (S3, SMTP, FCM behind interfaces)
                                server/src/workers    (pg-boss consumers; same services/domain)
```

- `domain/` has zero imports from DB/SDKs — the recurrence state machine, metrics
  math, and RBAC/tenancy decisions are unit-tested exhaustively without infra
  (46 unit tests today).
- Services receive an `AppCtx` container; integration tests substitute stub
  storage/queue/mail/push and use a real Postgres.
- No business logic in route handlers or React components.

## Data model (core tables)

- `organizations` ─ tenants. `users.org_id` scopes every user (global admins have
  `org_id NULL`). All org-scoped queries filter by `org_id`; RBAC checks live in
  `domain/rbac.ts`.
- `boards` → `lanes` → `board_columns`. Columns are **lane-scoped**: every lane
  owns an independent set (`board_columns.lane_id`), so two lanes on one board
  may have entirely different columns, names and order. `semantic ∈ {open, done,
  discard, NULL}` — display name free, semantics fixed; the service layer
  enforces ≥1 open + ≥1 done **per lane**, `discard` is optional. A board always
  has ≥1 lane (a column has nowhere else to live) and a lane holding cards cannot
  be deleted. `board_members` sits on the board.
- `cards` ─ column/lane/position, due date, `recurrence_rule` (structured JSON,
  rendered to iCal RRULE semantics by the `rrule` lib), recurrence state fields
  (`recurrence_status`, `closed_at`, `reopen_at`, `reopened_at`, `overdue_at`,
  `is_overdue`). Partial indexes on `reopen_at`/`overdue_at`/`due_date` keep
  scheduler scans cheap at scale.
- `card_owners` ─ zero..n owners; `kind ∈ {user, external}` with a CHECK that
  exactly one reference is set. `external_owners` is the org-scoped directory of
  non-account owners.
- `notes` (raw markdown), `attachments` (S3 keys; `cards.cover_attachment_id`
  picks the cover), `card_transitions` (append-only column history — the metrics
  source of truth, and the only history the audit view reads; carries the
  `reason` typed for discards and overridden moves).
- `notifications`, `notification_settings` (event × channel toggles),
  `push_tokens`, `notification_ledger` (dedupe keys → at-most-once sends),
  `dashboard_configs` (per user, per board or org-wide widget layout).
- `column_policies` ─ per-column checklists gating movement (`kind ∈ {enter,
  leave}`, ordered by `position`). They hang off a column, so they are lane-
  scoped for free: a policy on Lane A's "Review" is unrelated to Lane B's.
  `card_policy_progress` holds a card's partial ticks between move attempts;
  `card_move_overrides` is the append-only audit of every deliberate bypass
  (which policies, whether backwards, whether cross-lane, by whom, when, and the
  mandatory reason — skipped policies denormalised as JSON so the record
  outlives the policy).
- `idp_configs` ─ per-org OIDC/SAML settings.

## Recurrence lifecycle (spec state machine)

1. Card moved to a done-mapped column → `closed_at = now`,
   `reopen_at = nextOccurrence(rule, now)`, status `awaiting_reopen`; a pg-boss
   job (`singletonKey = reopen:<card>:<ts>`) fires at `reopen_at`.
2. Worker reopens the card into the open-mapped column → `reopened_at = now`,
   `overdue_at = nextOccurrence(rule, now)`, status `reopened`; an overdue-check
   job fires at `overdue_at`.
3. Not closed again by `overdue_at` → status `overdue`, `is_overdue = true`,
   notification fan-out. Closing again at any point resets the cycle.

Overdue is always relative to the last close/reopen — never a fixed calendar
date. Non-recurring cards: 5-minute cron flags `due_date < now` outside done
columns. "Interval" = time to the next RRULE occurrence from the reference
moment (assumption stated: for weekday patterns like Mon+Thu, the period adapts
to the next scheduled day, which is what the RRULE semantics imply).

Worker jobs re-check card state before acting (card deleted, recurrence removed,
manually moved → job no-ops), so restarts/retries are safe; the notification
ledger's unique dedupe key makes each event notify at most once.

## Metrics (from `card_transitions`)

- **Lead time**: creation → first arrival in done.
- **Cycle time**: first departure from an open column → first arrival in done.
- **Waiting time**: total dwell in open columns before first done.
- **Per-column time**: summed dwell per column (open-ended stays count to now).

Computed on read in `domain/metrics.ts` (pure), aggregated per board. Dashboard
widgets (stat tiles, per-column bar, weekly throughput) are user-configurable
(selection, order, width) and persisted per user+board.

Custom widgets are pivot-table style: dimensions × metric × aggregation, built
in `domain/pivot.ts`. `multiPivot` additionally plots several series on one
shared axis, each with its own dimension and an optional running total — that is
what expresses a burnup (cumulative scope by `createdMonth` against cumulative
completed by `closedMonth`). Both entry points go through the same fact
collector in `services/pivotQuery.ts`, which only ever reads boards the caller
can access; the builder's live preview calls that same endpoint, so a preview
can never reveal more than the saved widget would.

## Card movement: the three gates

A move is decided by three independent gates, all pure in `domain/moveGuard.ts`:

1. **Policies** — the source column's `leave` checklist plus the target column's
   `enter` checklist must all be ticked.
2. **Direction** — a card may not move to an earlier column. Order is lane-
   scoped, so this compares positions **inside the card's own lane**; across
   lanes there is no shared order to compare and the lane gate governs instead.
3. **Lane** — moving a card to a different lane is not intended and is blocked.

`services/cards.ts` loads the columns and policies, persists the submitted ticks
**before** deciding (so a refused attempt never loses partial progress), and
refuses with `409` carrying the checklist. Each gate takes a separate explicit
override, and every exercised override demands a written reason (`400` without
one); a `card_move_overrides` row is then written inside the same transaction as
the move. System moves (scheduler reopen, `actor = null`) bypass the guard.

The target column determines the target lane, so a lane change is always a move,
never a `PATCH` — `laneId` is deliberately absent from the card patch contract.

### Discard columns

`semantic = 'discard'` marks a column whose cards are **finished but reverted**:
not active work, and never a successful outcome.

- **Recurrence stops.** Moving to discard does not run the `onClosed` branch, so
  the "reopen after the interval since `closed_at`" countdown never starts. The
  card goes dormant (`recurrence_status = 'open'`, every clock field cleared) and
  a queued reopen job re-checks state and no-ops. Moving it back out leaves it
  plainly open; the next real close starts the cycle again.
- **Backwards rule — decision: a discard column is exempt in BOTH directions.**
  Moving *in* is a terminal exit from the flow ("throw this away"), never a step
  backwards, wherever the discard column happens to sit in the order. Moving
  *out* is a resurrection, and the position it was discarded from carries no
  meaning to measure against — requiring an override to un-discard would make the
  obvious correction the hard path. Policies still apply to discard columns
  exactly like any other column, and a discard always demands a reason.
- **Metrics never conflate it with done.** Lead and cycle time key off the first
  arrival in a `done` column only, so a discarded card has neither; throughput and
  time-since-done read `done` columns only; the due-date scan treats discard as
  finished and stops flagging it overdue; the waiting-time clock stops at the
  discard. Board metrics report `outcomes.{completedCount, discardedCount,
  activeCount, completionRate}` where completion means done, never discard.

## Card audit view

`GET /api/cards/:id/audit` returns one chronological timeline: creation, every
column change (who, from, to, when, reason), and every override (which rules were
bypassed, by whom, and the justification). It is assembled from
`card_transitions` — the same history the cycle/lead/waiting metrics are computed
from — plus `card_move_overrides`, so there is no second history to diverge.
Access is the board's existing view permission; the audit adds no new tier.

Overrides and discard reasons also surface in board metrics, a per-board audit
endpoint, and the pivot engine: dimensions `outcome`, `overrideStatus`,
`discardReason`, `overrideReason` and `overriddenPolicy` (the last two multi-
valued — a card explodes into one row per override), plus the `overrideCount`
metric. Note that the `column` dimension groups by column *name*, so the same
name across lanes groups together on purpose; pair it with `lane` to split them.

## Real-time

Socket.IO rooms per board (`board:<id>`), membership-checked with the same RBAC
on join. API process emits directly; worker processes publish via Postgres
`NOTIFY`, which the API relays into rooms — so a recurrence reopen appears live
on every open board. Clients invalidate their query cache on events (server
state stays the single source of truth; optimistic drag-drop rolls back visibly
on failure).

## Deployment topology

```
[browser / Android app]
   │ https
[web: nginx serving SPA, proxying /api + /socket.io]
   │
[server: Fastify API + Socket.IO]───[worker: pg-boss consumers] (scale either horizontally)
   │                │                     │
[PostgreSQL 16]  [MinIO / any S3]      (same DB = queue + relay bus)
```

Both app images are stateless; all state lives in Postgres + object storage.
Health: `/healthz` (liveness) and `/readyz` (DB + storage checks) for probes;
compose wires them, and the same endpoints suit Kubernetes.

## Testing pyramid

- **Unit (most)**: domain — recurrence engine (incl. reopen-then-not-closed,
  monthly day-31, count-exhausted rules), RBAC (incl. cross-tenant attempts at
  every level), metrics edge cases. Stub-style: assert observable state, never
  call counts.
- **Integration (fewer)**: Fastify + real Postgres — auth, tenancy isolation
  over HTTP, board invariants, card lifecycle incl. job scheduling; migrations
  down+up.
- **E2E (fewest)**: one Playwright smoke — login → board → card → note, against
  the full compose stack.

CI runs all levels on every push; failures block merge.
