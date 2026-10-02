# Changelog

All notable changes to IDevelop Community Edition are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- HRIS synchronisation (`/admin/integrations/hris`, SuperAdmin): a CSV/TSV drop
  folder or upload, Personio and Lucca connectors (the two API connectors are
  implemented from public API documentation, not yet validated against a live
  tenant), value mappings, dry run then apply through the lifecycle, a
  mass-leaver guard (10% by default), a nightly job and SCIM placement through the
  same mappings. See `docs/HRIS-SYNC.md`; migration 160.
- **360° feedback** (development module, `/feedback-360`): an HR admin or a
  manager launches a round for one person or a campaign; the subject nominates
  peers, direct reports and others, the manager approves; raters rate the role
  skills 0–4 or "not observed" (never counted as 0), behaviour statements and
  keep / start / stop comments. Anonymous groups are shown only aggregated from
  3 answers, merged into "others" or hidden below it; responses are stored
  without rater identity. The report (self vs manager vs others, required level,
  blind spots, hidden strengths, shuffled comments) is released by the manager
  and feeds the development plan in one click. Reminders and closing at the
  deadline run on the job scheduler. **Shared one-to-one space** (engagement
  module, `/one-on-one`): joint agenda with notification of the other party,
  shared and author-only private notes, action items with owner, due date and a
  link to an IDP objective or a goal, meeting history feeding the "My team"
  roster. The self-assessment review console shows the person's current goals
  as read-only context. Migration `161_feedback_360.sql`.

### Changed

- The talent suite is no longer gated by the boot-time `V2_FEATURES=1`: optional
  modules (campaigns, development, talent, mobility, engagement, AI, local
  content) are switched from **Administration → Modules** (`/admin/modules`)
  without a restart, with three adoption stages (framework & assessment, plus
  talent & development, plus engagement & AI) or custom switches. A fresh install
  starts at stage 1; `V2_FEATURES=1` still forces every module on and an install
  started with it is recorded at stage 3. i18n no longer depends on
  `V2_FEATURES`.

### Security

- API rate limit: a request carrying an unknown key no longer gets a bucket of
  its own. The per-address bucket always applies; only a key that validates
  (an `api_keys` row or the legacy shared key) earns a second, per-key bucket
  (`API_IP_RATE_LIMIT`, default `API_RATE_LIMIT`).
- Sign-in fails closed when the MFA state cannot be read (it used to open the
  session on the password alone).
- Timing: an unknown, inactive, locked or not-yet-activated identifier costs the
  same bcrypt comparison as a real account; the password-reset mail is sent
  without holding the answer.
- Re-issuing MFA backup codes invalidates the unused older ones.
- A CSRF failure logs a short hash of the session id, never the id itself.
- Report builder and import: field names are looked up as own properties only
  (an inherited name such as `constructor` is not a column), an unknown data
  source is a 400, and `BaseModel.create()` checks column identifiers as
  `update()` does.
- `/api/v1` applies the same `APP_KEY` guard to the legacy shared key as the
  other API surfaces.
- The installer package no longer ships `.gitleaks.toml` or `.dockerignore`.
- The SSO page always shows the canonical SAML reply URL
  (`/auth/sso/saml/callback`), never a mistyped configured value.
