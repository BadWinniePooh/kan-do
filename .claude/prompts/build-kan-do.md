You are building "Kan-Do," a multi-tenant, kanban-style task tracker with recurring-task
support, for web and Android. Design and implement the full application: architecture,
data model, backend, frontend, Android app, CI/CD, and deployment artifacts. Where this
spec leaves a technical choice open, pick a sensible, well-supported default and state
the choice explicitly before proceeding.

## Platforms & Stack
- Targets: responsive web app + Android app. Choose whichever approach best delivers both
  (e.g. single cross-platform codebase, or a PWA, or separate frontends) — your call, but
  justify it briefly.
- Android app is online-only (no offline cache/sync required).
- Backend: your choice of language/framework, but must support real-time updates
  (WebSockets) and be comfortably deployable in Docker.
- Database: PostgreSQL, schema designed to scale beyond a small team (proper indexing,
  avoid single-table-does-everything designs).
- File storage: pictures/attachments go to S3-compatible object storage (e.g. MinIO
  self-hosted), not local disk — app must only need an S3 endpoint + credentials via config.
- Deployment: Dockerized (app + any workers), with a docker-compose for local/self-hosted
  use. Provide a GitHub Actions workflow that builds and publishes the container image(s)
  on push/tag.

## Tenancy & Identity
Three role tiers, each with its own UI — do not blend admin UI into the task-management UI:
1. **Global Admin**: manages organizations (tenants) across the whole deployment, can
   observe/manage any org, manages org admins. Own dedicated UI, unrelated to kanban boards.
2. **Org Admin**: manages users within their organization only (invite, deactivate, assign
   roles). Own dedicated UI, separate from the kanban board UI.
3. **User**: normal kanban usage — boards, cards, dashboard. No admin capability.
Authentication: support SSO/SAML and OIDC against an externally configured IdP (per
organization, configurable by Global/Org admin), plus local username/password accounts as
fallback. Design auth so a new IdP can be wired in via config, not code changes.

