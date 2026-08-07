import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../services/context.js';
import * as cards from '../services/cards.js';
import * as policies from '../services/policies.js';
import { requireAuth } from '../auth/plugin.js';

const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  byMonthDay: z.number().int().min(1).max(31).optional(),
});

export function cardRoutes(ctx: AppCtx) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireAuth);

    app.post('/', async (req) => {
      const body = z
        .object({
          boardId: z.string().uuid(),
          columnId: z.string().uuid(),
          laneId: z.string().uuid().nullish(),
          title: z.string().min(1).max(500),
          description: z.string().max(20000).optional(),
          position: z.number().optional(),
        })
        .parse(req.body);
      return cards.createCard(ctx, req.actor!, body);
    });

    app.get('/:cardId', async (req) => {
      const { cardId } = req.params as { cardId: string };
      return cards.getCardDetail(ctx, req.actor!, cardId);
    });

    app.patch('/:cardId', async (req) => {
      const { cardId } = req.params as { cardId: string };
      const body = z
        .object({
          title: z.string().min(1).max(500).optional(),
          description: z.string().max(20000).nullable().optional(),
          // lane changes are moves, not patches — see POST /:cardId/move
          categoryId: z.string().uuid().nullable().optional(),
          dueDate: z.string().datetime().nullable().optional(),
          recurrenceRule: recurrenceSchema.nullable().optional(),
          coverAttachmentId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);
      return cards.updateCard(ctx, req.actor!, cardId, body);
    });

    /** What the move dialog needs before attempting: checklist + direction. */
    app.get('/:cardId/move-requirements', async (req) => {
      const { cardId } = req.params as { cardId: string };
      const { toColumnId } = z.object({ toColumnId: z.string().uuid() }).parse(req.query);
      return policies.getMoveRequirements(ctx, req.actor!, cardId, toColumnId);
    });

    app.post('/:cardId/move', async (req) => {
      const body = z
        .object({
          toColumnId: z.string().uuid(),
          laneId: z.string().uuid().nullable().optional(),
          position: z.number().optional(),
          /** full checklist state for this attempt — saved even if the move is refused */
          acknowledgedPolicyIds: z.array(z.string().uuid()).max(100).optional(),
          /** justification; the service requires it for overrides and discards */
          reason: z.string().max(1000).optional(),
          override: z
            .object({
              policies: z.boolean().optional(),
              backwards: z.boolean().optional(),
              lane: z.boolean().optional(),
            })
            .optional(),
        })
        .parse(req.body);
      const { cardId } = req.params as { cardId: string };
      return cards.moveCard(ctx, req.actor!, cardId, body.toColumnId, {
        laneId: body.laneId,
        position: body.position,
        acknowledgedPolicyIds: body.acknowledgedPolicyIds,
        reason: body.reason,
        override: body.override,
      });
    });

    /** Full history for the card audit view. */
    app.get('/:cardId/audit', async (req) => {
      const { cardId } = req.params as { cardId: string };
      return cards.getCardAudit(ctx, req.actor!, cardId);
    });

    /** Save checklist ticks without moving — "I did some of it, come back later". */
    app.post('/:cardId/move-progress', async (req) => {
      const { cardId } = req.params as { cardId: string };
      const body = z
        .object({ toColumnId: z.string().uuid(), acknowledgedPolicyIds: z.array(z.string().uuid()).max(100) })
        .parse(req.body);
      return policies.saveMoveProgress(ctx, req.actor!, cardId, body.toColumnId, body.acknowledgedPolicyIds);
    });

    app.delete('/:cardId', async (req) => {
      const { cardId } = req.params as { cardId: string };
      await cards.deleteCard(ctx, req.actor!, cardId);
      return { ok: true };
    });

    app.put('/:cardId/owners', async (req) => {
      const { cardId } = req.params as { cardId: string };
      const body = z
        .array(z.object({ kind: z.enum(['user', 'external']), id: z.string().uuid() }))
        .max(20)
        .parse(req.body);
      await cards.setOwners(ctx, req.actor!, cardId, body);
      return { ok: true };
    });

    app.post('/:cardId/notes', async (req) => {
      const { cardId } = req.params as { cardId: string };
      const body = z.object({ markdown: z.string().min(1).max(100000) }).parse(req.body);
      return cards.addNote(ctx, req.actor!, cardId, body.markdown);
    });

    app.patch('/:cardId/notes/:noteId', async (req) => {
      const { cardId, noteId } = req.params as { cardId: string; noteId: string };
      const body = z.object({ markdown: z.string().min(1).max(100000) }).parse(req.body);
      return cards.updateNote(ctx, req.actor!, cardId, noteId, body.markdown);
    });

    app.delete('/:cardId/notes/:noteId', async (req) => {
      const { cardId, noteId } = req.params as { cardId: string; noteId: string };
      await cards.deleteNote(ctx, req.actor!, cardId, noteId);
      return { ok: true };
    });
  };
}
