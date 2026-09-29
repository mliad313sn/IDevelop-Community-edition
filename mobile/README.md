# IDevelop Community Edition — mobile packaging (Capacitor 6)

Lightweight wrapper around the installable web app (PWA). The same EJS UI runs inside the
WebView; Capacitor adds native plugins where the web platform is short
(camera, secure storage, push later).

## Quick start (developer machine)

```bash
cd mobile/
npm install
npx cap init "$APP_NAME" "$APP_ID" --web-dir=../public   # values come from capacitor.config.ts
npx cap add android
npx cap add ios
npx cap sync
```

## Build pipelines (CI)

A mobile CI workflow is not included yet. Build locally with the steps above,
and sign with your own keys under your own `APP_ID` namespace.

## What ships in the WebView

- `public/manifest.webmanifest`
- `public/service-worker.js` (offline shell)
- `public/css/design-system/{tokens,components}.css`
- `public/js/{draft-store,sync-indicator}.js`

Server endpoints used by the WebView are the same as the desktop app,
gated by the same RBAC + scope rules; the mobile binary does not bundle
its own auth.

## Open

- [ ] Bundle a server URL whitelist (production / staging) into
      `capacitor.config.ts`.
- [ ] Add `@capacitor/secure-storage` for the session cookie under
      Android's `KeyStore` and iOS Keychain.
- [ ] Sign Android with your organisation's keystore.
- [ ] iOS provisioning with your Apple Developer team ID.
