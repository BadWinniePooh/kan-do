/** API server entry point. Workers run separately (worker.ts). */
import bcrypt from 'bcryptjs';
import { buildApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/index.js';
import { createS3Storage } from './adapters/storage.js';
import { createSmtpMailer } from './adapters/mailer.js';
import { createFcmPush } from './adapters/push.js';
import { createBoss } from './jobs/queue.js';
import { createRealtime } from './realtime/gateway.js';
import { startRealtimeRelay } from './realtime/bridge.js';
import type { AppCtx } from './services/context.js';

async function bootstrapAdmin(ctx: AppCtx): Promise<void> {
  const any = await ctx.db.selectFrom('users').select('id').limit(1).executeTakeFirst();
  if (any) return;
  await ctx.db
    .insertInto('users')
    .values({
      org_id: null,
      email: config.bootstrap.adminEmail.toLowerCase(),
      display_name: 'Global Admin',
      role: 'global_admin',
      password_hash: await bcrypt.hash(config.bootstrap.adminPassword, 10),
    })
    .execute();
  console.log(`Bootstrapped global admin: ${config.bootstrap.adminEmail}`);
}

async function main(): Promise<void> {
  const db = createDb();
  const storage = createS3Storage();
  await storage.ensureBucket();
  const boss = await createBoss();

  const ctx: AppCtx = {
    db,
    boss,
    storage,
    mailer: createSmtpMailer(),
    push: await createFcmPush(),
    realtime: { emitToBoard: () => {}, emitToUser: () => {} }, // replaced below
  };

  const app = await buildApp(ctx);
  await app.ready();
  ctx.realtime = createRealtime(app.server, db);
  await startRealtimeRelay(ctx.realtime);

  await bootstrapAdmin(ctx);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
