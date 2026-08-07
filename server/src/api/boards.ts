import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../services/context.js';
import * as boards from '../services/boards.js';
import * as metrics from '../services/metrics.js';
import { requireAuth } from '../auth/plugin.js';

const columnSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  position: z.number().int(),
  semantic: z.enum(['open', 'done']).nullable(),
});

export function boardRoutes(ctx: AppCtx) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireAuth);

    app.get('/', async (req) => boards.listBoards(ctx, req.actor!));

    app.post('/', async (req) => {
      const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
      return boards.createBoard(ctx, req.actor!, body.name);
    });

    app.get('/:boardId', async (req) => {
      const { boardId } = req.params as { boardId: string };
      return boards.getBoardDetail(ctx, req.actor!, boardId);
    });

    app.patch('/:boardId', async (req) => {
      const { boardId } = req.params as { boardId: string };
      const body = z.object({ name: z.string().min(1).max(200).optional() }).parse(req.body);
      return boards.updateBoard(ctx, req.actor!, boardId, body);
    });

    app.delete('/:boardId', async (req) => {
      const { boardId } = req.params as { boardId: string };
      await boards.deleteBoard(ctx, req.actor!, boardId);
      return { ok: true };
    });

    app.put('/:boardId/columns', async (req) => {
      const { boardId } = req.params as { boardId: string };
      const body = z.array(columnSchema).min(2).parse(req.body);
      return boards.saveColumns(ctx, req.actor!, boardId, body);
    });

    app.put('/:boardId/lanes', async (req) => {
      const { boardId } = req.params as { boardId: string };
      const body = z
        .array(z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(100), position: z.number().int() }))
        .parse(req.body);
      return boards.saveLanes(ctx, req.actor!, boardId, body);
    });

    app.post('/:boardId/members', async (req) => {
      const { boardId } = req.params as { boardId: string };
      const body = z.object({ userId: z.string().uuid() }).parse(req.body);
      await boards.addBoardMember(ctx, req.actor!, boardId, body.userId);
      return { ok: true };
    });

    app.delete('/:boardId/members/:userId', async (req) => {
      const { boardId, userId } = req.params as { boardId: string; userId: string };
      await boards.removeBoardMember(ctx, req.actor!, boardId, userId);
      return { ok: true };
    });

    app.get('/:boardId/metrics', async (req) => {
      const { boardId } = req.params as { boardId: string };
      return metrics.boardMetrics(ctx, req.actor!, boardId);
    });
  };
}
