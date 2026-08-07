/**
 * All runtime configuration comes from environment variables — one place to
 * change per environment, nothing hardcoded. See README for the full list.
 */
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  publicUrl: req('PUBLIC_URL', 'http://localhost:3001'),
  webOrigin: req('WEB_ORIGIN', 'http://localhost:5173'),

  databaseUrl: req('DATABASE_URL', 'postgres://kando:kando@localhost:5432/kando'),

  sessionSecret: req('SESSION_SECRET', 'dev-secret-change-me'),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 72),

  s3: {
    endpoint: req('S3_ENDPOINT', 'http://localhost:9000'),
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: req('S3_BUCKET', 'kando'),
    accessKeyId: req('S3_ACCESS_KEY', 'minioadmin'),
    secretAccessKey: req('S3_SECRET_KEY', 'minioadmin'),
    /** endpoint reachable from the user's browser (differs in docker) */
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? req('S3_ENDPOINT', 'http://localhost:9000'),
  },

  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'kan-do@example.com',
    enabled: Boolean(process.env.SMTP_HOST),
  },

  fcm: {
    /** path to a Firebase service-account JSON; empty disables push */
    credentialsFile: process.env.FCM_CREDENTIALS_FILE ?? '',
    enabled: Boolean(process.env.FCM_CREDENTIALS_FILE),
  },

  bootstrap: {
    /** first global admin, created on startup if no users exist */
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com',
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'admin1234',
  },
};