- HTTP hardening moved into `src/middleware/httpHardening.js`, with tests:
    - JSON detection is anchored on the MIME essence, so
      `text/plain; x=application/json` no longer skips the CSRF check;
    - `Origin: null` is refused on every state-changing request unless a machine
      credential validates, and a malformed `Origin` is refused on form posts too;
    - pages send `Referrer-Policy: same-origin` (our own form posts then carry a
      real `Origin`); `/api` and `/scim` keep `no-referrer`;
    - `Permissions-Policy` also denies Bluetooth and the Topics API;
    - the session cookie is `__Host-app.sid` whenever it is always `Secure`
      (`COOKIE_SECURE=1` or built-in TLS); an existing `app.sid` session is
      carried over once, so nobody is signed out by the upgrade;
    - logout sends `Clear-Site-Data: "cache"`;
    - `/health` and `/readyz` answer the status only, unless the caller passes the
      `/metrics` gate, which now also accepts `METRICS_ALLOW_IPS`;
    - an anonymous remote `GET /api/v1/` returns `{status:'ok'}` only and
      `/api/v1/openapi.json` needs a session, a valid key or a loopback caller
      (the installer's local check still reads the version);
    - `system_logs` no longer records every successful mutation (`HTTP_POST`…);
      it keeps 401, 403 and 5xx. Authenticated mutations stay in the bounded
      activity trail (`perf_events`).

## [1.0.0] — 2026-09-29

First public release of **IDevelop Community Edition**.

### Added

- Friendly "Open Horizon" interface (`public/css/horizon.css`): light-first
  Daylight mode and a soft Dusk dark mode, rounded surfaces, pill navigation and
  buttons, gradient page banners, sentence-case labels, no grid texture.
- UX & design committee round 1 (`docs/DESIGN-REVIEW.md`): WCAG 2.2 AA fixes,
  self-hosted brand typeface, "Match device" mode, shared empty states, mobile
  layout fixes, friendlier bilingual copy, fictional demo organisation
  (`npm run db:seed:demo-org`).
- Innovation & business performance committee (`docs/PRODUCT-STRATEGY.md`):
  ESCO taxonomy import, bilingual survey templates, Slack / Teams webhook
  formats, works-council register, "What is recorded about me", EU AI Act
  copilot guardrails, employee growth panels (target-role gap, closest roles,
  suggested learning), manager team roster and team approval, scoped
  recognition.
- UX round 2: getting-started progress, card tables on phones, one filter-bar
  pattern, readiness legends, UK English, localised numbers and manifest.
- Appearance menu in the top bar: light/dark mode and four colour themes (Iris,
  Meadow, Sunrise, Ocean), remembered per browser, all measured WCAG AA.

- New product identity "Open Horizon": logo mark, horizontal logos (dark and
  light), favicons, PWA and Apple icons, social card (`public/brand/`,
  `public/icons/`), Iris / Coral colour system for both themes, Plus Jakarta Sans
  and JetBrains Mono typography, graphic chart in `docs/BRAND.md`.
- "Horizon" data-visualisation palette with measured contrast and
  colour-vision-deficiency separation (`src/utils/branding.js`).
- `src/config/product.js` — the single declaration of the product identity.
- Generic, CC0-licensed starter capability framework (6 pillars, 12 sub-domains,
  34 bilingual skills, 5 role families, 6 sample roles) and
  `npm run db:seed:starter`.
- Skills library (`/framework/library`): four CC0 sector packs (mining & heavy
  industry, public sector, healthcare & care, office & digital services) and an
  in-browser ESCO import (CSV files or one zip, group selection with a
  per-import cap), both with a dry run before confirming, idempotent loading
  through `FrameworkPackService` and an audit row per import.
- Language-neutral contracts in `docs/contracts/` (OpenAPI, chart identity,
  product identity) with `npm run contracts:export` and a drift test.
- Documentation for external contributors: `README.md`,
  `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue and pull-request templates.
- Repository-wide guard test that rejects legacy names and leaked personal data
  using hashed tokens.
- CI on PostgreSQL 16 and 17 using the product's own migrator and a
  deterministic seed.
- AI companion for every signed-in user: an "Assistant" tab (first, default) in
  the help panel answers "how do I…", "what should I do next", "explain this
  page" and "what is…" from a bilingual built-in knowledge base
  (`src/config/companionKnowledge.js`) filtered by role and permissions, with no
  language model required. Employees get only their own readiness and to-dos;
  managers' and admins' data questions go through the RBAC-scoped copilot with
  its EU AI Act guardrails. An allowed copilot model may rephrase product-guide
  answers but never receives personal data. `POST /api/companion/ask`,
  `GET /api/companion/suggestions`, admin switch `companion.enabled` (default
  on), audited as `COMPANION_QUERY`.

### Changed

- Licence text: full GNU AGPL v3.0 (`LICENSE`) plus `NOTICE` with trademark and
  third-party attributions.
- Docker image on Node 22 with OCI labels; Compose refuses to start without real
  secrets instead of falling back to insecure defaults.
- Windows packaging no longer bundles a database snapshot unless explicitly
  requested (`-IncludeData`), and its name guard reads an operator-supplied,
  git-ignored denylist.
- Base schema runs on PostgreSQL 16 as well as 17.
- Commit scopes are functional areas instead of internal project phases.

### Security

- SQL console disabled unless `SQL_CONSOLE_ENABLED=1` is set by the operator.
- Copilot: non-EU providers blocked by default; no named-person ranking unless
  enabled.

- Imported administrator accounts no longer receive a shared, publicly known
  default password; they get an unknowable secret and a forced change.
- No credential ships in `installer/config.psd1`.

### Fixed

- Client-side sortable table headers rendered as unstyled browser buttons.
- Pre-existing lint errors and unformatted files that kept CI red.
