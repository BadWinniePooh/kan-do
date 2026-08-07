/** Org switcher specs: same-email accounts across orgs, tenancy guarded. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../app.js';
import { createDb } from '../db/index.js';
import type { AppCtx } from '../services/context.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const email = `switcher-${RUN}@test.io`;
const strangerEmail = `stranger-${RUN}@test.io`;

describe.skipIf(!hasDb)('org switching', () => {
  let app: FastifyInstance;
  let ctx: AppCtx;
  let orgA: string;
  let orgB: string;
  let orgC: string; // no account for `email` here
  let cookie: string;

  beforeAll(async () => {
    const db = createDb();
    ctx = {
      db,
      boss: { send: async () => 'job' } as never,
      storage: {
        presignUpload: async () => 'http://stub',
        presignDownload: async () => 'http://stub',
        delete: async () => {},
        healthy: async () => true,
        ensureBucket: async () => {},
      },
      mailer: { enabled: false, send: async () => {} },
      push: { enabled: false, send: async () => {} },
      realtime: { emitToBoard: () => {}, emitToUser: () => {} },
    };
    app = await buildApp(ctx);
    const hash = await bcrypt.hash('pass12345', 4);
    const mk = async (slug: string) =>
      (await db.insertInto('organizations').values({ name: slug, slug }).returning('id').executeTakeFirstOrThrow()).id;
    orgA = await mk(`sw-a-${RUN}`);
    orgB = await mk(`sw-b-${RUN}`);
    orgC = await mk(`sw-c-${RUN}`);
    await db
      .insertInto('users')
      .values([
        { org_id: orgA, email, display_name: 'Switcher A', role: 'user', password_hash: hash },
        { org_id: orgB, email, display_name: 'Switcher B', role: 'user', password_hash: hash },
        { org_id: orgC, email: strangerEmail, display_name: 'Stranger', role: 'user', password_hash: hash },
      ])
      .execute();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'pass12345', orgSlug: `sw-a-${RUN}` } });
    cookie = res.headers['set-cookie']!.toString().split(';')[0]!;
  });

  afterAll(async () => {
    await ctx.db.deleteFrom('organizations').where('id', 'in', [orgA, orgB, orgC]).execute();
    await app.close();
    await ctx.db.destroy();
  });

  it('my-orgs lists exactly the orgs sharing my email', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/my-orgs', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const slugs = res.json().map((o: { slug: string }) => o.slug).sort();
    expect(slugs).toEqual([`sw-a-${RUN}`, `sw-b-${RUN}`]);
  });

  it('switching swaps the session to the other org account', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: { cookie }, payload: { orgId: orgB } });
    expect(res.statusCode).toBe(200);
    const newCookie = res.headers['set-cookie']!.toString().split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: newCookie } });
    expect(me.json().orgId).toBe(orgB);
    expect(me.json().displayName).toBe('Switcher B');
  });

  it('TENANCY: cannot switch into an org without an account there', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: { cookie }, payload: { orgId: orgC } });
    expect(res.statusCode).toBe(403);
  });
});
