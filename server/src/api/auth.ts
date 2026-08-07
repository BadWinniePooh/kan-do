import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { AppCtx } from '../services/context.js';
import { signSession, SESSION_COOKIE } from '../auth/session.js';
import * as sso from '../services/sso.js';
import { config } from '../config.js';
import type { UsersTable } from '../db/types.js';
import type { Selectable } from 'kysely';

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.env === 'production',
  path: '/',
  maxAge: config.sessionTtlHours * 3600,
};

async function issueSession(user: Selectable<UsersTable>): Promise<string> {
  return signSession({ userId: user.id, role: user.role, orgId: user.org_id });
}

export function authRoutes(ctx: AppCtx) {
  return async (app: FastifyInstance) => {
    app.post('/login', async (req, reply) => {
      const body = z.object({ email: z.string().email(), password: z.string().min(1), orgSlug: z.string().optional() }).parse(req.body);
      let q = ctx.db.selectFrom('users').selectAll().where('email', '=', body.email.toLowerCase());
      if (body.orgSlug) {
        const org = await ctx.db.selectFrom('organizations').select('id').where('slug', '=', body.orgSlug).executeTakeFirst();
        if (!org) return reply.code(401).send({ error: 'invalid credentials' });
        q = q.where('org_id', '=', org.id);
      }
      const users = await q.execute();
      // email may exist in several orgs; try each until a password matches
      for (const user of users) {
        if (!user.active || !user.password_hash) continue;
        if (await bcrypt.compare(body.password, user.password_hash)) {
          reply.setCookie(SESSION_COOKIE, await issueSession(user), cookieOpts);
          return { id: user.id, email: user.email, displayName: user.display_name, role: user.role, orgId: user.org_id };
        }
      }
      return reply.code(401).send({ error: 'invalid credentials' });
    });

    app.post('/logout', async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    /** Which SSO options exist for an org (login screen probes this). */
    app.get('/providers/:orgSlug', async (req) => {
      const { orgSlug } = req.params as { orgSlug: string };
      const org = await ctx.db.selectFrom('organizations').select('id').where('slug', '=', orgSlug).executeTakeFirst();
      if (!org) return { providers: [] };
      const idps = await ctx.db
        .selectFrom('idp_configs')
        .select(['type', 'display_name'])
        .where('org_id', '=', org.id)
        .where('enabled', '=', true)
        .execute();
      return { providers: idps };
    });

    // ---- OIDC ----
    app.get('/oidc/:orgSlug/start', async (req, reply) => {
      const { orgSlug } = req.params as { orgSlug: string };
      const { url, state, verifier } = await sso.oidcStart(ctx, orgSlug);
      reply.setCookie('oidc_tx', JSON.stringify({ state, verifier }), { ...cookieOpts, maxAge: 600 });
      return reply.redirect(url);
    });

    app.get('/oidc/:orgSlug/callback', async (req, reply) => {
      const { orgSlug } = req.params as { orgSlug: string };
      const tx = JSON.parse(req.cookies['oidc_tx'] ?? '{}') as { state?: string; verifier?: string };
      if (!tx.state || !tx.verifier) return reply.code(400).send({ error: 'missing OIDC transaction' });
      const currentUrl = `${config.publicUrl}${req.raw.url}`;
      const user = await sso.oidcCallback(ctx, orgSlug, currentUrl, tx.state, tx.verifier);
      reply.clearCookie('oidc_tx', { path: '/' });
      reply.setCookie(SESSION_COOKIE, await issueSession(user), cookieOpts);
      return reply.redirect(config.webOrigin);
    });

    // ---- SAML ----
    app.get('/saml/:orgSlug/start', async (req, reply) => {
      const { orgSlug } = req.params as { orgSlug: string };
      return reply.redirect(await sso.samlStart(ctx, orgSlug));
    });

    app.post('/saml/:orgSlug/callback', async (req, reply) => {
      const { orgSlug } = req.params as { orgSlug: string };
      const user = await sso.samlCallback(ctx, orgSlug, req.body as Record<string, string>);
      reply.setCookie(SESSION_COOKIE, await issueSession(user), cookieOpts);
      return reply.redirect(config.webOrigin);
    });

    app.get('/me', async (req, reply) => {
      if (!req.actor) return reply.code(401).send({ error: 'unauthenticated' });
      const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', req.actor.userId).executeTakeFirst();
      if (!user || !user.active) return reply.code(401).send({ error: 'unauthenticated' });
      let orgSlug: string | null = null;
      if (user.org_id) {
        const org = await ctx.db.selectFrom('organizations').select('slug').where('id', '=', user.org_id).executeTakeFirst();
        orgSlug = org?.slug ?? null;
      }
      return {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        orgId: user.org_id,
        orgSlug,
        avatarUrl: user.avatar_key ? await ctx.storage.presignDownload(user.avatar_key) : null,
      };
    });
  };
}
