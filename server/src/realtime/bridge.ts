/**
 * Worker processes have no Socket.IO server. They publish realtime events via
 * Postgres NOTIFY; the API process LISTENs and relays into board/user rooms.
 */
import pg from 'pg';
import type { BoardEvent } from '@kan-do/shared';
import type { Realtime } from './gateway.js';
import { config } from '../config.js';

const CHANNEL = 'kando_rt';

type Payload =
  | { kind: 'board'; boardId: string; event: BoardEvent }
  | { kind: 'user'; userId: string };

/** Realtime impl used inside workers: publish instead of emit. */
export function createNotifyRealtime(pool: pg.Pool): Realtime {
  const publish = (payload: Payload) => {
    void pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(payload)]).catch((err) => {
      console.error('pg_notify failed', err);
    });
  };
  return {
    emitToBoard: (boardId, event) => publish({ kind: 'board', boardId, event }),
    emitToUser: (userId) => publish({ kind: 'user', userId }),
  };
}

/** Runs in the API process: relay NOTIFY payloads to connected sockets. */
export async function startRealtimeRelay(realtime: Realtime): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  client.on('notification', (msg) => {
    if (!msg.payload) return;
    try {
      const p = JSON.parse(msg.payload) as Payload;
      if (p.kind === 'board') realtime.emitToBoard(p.boardId, p.event);
      else realtime.emitToUser(p.userId, { type: 'notification' });
    } catch (err) {
      console.error('bad realtime payload', err);
    }
  });
  client.on('error', (err) => console.error('realtime relay connection error', err));
}
