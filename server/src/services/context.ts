import type PgBoss from 'pg-boss';
import type { Db } from '../db/index.js';
import type { ObjectStorage } from '../adapters/storage.js';
import type { Mailer } from '../adapters/mailer.js';
import type { PushSender } from '../adapters/push.js';
import type { Realtime } from '../realtime/gateway.js';

/** Dependency container handed to services; tests substitute stubs. */
export interface AppCtx {
  db: Db;
  boss: PgBoss;
  storage: ObjectStorage;
  mailer: Mailer;
  push: PushSender;
  realtime: Realtime;
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new HttpError(404, `${what} not found`);
export const forbidden = () => new HttpError(403, 'forbidden');
export const badRequest = (msg: string) => new HttpError(400, msg);
