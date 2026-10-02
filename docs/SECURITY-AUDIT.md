# Security audit — IDevelop Community Edition

- **Date:** 2026-09-29
- **Codebase:** branch `claude/friendly-hawking-9iv6qf` at `e00b25a`, audited and fixed on a worktree branch
- **Auditor:** internal white-box review (source code, configuration, dependencies, container files). This was **not** an external penetration test.

## Scope

Server (`server.js`, `src/**`), views (`views/**`, including the inline scripts), browser code (`public/js/**`), SQL migrations where relevant, `Dockerfile`, `docker-compose.yml`, `package.json` / `package-lock.json`, and a read of the Windows installer defaults.

The review covered these areas:

1. injection (SQL, command/path, template, stored and reflected XSS);
2. authentication (sessions, passwords, lockout, MFA, password reset, SSO, SCIM and API keys);
3. authorisation (IDOR on `:id` routes, employee self-service, the routes added in this release);
4. CSRF;
5. headers and transport;
6. SSRF;
7. files (uploads, downloads, formula injection, zip bombs);
8. secrets and cryptography;
9. denial of service;
10. dependencies;
11. container and installer defaults.

Out of scope: the `mobile/` client, the infrastructure the product is deployed on, and dynamic testing against a running instance beyond the Jest suite.

## Methodology

- **Route inventory.** Every `router.(get|post|put|patch|delete)` and every mounted router was listed, the guard in front of each was checked, and the routes reachable without a session were listed (see "Unauthenticated surface").
- **Pattern search, then manual reading.** We searched for:
    - string-built SQL (`${…}` inside `db.*` calls, `ORDER BY ${…}`);
    - raw EJS output (`<%-`) and `innerHTML` / `insertAdjacentHTML`;
    - `child_process`, `Math.random`, outbound HTTP (`fetch`, `http(s).request`);
    - `sendFile` / `download`, `multer`, and `xlsx.readFile/load`;
    - role checks (`role === 'superadmin'`) and Referer-based redirects.

    Each hit was read in context and classified as a vulnerability, a hardening gap or a false positive.

- **Recent changes.** The feature commits in this release (`b2d1dcc`, `538f60d`, `f5310b5`, `22ac6ee`, `6455b02`) were reviewed diff by diff: `/employee/my-data`, `/compliance/register`, `/api/self-assessment/team/approve-all`, recognition, growth panels, and Slack/Teams webhooks.
- **Dependencies.** We ran `npm audit` and `npm audit --omit=dev`, read the advisories, and read the upstream changelog before any major upgrade.
- **Regression tests.** Every fix has a Jest test in `tests/unit/securityAudit20260929.test.js`: one `describe` block per finding id. The full suite ran against a freshly migrated and seeded PostgreSQL database.

Severity is qualitative in the CVSS style (Critical / High / Medium / Low / Info). It weighs the privileges an attacker needs, the reach of the impact, and the existing mitigations.

## Findings

