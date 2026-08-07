import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android app = Capacitor shell around the same web build (online-only per
 * spec). Point server.url at your deployed Kan-Do instance so the app loads
 * the live web UI and talks to the same API/WebSocket.
 */
const config: CapacitorConfig = {
  appId: 'cloud.rueber.kando',
  appName: 'Kan-Do',
  webDir: 'dist',
  server: {
    url: process.env.KANDO_APP_URL ?? 'https://kando.example.com',
    cleartext: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
