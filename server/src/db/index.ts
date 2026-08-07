import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';
import { config } from '../config.js';

export function createDb(connectionString = config.databaseUrl): Kysely<DB> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export type Db = Kysely<DB>;
export type { DB } from './types.js';
