import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../services/context.js';
import * as boards from '../services/boards.js';
import * as metrics from '../services/metrics.js';
import * as policies from '../services/policies.js';
import { requireAuth } from '../auth/plugin.js';

const columnSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  position: z.number().int(),
  semantic: z.enum(['open', 'done']).nullable(),
});

const policySchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(['enter', 'leave']),
  label: z.string().min(1).max(300),
  position: z.number().int(),
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

    // ---- column policies: checklists gating card movement ----
    app.get('/:boardId/policies', async (req) => {
      const { boardId } = req.params as { boardId: string };
      return policies.listBoardPolicies(ctx, req.actor!, boardId);
    });

    /** Replace-style, per column: create / rename / delete / reorder in one call. */
    app.put('/:boardId/columns/:columnId/policies', async (req) => {
      const { boardId, columnId } = req.params as { boardId: string; columnId: string };
      const body = z.array(policySchema).max(50).parse(req.body);
      return policies.saveColumnPolicies(ctx, req.actor!, boardId, columnId, body);
    });

    /** Override audit — every skipped policy and forced backwards move. */
    app.get('/:boardId/policy-overrides', async (req) => {
      const { boardId } = req.params as { boardId: string };
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
      return policies.listOverrides(ctx, req.actor!, boardId, limit);
    });
  };
}
