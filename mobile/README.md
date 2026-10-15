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

## Security gate (read before the first native build)

`capacitor.config.ts` takes every security-relevant value from
`scripts/check-server-url.js`, which **fails the build** when a rule is broken.
Run it on its own at any time:

```bash
SERVER_URL=https://app.example.com node mobile/scripts/check-server-url.js
```

| Rule                                          | Release build (default)                            | Development build (`MOBILE_BUILD=dev`)                    |
| --------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `SERVER_URL`                                  | `https://` only; no credentials, query or fragment | `https://`, or `http://localhost` / `127.0.0.1` / `[::1]` |
| Cleartext traffic                             | off                                                | on only for `http://localhost`                            |
| Mixed content (Android)                       | off                                                | off                                                       |
| Navigation inside the WebView                 | the configured host only                           | the configured host only                                  |
| WebView debugging (Chrome / Safari inspector) | off                                                | on                                                        |
| Capacitor logging                             | none                                               | debug                                                     |

A build is a **release** build unless `MOBILE_BUILD=dev` is set explicitly.

After `npx cap add android|ios`, the gate also reads the generated files and
refuses the build when:

- `android/app/src/main/AndroidManifest.xml` lacks `android:allowBackup="false"`
  on `<application>` (session cookies and WebView storage must not reach device
  or cloud backups), sets `android:usesCleartextTraffic="true"`, or sets
  `android:debuggable="true"` in a release build;
- `ios/App/App/Info.plist` sets `NSAllowsArbitraryLoads` to true (App Transport
  Security must stay on).

iOS has no manifest switch for backups: when native code is added, exclude the
WebView data and any file the app writes from backups
(`NSURLIsExcludedFromBackupKey`), and keep secrets in the Keychain with
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.

**Single sign-on** must not run inside the WebView. Because navigation is
limited to the configured host, the identity provider opens in the system
browser. A complete native flow (`ASWebAuthenticationSession` / Custom Tabs, a
verified App Link back to the app and a single-use code exchanged for the
session) is still to be built, with the native plugin.

**Certificate pinning** is off (`PINNING` in the gate) until native code exists
to enforce it. When it does: pin the SHA-256 of the SubjectPublicKeyInfo of the
issuing CA (or of the leaf plus a backup key) per deployment, ship two pins so a
renewal never locks people out, and never pin a development build.

## Open

- [x] Server address rules (https only, navigation limited to the host): the
      security gate above.
- [ ] Certificate pinning (see above).
- [ ] Sign-in code exchange for the system-browser flow (see above).
- [ ] Add `@capacitor/secure-storage` for the session cookie under
      Android's `KeyStore` and iOS Keychain.
- [ ] Sign Android with your organisation's keystore.
- [ ] iOS provisioning with your Apple Developer team ID.
