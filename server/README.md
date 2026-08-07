# @kan-do/server

Fastify API + background workers. Fits the whole as the single backend for web
and Android clients (REST + Socket.IO), owner of all business rules.

## Layout

| Path | Purpose |
|---|---|
| `src/domain/` | **Pure logic, no I/O**: recurrence state machine, metrics math, RBAC/tenancy. Unit-tested exhaustively (`*.test.ts` beside the code). |
| `src/services/` | Orchestration: DB (Kysely), job scheduling, realtime emits. Receive an `AppCtx` container — tests inject stubs. |
| `src/api/` | Route handlers: zod validation + auth glue only, no business logic. |
| `src/adapters/` | S3 / SMTP / FCM behind interfaces. |
| `src/realtime/` | Socket.IO gateway (API process) + Postgres NOTIFY bridge (workers). |
| `src/jobs/` + `src/worker.ts` | pg-boss queues and consumers: recurrence reopens, overdue checks, due-date scans, notification fan-out. |
| `migrations/` | node-pg-migrate, versioned + reversible; CI runs down+up. |

## Commands

```bash
pnpm dev                # tsx watch, http://localhost:3001
pnpm migrate:up | migrate:down
pnpm test               # unit (no infra needed)
pnpm test:integration   # needs DATABASE_URL to a migrated Postgres
pnpm build && pnpm start
node dist/worker.js     # worker process
```

Entry points: `src/index.ts` (API), `src/worker.ts` (workers). Both are safe to
run in multiple replicas.