| ID    | Severity | Area                     | Location                                                                                                                                                     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SA-00 | High     | Configuration / AuthZ    | `src/models/AppSettingsModel.js` (`setValue`)                                                                                                                | **Boolean settings seeded ON.** `value ? 'true' : 'false'` turned the string defaults `'false'`/`'0'` into `'true'`. On a fresh install this switched on `onboarding.allowOpenSignup`, `allowSignup`, `enabled`, `allowSso`, `copilot.allow_named_person_ranking`, `enableEmailNotifications` and `copilotAnonymizeSkills`.                                                                                                                                                            | **Fixed in the main branch by the orchestrator** (`setValue` fix plus migration `159_boolean_settings_repair.sql`). This branch does not touch that code, and the fix was not re-verified here.                                                                                                                                                                                                                                                                                                                                                                                             |
| SA-01 | Medium   | Crypto                   | `src/utils/credentialGenerator.js:22`                                                                                                                        | Temporary passwords for bulk-imported and onboarded accounts were drawn with `Math.random` (xorshift128+). Its output is predictable from a few observed values, so one known temporary password could expose the others issued by the same process.                                                                                                                                                                                                                                   | Fixed: `crypto.randomInt` for every draw and for the shuffle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SA-02 | Medium   | Stored XSS               | `views/pages/employees/show.ejs:223`                                                                                                                         | The "linked admin account" sentence is printed with `<%-` (it carries markup), and i18next runs with `escapeValue:false`. An admin **username** containing HTML therefore rendered as live markup on the SuperAdmin's employee page. `script-src-attr 'unsafe-inline'` lets `onerror=` run. An admin holding `manage_admins` could plant a payload that runs in a SuperAdmin session.                                                                                                  | Fixed: every interpolated value is HTML-escaped before it enters the raw sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SA-03 | Low      | XSS (script context)     | `views/pages/admin/access-review.ejs:209`                                                                                                                    | The reviewer's username was embedded with `JSON.stringify` inside a `<script>`. `</script>` in a username closed the element.                                                                                                                                                                                                                                                                                                                                                          | Fixed: uses `partials/json-script` (escapes `<`, U+2028, U+2029).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SA-04 | Medium   | SSRF                     | `src/services/WebhookService.js:40-110`                                                                                                                      | The webhook URL guard was string-prefix based. It could be bypassed with an IPv4-mapped IPv6 literal (`[::ffff:127.0.0.1]` serialises to `[::ffff:7f00:1]`), CGNAT or `0/8` addresses, **any DNS name that resolves privately**, or a public receiver answering `302` to `169.254.169.254`, because `fetch` follows redirects. The response status is stored and shown to the SuperAdmin, which makes the webhook a port-scan oracle. This applies to the new Slack/Teams formats too. | Fixed: IP literals go through the shared `isPrivateAddress` classifier. Names are resolved and **every** answer is checked. The connection is pinned to the checked address, which defeats DNS rebinding. Redirects are never followed. Credentials in the URL are refused. `WEBHOOK_ALLOW_PRIVATE=1` is an explicit opt-in for LAN receivers.                                                                                                                                                                                                                                              |
| SA-05 | Low      | SSRF                     | `src/services/LmsService.js:103`                                                                                                                             | The LMS base-URL guard, which blocks loopback and metadata while allowing the LAN, missed the IPv4-mapped IPv6 spellings (`[::ffff:169.254.169.254]`) and `0.0.0.0/8`. Exploiting it requires `configure_lms`.                                                                                                                                                                                                                                                                         | Fixed: `net.BlockList` check that judges mapped addresses by their IPv4 rules. DNS names are **not** resolved (see residual risks).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SA-06 | Low      | SSRF / credential leak   | `src/integrations/lms/CornerstoneConnector.js:136`                                                                                                           | OData pagination followed an absolute `@odata.nextLink` taken from the LMS response to **any origin**, and sent the LMS bearer token with it. A malicious or compromised LMS endpoint could steal the token or steer the sync worker to internal hosts.                                                                                                                                                                                                                                | Fixed: next links are followed only when they have the configured base URL's origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SA-07 | Low      | DOM XSS                  | `views/pages/compliance/index.ejs:474`                                                                                                                       | Certification-import error texts quote uploaded cells (`Unknown skill "…"`) and were joined into `innerHTML`. A crafted workbook ran script in the importing admin's session.                                                                                                                                                                                                                                                                                                          | Fixed: escaped before insertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SA-08 | Info     | Open redirect            | `src/utils/safeRedirect.js:31`, `src/controllers/NotificationAdminController.js:134`                                                                         | `safeBackUrl` returned a same-host Referer path such as `//evil.example/x`, which is a protocol-relative redirect. The notification-retry handler echoed any Referer that merely _contained_ `/admin/notifications`. Practical impact is minimal because helmet sends `Referrer-Policy: no-referrer`, so the app's own pages send no Referer.                                                                                                                                          | Fixed: only single-slash relative paths are accepted, and the retry handler uses `safeBackUrl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SA-09 | Medium   | DoS (zip bomb)           | `src/utils/importGuards.js:73`; all 11 ExcelJS read sites                                                                                                    | An `.xlsx` is a ZIP. The 10 MB upload cap bounds the compressed size only. ExcelJS inflates the whole archive in memory, so one crafted upload by any holder of an import permission (`import_data`, `manage_compliance`, `manage_domains_skills`…) could exhaust the heap and stop the appliance.                                                                                                                                                                                     | Fixed: before ExcelJS sees an uploaded workbook, every entry is actually inflated with a hard cap (`zlib maxOutputLength`), so lying header sizes do not help. Limits: 200 MB total, 5 000 entries, ZIP64 refused. Tunable with `XLSX_MAX_UNCOMPRESSED_BYTES` and `XLSX_MAX_ENTRIES`.                                                                                                                                                                                                                                                                                                       |
| SA-10 | Medium   | Container / secrets      | `Dockerfile:19` (`COPY . .`), no `.dockerignore`                                                                                                             | The build context was copied whole. The operator's `.env` holds `SESSION_SECRET`, `APP_KEY` and the DB password (the compose instructions put it in the build directory). TLS keys under `certs/`, uploads, backups and `.git` were all baked into image layers. The host's `node_modules` also overwrote the Alpine-built ones.                                                                                                                                                       | Fixed: `.dockerignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SA-11 | Low      | DoS                      | `src/controllers/DashboardController.js:366`                                                                                                                 | `GET /api/dashboard/employees?pageSize=` was unbounded, and a negative `page` produced a negative `OFFSET` (a 500).                                                                                                                                                                                                                                                                                                                                                                    | Fixed: `pageSize` is clamped to 1–200 and `page` to at least 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SA-12 | Info     | AuthZ (defence in depth) | `src/middleware/rbac.js:188`, `src/routes/v2-capability.js:841`, `src/controllers/SqlConsoleController.js:38`, `src/controllers/SsoSettingsController.js:56` | These SuperAdmin gates tested `role === 'superadmin'` without `userType === 'admin'`. It is **not exploitable today**, because employee principals carry no `role` field. However, `rbacMiddleware` would have granted unrestricted scope to any principal carrying that field.                                                                                                                                                                                                        | Fixed: `RBACService.isSuperAdmin` / `userType` check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SA-13 | Medium   | Dependencies             | `package.json`                                                                                                                                               | See the `npm audit` section below: nodemailer (runtime, moderate), form-data (dev, high), multer 1.x (deprecated upstream as vulnerable).                                                                                                                                                                                                                                                                                                                                              | Fixed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SA-14 | Medium   | XSS mitigation           | `server.js` (helmet CSP), `public/js/csp-actions.js`                                                                                                         | The CSP allowed `script-src-attr 'unsafe-inline'` because inline `onclick=` handlers were used throughout the views. The script-src nonce blocked injected `<script>`, but **any** HTML injection with an event-handler attribute still executed. SA-02 and SA-07 were exploitable because of this.                                                                                                                                                                                    | Fixed: the 361 inline handlers (54 files: views, page scripts, the report builder and dashboard scripts, the offline page and the LTI launch) became `data-on-<event>` attributes with JSON `data-args`, dispatched by delegated listeners in `public/js/csp-actions.js`; the CSP now sends `script-src-attr 'none'`. `tests/unit/noInlineHandlers.test.js` fails on any `on<event>=` attribute or `javascript:` URL in views, static pages, browser scripts and server-built HTML, and pins the directive. Verified in Chromium with no CSP violation.                                     |
| SA-15 | Low      | CSRF                     | `server.js:604-625`                                                                                                                                          | The synchroniser-token check is skipped for `/api/*`, JSON bodies and the multipart upload routes (multer parses after the CSRF middleware). These rely on the same-origin guard (`server.js:501-586`: Origin must match Host, and a JSON mutation without Origin needs a validated API credential) plus `SameSite=Lax` session cookies. No bypass was found: a cross-site form POST carries a mismatching Origin, and Lax withholds the cookie.                                       | **Accepted**: defence-in-depth gap only. Recommendation: verify `_csrf` after multer on upload routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SA-16 | Low      | Container                | `Dockerfile:21`                                                                                                                                              | The container runs as the non-root user `app`, but `chown -R app:app /app` makes the application code writable by the process.                                                                                                                                                                                                                                                                                                                                                         | **Accepted**: the runtime writes to several app-relative directories (uploads, tmp, logs, backups, `AI_Engine_Docs/tmp`). Recommendation: code owned by root, only those directories writable or mounted as volumes.                                                                                                                                                                                                                                                                                                                                                                        |
| SA-17 | Low      | SSRF (by design)         | `src/services/CopilotService.js:372-400`                                                                                                                     | The copilot LLM URL is always http(s) and never follows redirects. Private-address blocking is **opt-in** (`COPILOT_BLOCK_PRIVATE_HOSTS=1`) because the primary deployment uses an on-prem LLM, and there is no DNS pinning. Only a SuperAdmin can configure it.                                                                                                                                                                                                                       | Fixed: a private, loopback or link-local copilot target is refused unless a SuperAdmin allow-lists it (`copilotAllowedPrivateHosts`, or `copilotTrustedHosts`); the connection is pinned to the checked address, redirects are refused, an API key never travels over http; an external provider needs a recorded transfer basis and processor-agreement acknowledgement (`copilotEgressGate.test.js`). The opt-in `COPILOT_BLOCK_PRIVATE_HOSTS` is gone.                                                                                                                                   |
| SA-18 | Low      | Crypto                   | `src/utils/secretBox.js:15-19`                                                                                                                               | AES-256-GCM with a random 96-bit IV and a pinned 16-byte tag (verified). The key is `SHA-256(APP_KEY)`, falling back to `SESSION_SECRET`, which means key reuse with cookie signing, and to **cleartext storage** when neither is set (dev only; production refuses a missing or weak `SESSION_SECRET`, `src/config/app.js:13-35`). A weak `APP_KEY` is only a boot warning.                                                                                                           | Fixed: secretBox v2 (`enc:v2:<purpose>:…`, HKDF-SHA256 over `APP_KEY`, purpose bound as AAD); production never uses `SESSION_SECRET` as an encryption key and refuses to start without a strong `APP_KEY`; v1 values stay readable and are re-encrypted on use or by `scripts/rotate-app-key.js` (every store, HRIS connector credentials included); MFA secrets v2 (HKDF over the whole key); SMTP and AI provider secrets encrypted in `app_settings` and kept out of snapshots (`secretBoxV2.test.js`, `appSettingsSecrets.test.js`, `snapshotSecrets.test.js`, `rotateAppKey.test.js`). |
| SA-19 | Info     | Report builder           | `src/services/ReportBuilderService.js:283-315`                                                                                                               | Field whitelists are plain objects, so `constructor`/`__proto__` pass the `fieldMapping[f]` test. The emitted text is a fixed native-function string: a syntax error (500), **not** injection.                                                                                                                                                                                                                                                                                         | Fixed: every whitelist lookup goes through `ownCol()` (own string properties only), and an unknown data source is a 400 (`tests/unit/reportBuilderOwnCol.test.js`).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SA-20 | Info     | Dead code                | `src/services/DatabaseCleanupService.js:423-469`                                                                                                             | `restoreBackup` builds column names from the keys of a JSON file. It has **no caller**.                                                                                                                                                                                                                                                                                                                                                                                                | **Accepted**. Recommendation: delete it before someone wires it to an upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Existing controls verified

These were read in the source and, where noted, exercised by the existing tests. They were not assumed.

**Session**

- Cookie `httpOnly`, `SameSite=Lax`, and `Secure` set to `auto`. A boot guard fails when `COOKIE_SECURE` is on without `TRUST_PROXY` (`server.js:285-345`).
- Neutral cookie name, and secret rotation through a comma-separated `SESSION_SECRET`.
- `req.session.regenerate` on password, MFA and SSO sign-in (`src/controllers/AuthController.js:483,505,745`; `src/controllers/SsoController.js:556,596,711`).
- Logout is POST-only and destroys the session (`src/routes/index.js:260`, `AuthController.js:816-836`).
- Idle timeout (60 min) and absolute cap (24 h) (`src/middleware/sessionActivity.js:18-24`).
- `Cache-Control: no-store` on dynamic responses.

**Passwords**

- bcrypt (cost 10), minimum 12 and maximum 128 characters, with sequence and repeat rules (`src/utils/passwordValidator.js:69-75`) and password history.
- Constant-work anti-enumeration on sign-in (`src/middleware/auth.js:12-50`).
- Account lockout and login rate limit (`server.js:784-787`, `src/middleware/rateLimiter.js`).

**MFA**

- TOTP with window 1. Each accepted code is **consumed**: a unique index blocks replay (`src/services/MfaService.js:286-305`).
- 10 single-use backup codes, 40-bit random, bcrypt-hashed (`MfaService.js:317-350`).
- The pending MFA sign-in is invalidated after 5 wrong codes (`AuthController.js:605-607`).

**Password reset**

- 256-bit token, stored as SHA-256 and looked up by hash, so no timing oracle (`src/services/PasswordResetService.js:131-136`).
- Short TTL; single use through an atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now()` (`:209`).
- Other tokens are invalidated, and sessions are revoked on reset.

**SSO**

- OIDC uses the authorization-code flow with PKCE S256, `state` and `nonce`, stored in the session and single-use (`src/config/sso.js:468-514`).
- SAML (`sso.js:782-802`):
    - `wantAssertionsSigned`, `wantAuthnResponseSigned` (default on), audience set to our issuer, sha256;
    - `validateInResponseTo: 'always'` for SP-initiated flows, with a request cache;
    - 3-minute clock skew.
- The Entra bearer token is pinned to RS256 with issuer, audience and tenant checks (`sso.js:556-590`).
- IdP metadata fetch: https only, DNS-checked, connection pinned, no redirects, size and time caps (`src/services/SamlMetadataService.js:295-370`).

**API keys and SCIM**

- 192-bit `ak_` keys, stored as SHA-256 and looked up by hash (`src/services/ApiKeyService.js:18,97`).
- Per-feed scope allow-lists (`src/middleware/apiAuth.js:47-84`); SCIM writes need a write scope.
- Keys are scoped to the owner admin's RBAC profile.
- The legacy shared key is compared with `timingSafeEqual` and is never `APP_KEY`.

**CSRF**

- `csrf-sync` synchroniser token on form posts (`server.js:593-660`).
- Same-origin guard for every unsafe method (`server.js:501-586`). `X-Forwarded-Host` is trusted only behind `TRUST_PROXY`.

**Headers**

- helmet CSP with a per-request script nonce, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'` and `form-action 'self'` (`server.js:114-139`).
- `nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: SAMEORIGIN` (helmet defaults, checked by request).
- HSTS on HTTPS responses only (`server.js:142`).
- `trust proxy` off by default (`server.js:73`).

**Host header**

- E-mail links never use the Host header: `APP_BASE_URL`, else an exact-match `TRUSTED_HOSTS` list (`src/utils/emailTemplate.js:90-125`).
- The HTTP→HTTPS redirect reduces Host to a bare hostname (`src/utils/tlsServer.js:77-95`).

**SQL**

- Parameterised queries throughout.
- `ORDER BY` goes through `sortClause` with a whitelist (`src/utils/listTools.js:93-102`).
- Report builder: field, group, sort and operator whitelists; the logic operator is forced to AND/OR; RBAC filtering (`src/services/ReportBuilderService.js:283-1010`).
- `ReportDataService`: schema whitelists and `clampLimit`.

**SQL console**

- Returns 404 unless `SQL_CONSOLE_ENABLED=1`, then SuperAdmin only (`src/middleware/sqlConsoleEnabled.js`).
- Never reads or writes secrets: sessions, second factors, tokens, password and API-key hashes, stored secrets and HRIS connector credentials are refused before anything runs, and the refusal is audited (`SqlConsoleService._secretAccessViolation`). Pure reads run under the `sqlconsole_reader` role, which has no privilege on secret tables or columns (`db/postgres/167_console_reader_role.sql`).

**Files**

- Upload type and 10 MB limits on all three multer instances.
- Stored evidence gets random names outside `public/`, a ClamAV scan with quarantine, and downloads served only when the scan is clean and the file is in the caller's RBAC scope, as an attachment (`src/controllers/ComplianceController.js:266-277`).
- Every multer mount goes through `uploadGuard` (`src/middleware/uploadGuard.js`): parser errors are 4xx, and the content must match the extension (magic bytes, OOXML content types, macro parts refused, zip caps through the single ZIP reader of `src/utils/importGuards.js`). This covers the HRIS CSV upload and the skills-library ESCO upload (CSV or zip).
- The malware scan is a chain (`src/services/MalwareScanService.js`): clamd over TCP or a socket, then the Microsoft Defender command line (`execFile`, no shell), then `not_scanned`. The previous Unix-socket-only scan left every upload of a Windows install in `scan_error`. An unscanned file is restricted to the uploader, the reporting line and `manage_compliance`, always as an attachment; a rescan job retries pending files (migration 164).

**CSV exports**

- Formula neutralisation (`= + - @ TAB CR`) in `csvCell` / `csvEscape` on every CSV writer (`src/utils/csvSafe.js`, `src/utils/listTools.js:144`, `src/services/SkillMatrixWorkbookService.js:349`, the scheduled report through `exportToCSV`). XLSX output writes strings, not formulas.

**Logs and errors**

- Token, code, key, password and assertion query parameters are redacted from request logs (`src/middleware/logger.js:78-90`).
- Production error responses are generic unless the error is marked `expose` (`src/middleware/errorHandler.js:93-119`), and an unknown `NODE_ENV` is fatal.

**Secrets**

- Production refuses a missing or weak `SESSION_SECRET` (`src/config/app.js:13-35`).
- The first-run admin gets a random password and a forced change (`src/database/PostgresDatabase.js:1057`).
- Compose requires `DB_PASSWORD`, `SESSION_SECRET` and `APP_KEY` (`docker-compose.yml`).

**`child_process`**

- Only `execFile` with argument arrays: `pg_dump`, `pg_restore`, `icacls` (`src/jobs/db-backup.js`, `src/services/SqlConsoleService.js`), with no shell and no user-controlled executable.

**Privacy and erasure**

- A versioned privacy notice is acknowledged by every signed-in person once published; the gate fails closed (`src/middleware/privacyNotice.js`).
- `/employee/my-data/download` exports the person's own data through `DSRService.export`, with the confidential talent categories withheld and named; rate-limited and audited (`src/services/PrivacyService.js`).
- An objection to profiling stops the retention-risk score, keeps the person out of key-person names and the copilot's rankings, and holds automatic 9-box triggers for a human decision (migration 165).
- Manual erasure is refused under legal hold; the only override is a reasoned request approved by a second, different SuperAdmin, re-verified by `DSRService` (migration 166).
- `src/services/erasureRegistry.js` classifies every employee column and every table; `erasureRegistry-db.test.js` fails on an unclassified one.

**Windows installer**

- Downloads pinned by SHA-256 and Authenticode publisher; the `pg_hba.conf` trust window needs explicit consent and is logged; passwords go to `psql` through stdin; the package root is an allow-list and an `-IncludeData` dump fails on any secret-table row (`installerIntegrityAndTrust.test.js`).

**New routes in this release**

- `/employee/my-data` keys only on `req.user.id` behind `requireEmployeeOrManager`, so an admin id is never read as an employee id.
- `/compliance/register` is behind `requireSuperAdminPage`.
- `/api/self-assessment/team/approve-all` re-authorises every employee and every row (`SelfAssessmentWorkflowService.bulkApproveAgreedForTeam`).
- Recognition: team-circle or RBAC-scope check, refusal of self-thanks, visibility allow-list (`src/routes/v2-capability.js:741-800`).
- The growth controllers take no employee id from the request.

## Unauthenticated surface (no session required)

| Route                                                                                       | Protection                                                                                |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/health`, `/healthz`, `/health/ready`, `/readyz`                                           | Status only. The DB error is logged, not returned.                                        |
| `/metrics`                                                                                  | Loopback only, or `Authorization: Bearer $METRICS_TOKEN`.                                 |
| `GET/POST /login`, `/login/mfa`, `/forgot-password`, `/reset-password`                      | Rate-limited, lockout, CSRF on forms.                                                     |
| `/auth/sso/*` (`choose`, `enrol-code`, `:provider`, `:provider/callback`), `/saml/metadata` | OIDC state/nonce/PKCE and signed SAML. The chooser and enrol-code steps are rate-limited. |
| `/signup`, `/onboarding/pending`                                                            | Settings-gated (see SA-00) and rate-limited.                                              |
| `/api/powerbi/*`, `/scim/v2/*`, `/v2/safety-gate/status*`, `/api/v1/*` (data routes)        | API key or Entra bearer with per-feed scope. `/api/v1` also accepts a session.            |
| `/api/v1/`, `/api/v1/openapi.json`                                                          | Public API description only.                                                              |
| `/integrations/lms/:provider/webhook`                                                       | Per-provider shared secret in a header. Returns 404 while the development module is off.  |
| `/.well-known/lms-jwks.json`, `/lti/:provider/auth`                                         | Public JWKS. The LTI auth endpoint redirects to `/login` without a session.               |
| static `/public/**`                                                                         | Assets only. The user guide moved to `private/` behind `requireAuth`.                     |

Everything else is mounted after `router.use(requireAuth)` (`src/routes/index.js:399`) or carries its own `requireAuth` or role guard.

## `npm audit`

**Before** (`e00b25a`):

- `npm audit --omit=dev`: **1 moderate**. nodemailer ≤ 10.0.1 has two advisories:
    - GHSA-6vj9-mwq6-2f5v: process-global DNS cache reuses TLS servername, allowing SMTP credential disclosure;
    - GHSA-8vvx-rff5-p5rq: nested recipient arrays cause stack-exhaustion DoS.

    The fix is nodemailer 10.x (semver-major).

- `npm audit` (all dependencies): **1 high, 1 moderate**. form-data 4.0.0–4.0.5 (GHSA-hmw2-7cc7-3qxx, CRLF injection) comes in through dev tooling only.
- Not reported by `npm audit`, but deprecated upstream: `multer@1.4.5-lts.2` carries the notice "Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x".

**Actions:**

- `nodemailer` `^9.0.1` → `^10.0.12`. The only breaking change in 10.0.0 is "Node.js 20 or newer"; the app already requires 20.19 or later. `createTransport` and `sendMail` were smoke-tested.
- `multer` `^1.4.5-lts.1` → `^2.4.0` (same API).
- `npm audit fix`: form-data 4.0.6 and hasown 2.0.4, both lockfile-only.

**After:** `npm audit --omit=dev`: **0 vulnerabilities**. `npm audit`: **0 vulnerabilities**.

## Test results

The full `npx jest` run against a fresh database (`idevelop_test_sec`, all migrations, `db/postgres/seed-test.sql`):

- **375 suites passed and 13 skipped. 5 212 tests passed and 200 skipped.** The skips are pre-existing.
- The baseline before the fixes was 374 suites and 5 165 tests passed, with the same skips.
- `tests/unit/securityAudit20260929.test.js` adds 47 tests covering SA-01 to SA-13.

## Residual risks and recommendations

1. **External penetration test before GA.** This review was white-box and in-house. Commission an independent web-application test (authenticated, multi-role) and a configuration review of a production-like install (TLS termination, reverse proxy, `TRUST_PROXY`, backups).
2. **Coordinated disclosure and bug bounty.** Keep `SECURITY.md` current. Consider a bounty (even a modest or private one) after GA.
3. **CSP (SA-14), done.** Inline `on*=` handlers are gone and `script-src-attr` is `'none'`, so a future HTML-injection bug cannot run an event handler. What remains is `style-src 'unsafe-inline'` for inline `style=` attributes: a lower-risk, separate migration.
4. **i18next `escapeValue:false`.** Every `<%- __(key, {…})` with request- or database-derived values must escape those values, as the SA-02 fix does. A lint rule or a helper (`__html(key, values)` that escapes the values) would make this systematic.
5. **CSRF on multipart routes (SA-15).** Verify `_csrf` after multer and update the few upload clients that do not send it yet.
6. **LMS and xAPI outbound calls** are still made with `fetch` and are not pinned (the copilot now is, see SA-17). The base-URL guards cover IP-literal spellings, but a DNS name that resolves to loopback or metadata is only caught for webhooks, SAML metadata, the safety-gate webhook and the copilot. Route every outbound integration call through one pinned HTTP helper.
7. **Container (SA-16).** Keep the code root-owned and read-only, and mount `uploads/`, `tmp/`, `logs/` and `backups/` as volumes.
8. **`APP_KEY` (SA-18).** Done: a missing or weak `APP_KEY` is fatal in production, and `SESSION_SECRET` is no longer an encryption key there (secretBox v2). Operators upgrading must set a strong `APP_KEY` (rotate with `scripts/rotate-app-key.js`).
9. **Dependency hygiene.** Add `npm audit --omit=dev` (fail on high) to CI, and review deprecated packages, not only advisories.