## Boards & Columns
- Each user (or team) can own one or more boards.
- Boards have user-defined columns and lanes (swimlanes), freely created/reordered/renamed.
- Every board must have at least one column semantically mapped to "open" and one mapped to
  "done" (the underlying semantics — e.g. for recurrence and metrics — are fixed, but the
  column's display name is fully renameable by the user).

## Task Cards
- Card shows: title, one cover picture (if set) shown directly on the card face, and owner
  avatar badges.
- Expanding a card reveals: full edit view, multiple markdown notes (each stored as raw
  markdown for editing, rendered to HTML for viewing), and a gallery of additional pictures
  beyond the single cover image.
- Owners: a card may have zero, one, or multiple owners. Zero owners is the common/default
  case for an "open" task.
  - Registered-user owners show as a small avatar badge using their profile picture, or —
    if no picture is set — their initials (all-caps, one letter per capitalized word in
    their display name, e.g. "BadWinniePooh" -> "BWP").
  - Non-user (external) owners are also supported, to represent external dependencies (a
    person/team with no account in the system). They display similarly (initials-based
    badge) but are clearly distinguishable from real user accounts (e.g. different badge
    style/border) since they cannot log in or be assigned SSO identities.

## Recurring Tasks
- A task can have a recurrence rule. Support full RRULE-style scheduling (iCal RRULE
  semantics: daily/weekly/monthly/custom weekday patterns, intervals, etc.), but expose it
  through a plain-language, non-technical UI builder (e.g. "every 2 weeks", "every Monday
  and Thursday") — users should never need to read/write raw RRULE syntax.
- Recurrence lifecycle (this exact state machine):
  1. Task is open, gets moved to "done" -> record `closed_at`.
  2. Task is scheduled to automatically reopen (move back to "open") at
     `closed_at + interval`, where `interval` is the task's recurrence period.
  3. If the task is reopened and is *not* closed again before the next
     `interval` elapses (counting from that reopen time), it is flagged overdue.
  - i.e. overdue is always relative to time-since-last-close/reopen, not a fixed calendar
    due date, for recurring tasks.
- Non-recurring tasks: support a plain due date; overdue = past due date and not in a
  "done"-mapped column.
- Overdue tasks must be visually highlighted distinctly on the board (not just a label).

## Metrics & Dashboard
Track per task/card, computed from column-transition history:
- Cycle time, lead time, waiting time, and time-spent-per-column.
Provide a dashboard rendering these as charts, where the user can configure which metric
widgets appear and how they're arranged (per board or org-wide view) — not a fixed,
one-size layout.

## Non-functional
- Real-time: board changes (card moves, edits, new cards) propagate live to other viewers
  of the same board via WebSockets, no manual refresh needed.
- Notifications: overdue flags and recurring-task reopen events can notify via in-app,
  email, and Android push — each channel independently toggleable per user in their
  notification settings.

### Reliability
- No silent data loss: writes (card edits, moves, uploads) either succeed and are
  confirmed, or fail visibly to the user — no partial/lost updates.
- Recurrence and notification processing (scheduler/workers) must survive restarts and
  not double-fire or drop events (idempotent job processing, persisted schedule state).
- Testability by design: core business logic (recurrence state machine, metrics
  calculation, RBAC/tenancy isolation) must be pure/isolated from I/O — DB, object
  storage, email/push, and IdP calls sit behind interfaces/adapters, so this logic is
  unit-testable without spinning up real infrastructure.
- Follow the testing pyramid: many fast unit tests, fewer integration tests (API + DB),
  fewest end-to-end tests (smoke-level, core board/card flow only). Do not invert this —
  e2e/integration tests should not be the primary way business logic gets covered.
- Unit tests favor stubs over mocks: prefer real/lightweight stand-ins for dependencies
  and assert on observable behavior/output, not on internal calls or interaction counts.
  Avoid mock-and-verify-call-was-made style tests that couple tests to implementation
  detail.
- Recurrence engine and RBAC/tenancy-isolation logic get a higher bar: exhaustive unit
  coverage of edge cases (e.g. reopen-then-not-closed-in-time, cross-tenant access
  attempts), not just happy-path.
- CI runs the full test suite (all pyramid levels) on every push; a failing test blocks
  merge.
- Health checks for all services (app, DB, object storage, workers), suitable for
  container orchestration liveness/readiness probes.
- Structured logging and error tracking (e.g. captured stack traces with request/user
  context) — enough to diagnose a production issue without reproducing it locally.

### Maintainability
- Layered/modular architecture with a clear boundary between API, business logic
  (recurrence engine, metrics engine), and data access — no business logic embedded in
  UI or route handlers.
- Consistent code style enforced via linter/formatter in CI, not manual review.
- Every module/service documented with its purpose and how it fits the whole (README per
  major component is enough, no need for exhaustive inline docs).
- DB schema changes go through versioned, reversible migrations only — no manual schema
  edits.
- Config (SSO/SAML, S3, email/push credentials, DB) via environment variables/config
  file, never hardcoded — one place to change per environment.

### Usability
- Board interactions (drag-drop, card expand, column edit) must give immediate visual
  feedback — no action that looks like it silently did nothing.
- Overdue/highlighted states, owner badges, and recurrence status must be understandable
  at a glance, without opening the card.
- Forms (task edit, recurrence builder, admin user management) validate inline with clear
  error messages — no silent rejection or generic "error occurred."
- Meet basic accessibility: keyboard-navigable board and forms, sufficient color contrast
  (don't rely on color alone for overdue/status — pair with icon/text), screen-reader
  labels on icon-only controls.
- Mobile and web share consistent terminology and information hierarchy, so a user
  moving between them isn't relearning the app.

## Deliverables
1. Brief architecture write-up (stack choices + why, data model overview, deployment
   topology).
2. Full source code: backend, frontend/web, Android app, DB migrations.
3. Dockerfiles + docker-compose for self-hosted deployment (app, DB, object storage, any
   workers/schedulers needed for recurrence processing).
4. GitHub Actions workflow(s) to build and publish container images.
5. A README covering local dev setup, configuration (SSO/SAML, S3, email/push
   credentials), and deployment steps.

Ask clarifying questions before starting if any requirement above is ambiguous or
technically conflicting; otherwise proceed and state assumptions explicitly as you make
them.