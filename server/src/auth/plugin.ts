import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SESSION_COOKIE, verifySession } from './session.js';
import type { Actor } from '../domain/rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('actor', null);
  app.addHook('preHandler', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.actor = token ? await verifySession(token) : null;
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.actor) {
    reply.code(401).send({ error: 'unauthenticated' });
  }
}

export async function requireGlobalAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.actor || req.actor.role !== 'global_admin') {
    reply.code(403).send({ error: 'forbidden' });
  }
}
