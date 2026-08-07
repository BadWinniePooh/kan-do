/** Per-user endpoints: notifications, settings, push tokens, dashboards, uploads. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppCtx } from '../services/context.js';
import { requireAuth } from '../auth/plugin.js';

export function meRoutes(ctx: AppCtx) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireAuth);

    app.get('/notifications', async (req) => {
      return ctx.db
        .selectFrom('notifications')
        .selectAll()
        .where('user_id', '=', req.actor!.userId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute();
    });

    app.post('/notifications/read', async (req) => {
      const body = z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(req.body);
      await ctx.db
        .updateTable('notifications')
        .set({ read_at: new Date() })
        .where('user_id', '=', req.actor!.userId)
        .where('id', 'in', body.ids)
        .execute();
      return { ok: true };
    });

    app.get('/notification-settings', async (req) => {
      return ctx.db.selectFrom('notification_settings').selectAll().where('user_id', '=', req.actor!.userId).execute();
    });

    app.put('/notification-settings', async (req) => {
      const body = z
        .array(
          z.object({
            event: z.enum(['overdue', 'reopen']),
            channel: z.enum(['inapp', 'email', 'push']),
            enabled: z.boolean(),
          }),
        )
        .parse(req.body);
      for (const s of body) {
        await ctx.db
          .insertInto('notification_settings')
          .values({ user_id: req.actor!.userId, ...s })
          .onConflict((oc) => oc.columns(['user_id', 'event', 'channel']).doUpdateSet({ enabled: s.enabled }))
          .execute();
      }
      return { ok: true };
    });

    app.post('/push-tokens', async (req) => {
      const body = z.object({ token: z.string().min(10), platform: z.string().default('android') }).parse(req.body);
      await ctx.db
        .insertInto('push_tokens')
        .values({ token: body.token, user_id: req.actor!.userId, platform: body.platform })
        .onConflict((oc) => oc.column('token').doUpdateSet({ user_id: req.actor!.userId }))
        .execute();
      return { ok: true };
    });

    app.patch('/profile', async (req) => {
      const body = z.object({ displayName: z.string().min(1).max(200).optional(), avatarKey: z.string().optional() }).parse(req.body);
      const set: Record<string, unknown> = { updated_at: new Date() };
      if (body.displayName) set.display_name = body.displayName;
      if (body.avatarKey) set.avatar_key = body.avatarKey;
      return ctx.db
        .updateTable('users')
        .set(set)
        .where('id', '=', req.actor!.userId)
        .returning(['id', 'display_name', 'avatar_key'])
        .executeTakeFirstOrThrow();
    });

    // ---- org user directory: light list for board-member picking (no roles,
    // no admin data) — scoped to the caller's own org ----
    app.get('/org-users', async (req, reply) => {
      if (!req.actor!.orgId) return reply.code(400).send({ error: 'not in an organization' });
      return ctx.db
        .selectFrom('users')
        .select(['id', 'display_name', 'email'])
        .where('org_id', '=', req.actor!.orgId)
        .where('active', '=', true)
        .orderBy('display_name')
        .execute();
    });

    // ---- external owners: readable/creatable by any org user so cards can
    // model external dependencies without admin round-trips ----
    app.get('/external-owners', async (req, reply) => {
      if (!req.actor!.orgId) return reply.code(400).send({ error: 'not in an organization' });
      return ctx.db.selectFrom('external_owners').selectAll().where('org_id', '=', req.actor!.orgId).orderBy('display_name').execute();
    });

    app.post('/external-owners', async (req, reply) => {
      if (!req.actor!.orgId) return reply.code(400).send({ error: 'not in an organization' });
      const body = z.object({ displayName: z.string().min(1).max(200) }).parse(req.body);
      return ctx.db
        .insertInto('external_owners')
        .values({ org_id: req.actor!.orgId, display_name: body.displayName })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    // ---- dashboard config ----
    app.get('/dashboard', async (req) => {
      const boardId = (req.query as { boardId?: string }).boardId ?? null;
      let q = ctx.db.selectFrom('dashboard_configs').selectAll().where('user_id', '=', req.actor!.userId);
      q = boardId ? q.where('board_id', '=', boardId) : q.where('board_id', 'is', null);
      return (await q.executeTakeFirst()) ?? { layout: null };
    });

    app.put('/dashboard', async (req) => {
      const body = z
        .object({
          boardId: z.string().uuid().nullable(),
          layout: z.array(
            z.object({
              id: z.string(),
              widget: z.enum(['lead', 'cycle', 'waiting', 'perColumn', 'overdueCount', 'throughput']),
              w: z.number().int().min(1).max(12),
              h: z.number().int().min(1).max(12),
            }),
          ),
        })
        .parse(req.body);
      const existing = await ctx.db
        .selectFrom('dashboard_configs')
        .select('id')
        .where('user_id', '=', req.actor!.userId)
        .where((eb) => (body.boardId ? eb('board_id', '=', body.boardId) : eb('board_id', 'is', null)))
        .executeTakeFirst();
      if (existing) {
        return ctx.db
          .updateTable('dashboard_configs')
          .set({ layout: JSON.stringify(body.layout), updated_at: new Date() })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return ctx.db
        .insertInto('dashboard_configs')
        .values({ user_id: req.actor!.userId, board_id: body.boardId, layout: JSON.stringify(body.layout) })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    // ---- uploads (presigned; the browser PUTs directly to object storage) ----
    app.post('/uploads/presign', async (req) => {
      const body = z
        .object({
          filename: z.string().min(1).max(300),
          contentType: z.string().regex(/^image\//, 'only images are allowed'),
          purpose: z.enum(['card', 'avatar']),
          cardId: z.string().uuid().optional(),
        })
        .parse(req.body);
      const ext = body.filename.includes('.') ? body.filename.slice(body.filename.lastIndexOf('.')) : '';
      const key = `${body.purpose}/${req.actor!.userId}/${randomUUID()}${ext}`;
      const uploadUrl = await ctx.storage.presignUpload(key, body.contentType);
      return { key, uploadUrl };
    });

    app.post('/uploads/confirm', async (req, reply) => {
      const body = z
        .object({
          key: z.string().min(1),
          cardId: z.string().uuid(),
          filename: z.string().min(1),
          contentType: z.string(),
          sizeBytes: z.number().int().min(0),
          asCover: z.boolean().default(false),
        })
        .parse(req.body);
      const card = await ctx.db.selectFrom('cards').select(['id', 'board_id']).where('id', '=', body.cardId).executeTakeFirst();
      if (!card) return reply.code(404).send({ error: 'card not found' });
      const attachment = await ctx.db
        .insertInto('attachments')
        .values({
          card_id: body.cardId,
          object_key: body.key,
          filename: body.filename,
          content_type: body.contentType,
          size_bytes: body.sizeBytes,
          uploaded_by: req.actor!.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (body.asCover) {
        await ctx.db.updateTable('cards').set({ cover_attachment_id: attachment.id }).where('id', '=', body.cardId).execute();
      }
      ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId: body.cardId });
      return { ...attachment, url: await ctx.storage.presignDownload(body.key) };
    });
  };
}
