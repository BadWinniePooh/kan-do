import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { ZodError } from 'zod';
import { config } from './config.js';
import { registerAuth } from './auth/plugin.js';
import { HttpError } from './services/context.js';
import type { AppCtx } from './services/context.js';
import { authRoutes } from './api/auth.js';
import { boardRoutes } from './api/boards.js';
import { cardRoutes } from './api/cards.js';
import { globalAdminRoutes, orgAdminRoutes } from './api/admin.js';
import { meRoutes } from './api/me.js';
import { sql } from 'kysely';

export async function buildApp(ctx: AppCtx): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.env === 'production' ? 'info' : 'debug',
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  });

  await app.register(cookie);
  await app.register(formbody); // SAML POST callback
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  registerAuth(app);

  // structured error responses; validation errors carry field detail
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation',
        fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    req.log.error({ err, userId: req.actor?.userId, url: req.url }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error' });
  });

  // liveness: process is up; readiness: dependencies reachable
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      await sql`select 1`.execute(ctx.db);
      checks.db = true;
    } catch {
      checks.db = false;
    }
    checks.storage = await ctx.storage.healthy();
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  await app.register(authRoutes(ctx), { prefix: '/api/auth' });
  await app.register(boardRoutes(ctx), { prefix: '/api/boards' });
  await app.register(cardRoutes(ctx), { prefix: '/api/cards' });
  await app.register(globalAdminRoutes(ctx), { prefix: '/api/admin' });
  await app.register(orgAdminRoutes(ctx), { prefix: '/api/orgs' });
  await app.register(meRoutes(ctx), { prefix: '/api/me' });

  return app;
}
