import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../services/context.js';
import * as cards from '../services/cards.js';
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
          laneId: z.string().uuid().nullable().optional(),
          categoryId: z.string().uuid().nullable().optional(),
          dueDate: z.string().datetime().nullable().optional(),
          recurrenceRule: recurrenceSchema.nullable().optional(),
          coverAttachmentId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);
      return cards.updateCard(ctx, req.actor!, cardId, body);
    });

    app.post('/:cardId/move', async (req) => {
      const { cardId } = req.params as { cardId: string };
      const body = z
        .object({
          toColumnId: z.string().uuid(),
          laneId: z.string().uuid().nullable().optional(),
          position: z.number().optional(),
        })
        .parse(req.body);
      return cards.moveCard(ctx, req.actor!, cardId, body.toColumnId, { laneId: body.laneId, position: body.position });
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
