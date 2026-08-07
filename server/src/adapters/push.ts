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
  const admin = await import('firebase-admin');
  const creds = JSON.parse(readFileSync(config.fcm.credentialsFile, 'utf-8'));
  const app = admin.default.initializeApp({ credential: admin.default.credential.cert(creds) });
  return {
    enabled: true,
    async send(tokens, title, body, data) {
      if (tokens.length === 0) return;
      await admin.default.messaging(app).sendEachForMulticast({
        tokens,
        notification: { title, body },
        data,
      });
    },
  };
}
