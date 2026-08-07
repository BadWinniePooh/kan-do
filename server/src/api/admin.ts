/**
 * Admin APIs. Global admin: org management. Org admin: user + IdP management
 * inside their org. All checks go through domain/rbac.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { AppCtx } from '../services/context.js';
import { requireAuth, requireGlobalAdmin } from '../auth/plugin.js';
import { canManageIdp, canManageOrgUsers } from '../domain/rbac.js';

const idpConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('oidc'),
    displayName: z.string().min(1),
    config: z.object({
      issuer: z.string().url(),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      scopes: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('saml'),
    displayName: z.string().min(1),
    config: z.object({
      entryPoint: z.string().url(),
      issuer: z.string().min(1),
      cert: z.string().min(1),
    }),
  }),
]);

export function globalAdminRoutes(ctx: AppCtx) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireGlobalAdmin);

    app.get('/orgs', async () => {
      return ctx.db
        .selectFrom('organizations')
        .leftJoin('users', 'users.org_id', 'organizations.id')
        .select(({ fn }) => ['organizations.id', 'organizations.name', 'organizations.slug', 'organizations.active', 'organizations.created_at', fn.count('users.id').as('user_count')])
        .groupBy('organizations.id')
        .orderBy('organizations.created_at')
        .execute();
    });

    app.post('/orgs', async (req) => {
      const body = z.object({ name: z.string().min(1).max(200), slug: z.string().regex(/^[a-z0-9-]{2,50}$/) }).parse(req.body);
      return ctx.db.insertInto('organizations').values(body).returningAll().executeTakeFirstOrThrow();
    });

    app.patch('/orgs/:orgId', async (req) => {
      const { orgId } = req.params as { orgId: string };
      const body = z.object({ name: z.string().min(1).max(200).optional(), active: z.boolean().optional() }).parse(req.body);
      return ctx.db
        .updateTable('organizations')
        .set({ ...body, updated_at: new Date() })
        .where('id', '=', orgId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    /**
     * Deletes the org and, via FK cascade, all its users/boards/cards/etc.
     *
     * Boards go first, deliberately. Deleting the org in one statement makes
     * Postgres cascade users and cards together, and clearing a deleted user
     * from card_blockers.created_by (ON DELETE SET NULL) re-checks that row's
     * card_id against a card the same command already removed — which errors.
     * Removing the boards first empties those tables before the users go.
     */
    app.delete('/orgs/:orgId', async (req) => {
      const { orgId } = req.params as { orgId: string };
      await ctx.db.transaction().execute(async (trx) => {
        await trx.deleteFrom('boards').where('org_id', '=', orgId).execute();
        await trx.deleteFrom('organizations').where('id', '=', orgId).execute();
      });
      return { ok: true };
    });

    app.get('/orgs/:orgId/users', async (req) => {
      const { orgId } = req.params as { orgId: string };
      return ctx.db
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'role', 'active', 'created_at'])
        .where('org_id', '=', orgId)
        .orderBy('created_at')
        .execute();
    });

    /** promote/demote org admins */
    app.patch('/orgs/:orgId/users/:userId/role', async (req) => {
      const { orgId, userId } = req.params as { orgId: string; userId: string };
      const body = z.object({ role: z.enum(['org_admin', 'user']) }).parse(req.body);
      return ctx.db
        .updateTable('users')
        .set({ role: body.role, updated_at: new Date() })
        .where('id', '=', userId)
        .where('org_id', '=', orgId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  };
}

export function orgAdminRoutes(ctx: AppCtx) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireAuth);
    app.addHook('preHandler', async (req, reply) => {
      const { orgId } = req.params as { orgId: string };
      if (!canManageOrgUsers(req.actor!, orgId)) {
        reply.code(403).send({ error: 'forbidden' });
      }
    });

    app.get('/:orgId/users', async (req) => {
      const { orgId } = req.params as { orgId: string };
      return ctx.db
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'role', 'active', 'created_at'])
        .where('org_id', '=', orgId)
        .orderBy('created_at')
        .execute();
    });

    app.post('/:orgId/users', async (req) => {
      const { orgId } = req.params as { orgId: string };
      const body = z
        .object({
          email: z.string().email(),
          displayName: z.string().min(1).max(200),
          password: z.string().min(8).optional(),
          role: z.enum(['org_admin', 'user']).default('user'),
        })
        .parse(req.body);
      return ctx.db
        .insertInto('users')
        .values({
          org_id: orgId,
          email: body.email.toLowerCase(),
          display_name: body.displayName,
          role: body.role,
          password_hash: body.password ? await bcrypt.hash(body.password, 10) : null,
        })
        .returning(['id', 'email', 'display_name', 'role', 'active'])
        .executeTakeFirstOrThrow();
    });

    app.patch('/:orgId/users/:userId', async (req, reply) => {
      const { orgId, userId } = req.params as { orgId: string; userId: string };
      const body = z
        .object({
          displayName: z.string().min(1).max(200).optional(),
          active: z.boolean().optional(),
          role: z.enum(['org_admin', 'user']).optional(),
          password: z.string().min(8).optional(),
        })
        .parse(req.body);
      if (userId === req.actor!.userId && body.active === false) {
        return reply.code(400).send({ error: 'cannot deactivate yourself' });
      }
      const set: Record<string, unknown> = { updated_at: new Date() };
      if (body.displayName !== undefined) set.display_name = body.displayName;
      if (body.active !== undefined) set.active = body.active;
      if (body.role !== undefined) set.role = body.role;
      if (body.password !== undefined) set.password_hash = await bcrypt.hash(body.password, 10);
      return ctx.db
        .updateTable('users')
        .set(set)
        .where('id', '=', userId)
        .where('org_id', '=', orgId)
        .returning(['id', 'email', 'display_name', 'role', 'active'])
        .executeTakeFirstOrThrow();
    });

    // ---- external owners (org-scoped directory of non-user owners) ----
    app.get('/:orgId/external-owners', async (req) => {
      const { orgId } = req.params as { orgId: string };
      return ctx.db.selectFrom('external_owners').selectAll().where('org_id', '=', orgId).orderBy('display_name').execute();
    });

    app.post('/:orgId/external-owners', async (req) => {
      const { orgId } = req.params as { orgId: string };
      const body = z.object({ displayName: z.string().min(1).max(200) }).parse(req.body);
      return ctx.db
        .insertInto('external_owners')
        .values({ org_id: orgId, display_name: body.displayName })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    app.delete('/:orgId/external-owners/:id', async (req) => {
      const { orgId, id } = req.params as { orgId: string; id: string };
      await ctx.db.deleteFrom('external_owners').where('id', '=', id).where('org_id', '=', orgId).execute();
      return { ok: true };
    });

    // ---- IdP config ----
    app.get('/:orgId/idps', async (req, reply) => {
      const { orgId } = req.params as { orgId: string };
      if (!canManageIdp(req.actor!, orgId)) return reply.code(403).send({ error: 'forbidden' });
      const idps = await ctx.db.selectFrom('idp_configs').selectAll().where('org_id', '=', orgId).execute();
      // never echo secrets back in full
      return idps.map((i) => ({
        ...i,
        config: { ...(i.config as object), clientSecret: undefined, cert: undefined },
      }));
    });

    app.post('/:orgId/idps', async (req) => {
      const { orgId } = req.params as { orgId: string };
      const body = idpConfigSchema.parse(req.body);
      return ctx.db
        .insertInto('idp_configs')
        .values({ org_id: orgId, type: body.type, display_name: body.displayName, config: JSON.stringify(body.config) })
        .returning(['id', 'type', 'display_name', 'enabled'])
        .executeTakeFirstOrThrow();
    });

    app.patch('/:orgId/idps/:idpId', async (req) => {
      const { orgId, idpId } = req.params as { orgId: string; idpId: string };
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      return ctx.db
        .updateTable('idp_configs')
        .set({ enabled: body.enabled, updated_at: new Date() })
        .where('id', '=', idpId)
        .where('org_id', '=', orgId)
        .returning(['id', 'enabled'])
        .executeTakeFirstOrThrow();
    });

    app.delete('/:orgId/idps/:idpId', async (req) => {
      const { orgId, idpId } = req.params as { orgId: string; idpId: string };
      await ctx.db.deleteFrom('idp_configs').where('id', '=', idpId).where('org_id', '=', orgId).execute();
      return { ok: true };
    });
  };
}
