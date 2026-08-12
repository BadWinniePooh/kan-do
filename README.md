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

Prereqs: Node 24, pnpm 11, Docker. `corepack enable` picks up the exact version
from the `packageManager` field.

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

Two compose files, same images: `docker-compose.yml` publishes ports on the
host, `docker-compose.traefik.yml` publishes nothing and is reached through a
reverse proxy you already run.

### Local (published ports)

```bash
cp .env.example .env    # set SESSION_SECRET (required)
docker compose up -d
```

- Web UI: `http://localhost:8080`
- MinIO console: `http://localhost:9001`

Every host port is configurable, and the public URLs follow whichever ports you
pick — change `WEB_HOST_PORT` alone and `PUBLIC_URL` moves with it, so SSO
callback URLs and the CORS origin cannot silently drift out of sync:

| Variable | Default | Publishes |
|---|---|---|
| `WEB_HOST_PORT` | `8080` | web UI |
| `S3_HOST_PORT` | `9000` | S3 API (browsers fetch attachments from it) |
| `MINIO_CONSOLE_HOST_PORT` | `9001` | MinIO console |
| `POSTGRES_HOST_PORT` | `55432` | Postgres, on loopback only |

Set `PUBLIC_URL` / `S3_PUBLIC_ENDPOINT` explicitly only to override that
derivation — for example when reaching the stack over a LAN address rather than
`localhost`.

### Public (behind an existing Traefik)

```bash
cp .env.example .env    # set APP_HOST, S3_HOST, SESSION_SECRET, passwords
docker compose -f docker-compose.traefik.yml up -d
```

Traefik is **not** part of this compose file — the stack only joins the network
your Traefik already watches (`TRAEFIK_NETWORK`, which must exist first), so it
can be deployed and torn down without touching your proxy. No host ports are
published: Postgres and the MinIO console are unreachable from outside the
Docker network.

**Two hostnames are required, not one.** Browsers fetch attachments and avatars
directly from object storage through presigned URLs, so the S3 API needs its own
public hostname alongside the app:

| Variable | Purpose |
|---|---|
| `APP_HOST` | app hostname; `PUBLIC_URL` becomes `https://$APP_HOST` |
| `S3_HOST` | object storage hostname; must differ from `APP_HOST` |
| `TRAEFIK_NETWORK` | existing Docker network Traefik watches (default `traefik`) |
| `TRAEFIK_ENTRYPOINT` | entrypoint name from your Traefik config (default `websecure`) |
| `TRAEFIK_CERTRESOLVER` | cert resolver name from your Traefik config (default `letsencrypt`) |

`TRAEFIK_ENTRYPOINT` and `TRAEFIK_CERTRESOLVER` name things defined in *your*
Traefik static configuration — if the resolver does not exist there, the routers
come up without a certificate. Compose fails fast with a named variable if any
required value is missing, so a misconfigured `.env` never reaches a half-started
stack.

Images are published by GitHub Actions to GHCR on pushes to `main` and `v*` tags
(`kan-do-server`, `kan-do-web`); both compose files use them or build locally.

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
