# Kan-Do

Multi-tenant kanban task tracker with recurring tasks, live boards, metrics
dashboards, SSO, and an Android app. See [ARCHITECTURE.md](ARCHITECTURE.md) for
stack rationale and design.

- **Web + Android** from one React codebase (Capacitor shell — [web/ANDROID.md](web/ANDROID.md))
- **Recurring tasks** with plain-language scheduling (full RRULE semantics underneath)
- **Real-time** board updates via WebSockets
- **Three separated UIs**: Global Admin (orgs), Org Admin (users + SSO), Users (boards)
- **Metrics**: cycle/lead/waiting/per-column time, configurable dashboard

## Local development

Prereqs: Node 22, pnpm 9, Docker.

```bash
pnpm install

# infra only (Postgres + MinIO)
docker compose up -d db minio

# migrate + run API (terminal 1)
cd server
pnpm migrate:up
pnpm dev

# worker (terminal 2)
cd server && pnpm tsx src/worker.ts

# web (terminal 3)
cd web && pnpm dev        # http://localhost:5173, proxies /api + websocket
```

First start creates a **global admin** from `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD` (defaults `admin@example.com` / `admin1234` —
change these). Log in as the admin → create an organization → create its first
user (or promote one to org admin). Org admins invite users and configure SSO;
users create boards.

### Tests

```bash
pnpm --filter @kan-do/server test              # unit (pure domain)
DATABASE_URL=postgres://kando:kando@localhost:5432/kando \
  pnpm --filter @kan-do/server test:integration # API + DB
pnpm --filter @kan-do/e2e test                 # smoke, needs full stack up
```

## Self-hosted deployment

```bash
cp .env.example .env    # set SESSION_SECRET (required) + public URLs
docker compose up -d
```

- Web UI: `http://localhost:8080`
- MinIO console: `http://localhost:9001`
- Images are published by GitHub Actions to GHCR on pushes to `main` and `v*`
  tags (`kan-do-server`, `kan-do-web`); compose uses them or builds locally.

### Configuration (all via environment)

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | signs session cookies — long random string, required |
| `PUBLIC_URL` | externally reachable app origin (used in SSO callbacks) |
| `DATABASE_URL` | Postgres connection string |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | S3 API endpoint (internal / browser-reachable) |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | object storage credentials |
| `SMTP_HOST/PORT/USER/PASS/FROM` | email channel (empty host = disabled) |
| `FCM_CREDENTIALS_FILE` | Firebase service-account JSON path (Android push; empty = disabled) |
| `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` | first global admin |

### SSO (per organization, no code changes)

Org admins (or global admins) add IdPs in the **Org Admin → Single sign-on**
UI:

- **OIDC**: issuer URL, client id, client secret. Redirect URI to register at
  the IdP: `<PUBLIC_URL>/api/auth/oidc/<org-slug>/callback`
- **SAML**: IdP SSO URL, SP entity id, IdP signing certificate. ACS URL:
  `<PUBLIC_URL>/api/auth/saml/<org-slug>/callback`

The login screen shows SSO buttons once the user types their org slug. SSO
users are provisioned automatically on first login. Local username/password
stays available as fallback.

## Repository layout

| Path | What |
|---|---|
| `server/` | Fastify API, domain logic, workers, migrations ([README](server/README.md)) |
| `web/` | React SPA + Capacitor Android shell ([README](web/README.md)) |
| `packages/shared/` | types shared by client & server (recurrence rule, events) |
| `e2e/` | Playwright smoke tests |
| `.github/workflows/` | CI (lint, unit, integration, e2e) + image publishing |
