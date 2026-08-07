/**
 * Socket.IO gateway: one room per board. Clients join after the server checks
 * board access with the same RBAC rules as the REST API.
 */
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { BoardEvent } from '@kan-do/shared';
import { verifySession } from '../auth/session.js';
import { canAccessBoard } from '../domain/rbac.js';
import type { Db } from '../db/index.js';
import { config } from '../config.js';

export interface Realtime {
  emitToBoard(boardId: string, event: BoardEvent): void;
  emitToUser(userId: string, event: { type: 'notification' }): void;
}

export function createRealtime(http: HttpServer, db: Db): Realtime {
  const io = new Server(http, {
    cors: { origin: config.webOrigin, credentials: true },
  });

  io.use(async (socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie ?? '';
    const token = /(?:^|;\s*)kando_session=([^;]+)/.exec(cookieHeader)?.[1]
      ?? (socket.handshake.auth?.token as string | undefined);
    const actor = token ? await verifySession(decodeURIComponent(token)) : null;
    if (!actor) return next(new Error('unauthenticated'));
    socket.data.actor = actor;
    next();
  });

  io.on('connection', (socket) => {
    const actor = socket.data.actor;
    socket.join(`user:${actor.userId}`);

    socket.on('board:join', async (boardId: string, ack?: (ok: boolean) => void) => {
      const board = await db.selectFrom('boards').select(['id', 'org_id']).where('id', '=', boardId).executeTakeFirst();
      if (!board) return ack?.(false);
      const members = await db.selectFrom('board_members').select('user_id').where('board_id', '=', boardId).execute();
      const ok = canAccessBoard(actor, { orgId: board.org_id, memberIds: members.map((m) => m.user_id) }, 'view');
      if (ok) socket.join(`board:${boardId}`);
      ack?.(ok);
    });

    socket.on('board:leave', (boardId: string) => {
      socket.leave(`board:${boardId}`);
    });
  });

  return {
    emitToBoard(boardId, event) {
      io.to(`board:${boardId}`).emit('board:event', event);
    },
    emitToUser(userId, event) {
      io.to(`user:${userId}`).emit('user:event', event);
    },
  };
}
