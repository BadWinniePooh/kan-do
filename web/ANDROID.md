# Kan-Do Android app

The Android app is a Capacitor wrapper around the web build — one codebase,
consistent terminology and hierarchy across web and mobile. It is online-only
(no offline cache), matching the spec.

## Build steps

```bash
cd web
pnpm install
pnpm build                       # produces dist/
export KANDO_APP_URL=https://your-kando-host   # the deployed web+API origin
npx cap add android              # first time only: generates android/ project
npx cap sync android             # copy config + plugins
npx cap open android             # opens Android Studio; build APK/AAB there
```

CLI release build: `cd android && ./gradlew assembleRelease`.

## Push notifications (FCM)

1. Create a Firebase project, add an Android app with package id
   `cloud.rueber.kando`, download `google-services.json` into `android/app/`.
2. Generate a service-account JSON (Project settings → Service accounts) and
   mount it into the server/worker containers; set `FCM_CREDENTIALS_FILE` to
   its path (see root README).
3. The web code registers the device token on app start (`src/push.ts`) and
   sends it to `POST /api/me/push-tokens`; the notification worker fans out
   overdue/reopen events to registered tokens, honoring the user's per-channel
   settings.

## Notes

- `server.url` makes the app load the deployed site, so web releases update
  the app content without a store release.
- Session auth uses the same cookies; the Capacitor webview persists them.
