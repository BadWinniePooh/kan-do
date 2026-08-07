/**
 * Worker entry point: recurrence reopen, overdue checks, due-date scans and
 * notification fan-out. Safe to run multiple instances — pg-boss leases jobs,
 * singleton keys stop duplicate scheduling, and the notification ledger stops
 * double sends.
 */
import pg from 'pg';
import pino from 'pino';
import { createDb } from './db/index.js';
import { config } from './config.js';
import { createS3Storage } from './adapters/storage.js';
import { createSmtpMailer } from './adapters/mailer.js';
import { createFcmPush } from './adapters/push.js';
import { createBoss, QUEUES, scheduleReopen } from './jobs/queue.js';
import { createNotifyRealtime } from './realtime/bridge.js';
import type { AppCtx } from './services/context.js';
import { moveCard } from './services/cards.js';
import { openColumnOfLane } from './services/boards.js';
import { notifyCardEvent } from './services/notify.js';
import * as rec from './domain/recurrence.js';

const log = pino({ level: config.env === 'production' ? 'info' : 'debug' });

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  const db = createDb();
  const boss = await createBoss();
  const ctx: AppCtx = {
    db,
    boss,
    storage: createS3Storage(),
    mailer: createSmtpMailer(),
    push: await createFcmPush(),
    realtime: createNotifyRealtime(pool),
  };

  /** Reopen a recurring card: move it back to the board's open column. */
  await boss.work<{ cardId: string; reopenAt: string }>(QUEUES.reopen, async ([job]) => {
    const { cardId, reopenAt } = job.data;
    const card = await db.selectFrom('cards').selectAll().where('id', '=', cardId).executeTakeFirst();
    if (!card || !card.recurrence_rule) return; // deleted or recurrence removed
    const state = {
      status: card.recurrence_status,
      closedAt: card.closed_at,
      reopenAt: card.reopen_at,
      reopenedAt: card.reopened_at,
      overdueAt: card.overdue_at,
    };
    if (!rec.reopenIsDue(state, new Date())) {
      log.info({ cardId }, 'reopen no longer due (card state changed) — skipping');
      return;
    }
    // columns are lane-scoped: reopen into the card's OWN lane's open column
    const openColumnId = await openColumnOfLane(db, card.lane_id);
    if (!openColumnId) {
      log.error({ cardId, laneId: card.lane_id }, 'lane has no open column');
      return;
    }
    // actor null = system move; moveCard runs the onReopened branch,
    // arms the overdue deadline and schedules the overdue check
    await moveCard(ctx, null, cardId, openColumnId);
    await notifyCardEvent(ctx, 'reopen', cardId, `reopen:${cardId}:${reopenAt}`);
    log.info({ cardId }, 'recurring card reopened');
  });

  /** Flag a reopened card overdue if it was not closed in time. */
  await boss.work<{ cardId: string; overdueAt: string }>(QUEUES.overdueCheck, async ([job]) => {
    const { cardId, overdueAt } = job.data;
    const card = await db.selectFrom('cards').selectAll().where('id', '=', cardId).executeTakeFirst();
    if (!card || !card.recurrence_rule) return;
    // stale job? card was closed and reopened again since — a newer check exists
    if (card.overdue_at?.toISOString() !== overdueAt) return;
    const next = rec.onOverdueCheck(
      {
        status: card.recurrence_status,
        closedAt: card.closed_at,
        reopenAt: card.reopen_at,
        reopenedAt: card.reopened_at,
        overdueAt: card.overdue_at,
      },
      new Date(),
    );
    if (next.status !== 'overdue') return;
    await db
      .updateTable('cards')
      .set({ recurrence_status: 'overdue', is_overdue: true, updated_at: new Date() })
      .where('id', '=', cardId)
      .execute();
    ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId });
    await notifyCardEvent(ctx, 'overdue', cardId, `overdue:${cardId}:${overdueAt}`);
    log.info({ cardId }, 'card flagged overdue');
  });

  /** Cron: flag non-recurring cards past their due date. */
  await boss.schedule(QUEUES.dueDateScan, '*/5 * * * *');
  await boss.work(QUEUES.dueDateScan, async () => {
    const now = new Date();
    const due = await db
      .selectFrom('cards')
      .innerJoin('board_columns', 'board_columns.id', 'cards.column_id')
      .select(['cards.id', 'cards.board_id', 'cards.due_date'])
      .where('cards.due_date', 'is not', null)
      .where('cards.due_date', '<', now)
      .where('cards.is_overdue', '=', false)
      .where('cards.recurrence_rule', 'is', null)
      // a card that is finished — successfully (done) or reverted (discard) —
      // is not late; only live work can go overdue
      .where((eb) => eb.or([eb('board_columns.semantic', 'is', null), eb('board_columns.semantic', 'not in', ['done', 'discard'])]))
      .execute();
    for (const card of due) {
      await db.updateTable('cards').set({ is_overdue: true, updated_at: now }).where('id', '=', card.id).execute();
      ctx.realtime.emitToBoard(card.board_id, { type: 'card.updated', cardId: card.id });
      await notifyCardEvent(ctx, 'overdue', card.id, `due:${card.id}:${card.due_date!.toISOString()}`);
    }
    if (due.length) log.info({ count: due.length }, 'due-date overdue flags set');
  });

  /**
   * Recovery sweep on startup: reschedule any awaiting_reopen/reopened cards
   * whose jobs might have been lost (e.g. DB restored from backup). Singleton
   * keys make this idempotent against still-queued jobs.
   */
  const pendingReopens = await db
    .selectFrom('cards')
    .select(['id', 'reopen_at'])
    .where('recurrence_status', '=', 'awaiting_reopen')
    .where('reopen_at', 'is not', null)
    .execute();
  for (const c of pendingReopens) await scheduleReopen(boss, c.id, c.reopen_at!);
  log.info({ rescheduled: pendingReopens.length }, 'worker started');
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
