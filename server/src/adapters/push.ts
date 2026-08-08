import { readFileSync } from 'node:fs';
import { config } from '../config.js';

export interface PushSender {
  send(tokens: string[], title: string, body: string, data?: Record<string, string>): Promise<void>;
  enabled: boolean;
}

export async function createFcmPush(): Promise<PushSender> {
  if (!config.fcm.enabled) {
    return { enabled: false, send: async () => {} };
  }
  // firebase-admin v14 dropped the `admin.credential` / `admin.messaging()`
  // namespace off the root export in favour of the modular subpath API.
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const creds = JSON.parse(readFileSync(config.fcm.credentialsFile, 'utf-8'));
  const app = initializeApp({ credential: cert(creds) });
  return {
    enabled: true,
    async send(tokens, title, body, data) {
      if (tokens.length === 0) return;
      await getMessaging(app).sendEachForMulticast({
        tokens,
        notification: { title, body },
        data,
      });
    },
  };
}
