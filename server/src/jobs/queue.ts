/**
 * pg-boss wrapper. Postgres-backed: jobs survive restarts, singleton keys make
 * scheduling idempotent (re-scheduling the same reopen twice is a no-op).
 */
import { PgBoss } from 'pg-boss';
import { config } from '../config.js';

export const QUEUES = {
  reopen: 'recurrence-reopen',
  overdueCheck: 'recurrence-overdue-check',
  dueDateScan: 'due-date-scan',
} as const;

export async function createBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => console.error('pg-boss error', err));
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q);
  return boss;
}

/** Schedule the card's automatic reopen. Idempotent per (card, reopenAt). */
export async function scheduleReopen(boss: PgBoss, cardId: string, reopenAt: Date): Promise<void> {
  await boss.send(
    QUEUES.reopen,
    { cardId, reopenAt: reopenAt.toISOString() },
    {
      startAfter: reopenAt,
      singletonKey: `reopen:${cardId}:${reopenAt.toISOString()}`,
      retryLimit: 5,
      retryBackoff: true,
    },
  );
}

/** Schedule the overdue flag check for a reopened card. */
export async function scheduleOverdueCheck(boss: PgBoss, cardId: string, overdueAt: Date): Promise<void> {
  await boss.send(
    QUEUES.overdueCheck,
    { cardId, overdueAt: overdueAt.toISOString() },
    {
      startAfter: overdueAt,
      singletonKey: `overdue:${cardId}:${overdueAt.toISOString()}`,
      retryLimit: 5,
      retryBackoff: true,
    },
  );
}
