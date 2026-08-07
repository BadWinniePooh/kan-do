/** Android push registration (no-op on plain web). */
import { Capacitor } from '@capacitor/core';
import { post } from './api';

export async function initPush(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return;
  PushNotifications.addListener('registration', (token) => {
    void post('/api/me/push-tokens', { token: token.value, platform: 'android' }).catch(() => {});
  });
  await PushNotifications.register();
}
