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

### Dependencies

- Minor/patch group: compression 1.8.2, express-session 1.19.0,
  express-validator 7.3.2, fast-xml-parser 5.11.1, i18next-fs-backend 2.6.8,
  i18next-http-middleware 3.9.9, node-mocks-http 1.18.1, passport 0.7.0,
  pg 8.23.0, winston 3.19.0, yaml 2.9.1; dev: Playwright 1.63, nodemon 3.1.14,
  Prettier 3.9.9 (four files reformatted), supertest 7.3.0.
- **ejs 6.0.1** (from 3.1.10): locals are now copied into a null-prototype
  object before rendering. No template change was needed.
- **express-rate-limit 8.7.0** (from 7.5.1): IPv6 clients are limited per /56
  subnet. The custom key generators (API, write-action and account
  re-authentication limiters) now pass their IP fallback through
  `ipKeyGenerator`, so rotating addresses inside one subnet no longer resets
  the count.
- **otplib 13.5.0** (from 12.0.1): TOTP verification moves to `verifySync` with
  the same ±1 step tolerance. Existing enrolments and backup codes keep working.
  A malformed code is still a plain refusal.
- **bcryptjs 3.0.3** (from 2.4.3, installer password script only; the app uses
  native bcrypt): new hashes are `$2b$`, and existing `$2a$`/`$2b$` hashes still
  verify.
- Dev: **Jest 30.5** (ES-module dependencies reach tests through
  `tests/helpers/nativeEsmEnvironment.js`), **eslint-plugin-n 18.4** (Node
  builtin checks off for browser code under `public/`, global `fetch` allowed).
- Compose: **Redis 8** (`redis:8-alpine`, used under AGPLv3, one of the three
  licences it is offered under). PostgreSQL stays on `postgres:17-alpine`
  because a major tag bump does not upgrade an existing data volume. CI now also
  runs on PostgreSQL 18, and the README documents the dump/restore upgrade.
- Patched brace-expansion (exceljs → archiver) for three DoS advisories. The
  production `npm audit` reports 0 vulnerabilities.
- Deferred, with Dependabot ignore rules: ioredis 6 (BullMQ 5 pins ioredis 5,
  and v6 defaults to RESP3; it will move with BullMQ 6, which also drops the
  legacy `repeat` option the jobs use), and commitlint 21 (needs Node ≥ 22.12,
  while the project supports 20.19+).

### Security (uploads, privacy, erasure, installer)

- **Upload content checks.** Every upload route, the HRIS CSV and the
  skills-library ESCO upload (CSV or zip) included, now checks that the file's
  content matches its extension (magic bytes, OOXML content types, macro parts
  refused, zip caps) and answers a malformed upload with a 4xx instead of a 500.
- **Malware scan chain** (migration 164): ClamAV over TCP or a socket, then the
  Microsoft Defender command line, then "not scanned". On the Windows installer
  every upload used to end in `scan_error` because only a Unix socket was tried.
  A host without a scanner no longer blocks uploads: an unscanned file can be
  downloaded only by its uploader, the reporting line and HR, as an attachment.
  Old `scan_error` files are re-queued and rescanned every 15 minutes.
  `REQUIRE_MALWARE_SCAN=1` holds unscanned files instead.
- **Privacy** (migration 165): a versioned FR/EN privacy notice, published by a
  SuperAdmin from the works-council register and acknowledged by every signed-in
  person; a JSON download of one's data on "What is recorded about me"; an
  objection to profiling that stops the retention-risk score, keeps the person
  out of the key-person names and the copilot's rankings, and holds automatic
  9-box actions for a human decision.
- **Erasure** (migration 166): manual erasure is refused under legal hold unless
  a reasoned override is approved by a second, different SuperAdmin. A
  schema-driven registry classifies every employee column and every table (a
  test fails on an unclassified one), uploaded files are deleted, and the export
  gains certifications, aspirations, applications, planned absences,
  notifications, HRIS links and training. Old unread notifications are pruned
  and rejected sign-up applicants pseudonymised.
- **Windows installer**: downloads pinned by SHA-256 and publisher signature;
  PostgreSQL 17.11; the `pg_hba.conf` trust window needs
  `-AllowPasswordRecovery` or a typed `TRUST` and is logged; passwords go to
  `psql` through stdin; warnings for `trust` lines and an unsynchronised clock;
  firewall rules tagged and reconciled; the service log folder restricted; the
  package root is an allow-list, `.gitleaks.toml` and `.dockerignore` no longer
  ship, and an `-IncludeData` package fails on any secret-table row.

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
