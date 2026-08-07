/**
 * Notification fan-out. Recipients: the card's registered-user owners, or all
 * board members when the card has no user owners. Channels (in-app / email /
 * push) honor each user's per-channel settings. The notification_ledger keyed
 * dedupe guarantees an event notifies at most once even if a job retries.
 */
import type { NotificationEvent } from '@kan-do/shared';
import type { AppCtx } from './context.js';

async function recipients(ctx: AppCtx, cardId: string, boardId: string): Promise<string[]> {
  const owners = await ctx.db
    .selectFrom('card_owners')
    .select('user_id')
    .where('card_id', '=', cardId)
    .where('kind', '=', 'user')
    .execute();
  const ownerIds = owners.map((o) => o.user_id!).filter(Boolean);
  if (ownerIds.length) return ownerIds;
  const members = await ctx.db.selectFrom('board_members').select('user_id').where('board_id', '=', boardId).execute();
  return members.map((m) => m.user_id);
}

async function channelEnabled(ctx: AppCtx, userId: string, event: NotificationEvent, channel: 'inapp' | 'email' | 'push'): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('notification_settings')
    .select('enabled')
    .where('user_id', '=', userId)
    .where('event', '=', event)
    .where('channel', '=', channel)
    .executeTakeFirst();
  return row?.enabled ?? true; // default: all channels on
}

export async function notifyCardEvent(
  ctx: AppCtx,
  event: NotificationEvent,
  cardId: string,
  dedupeKey: string,
): Promise<void> {
  // at-most-once: first worker to insert the key wins, retries no-op
  const inserted = await ctx.db
    .insertInto('notification_ledger')
    .values({ dedupe_key: dedupeKey })
    .onConflict((oc) => oc.doNothing())
    .returning('dedupe_key')
    .executeTakeFirst();
  if (!inserted) return;

  const card = await ctx.db.selectFrom('cards').select(['id', 'title', 'board_id']).where('id', '=', cardId).executeTakeFirst();
  if (!card) return;

  const title = event === 'reopen' ? 'Task reopened' : 'Task overdue';
  const body =
    event === 'reopen'
      ? `Recurring task "${card.title}" is open again.`
      : `Task "${card.title}" is overdue.`;

  for (const userId of await recipients(ctx, cardId, card.board_id)) {
    if (await channelEnabled(ctx, userId, event, 'inapp')) {
      await ctx.db
        .insertInto('notifications')
        .values({ user_id: userId, event, card_id: cardId, title, body })
        .execute();
      ctx.realtime.emitToUser(userId, { type: 'notification' });
    }
    if (ctx.mailer.enabled && (await channelEnabled(ctx, userId, event, 'email'))) {
      const user = await ctx.db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst();
      if (user) await ctx.mailer.send(user.email, `[Kan-Do] ${title}`, body);
    }
    if (ctx.push.enabled && (await channelEnabled(ctx, userId, event, 'push'))) {
      const tokens = await ctx.db.selectFrom('push_tokens').select('token').where('user_id', '=', userId).execute();
      await ctx.push.send(tokens.map((t) => t.token), title, body, { cardId, boardId: card.board_id });
    }
  }
}
