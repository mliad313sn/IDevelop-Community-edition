<p align="center">
  <img src="public/brand/idevelop-logo.svg" alt="IDevelop Community Edition" width="420">
</p>

<p align="center">
  <b>Open-source skills, talent and continuous-performance platform.</b><br>
  Capability frameworks · Assessments & reviews · Role readiness · 9-box & succession · Development plans · Analytics
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL v3+" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-7C6CFF"></a>
  <img alt="Node 20.19+" src="https://img.shields.io/badge/node-%E2%89%A520.19-7C6CFF">
  <img alt="PostgreSQL 16+" src="https://img.shields.io/badge/postgresql-16%2B-7C6CFF">
  <img alt="i18n FR / EN" src="https://img.shields.io/badge/i18n-FR%20%7C%20EN-FF7A59">
</p>

---

IDevelop Community Edition (**IDevelop CE**) helps an organisation describe the
skills its roles need, measure the skills its people have, and act on the gap —
fairly, transparently and with a full audit trail. It runs on your own
infrastructure (a single Node.js process and PostgreSQL), works offline-first
on the shop floor, and every screen is available in French and English.

![Executive dashboard — Daylight mode, Iris theme](docs/images/dashboard-daylight.png)

Friendly by default: a light, airy interface with rounded surfaces, and an
**Appearance** menu where every user picks light or dark mode and one of four
colour themes — **Iris**, **Meadow**, **Sunrise** or **Ocean**.

| Meadow theme                                   | Dusk (dark) mode                                   | Appearance menu                                     |
| ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| ![Roles, Meadow](docs/images/roles-meadow.png) | ![Framework, Dusk](docs/images/framework-dusk.png) | ![Appearance menu](docs/images/appearance-menu.png) |

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Development](#development)
- [Architecture](#architecture)
- [Branding & white-label](#branding--white-label)
- [Contributing, security, licence](#contributing-security-licence)

## Features

**Capability framework** — pillars → sub-domains → skills, role families, roles
with required levels and critical flags, 0–4 proficiency scale with level anchors
per skill category (FR/EN), Excel import/export, quality report for missing
descriptions. A generic **starter framework** (6 pillars, 34 skills, 6 sample
roles) can be loaded in one command.

**Assessment** — self-assessment campaigns, supervisor reviews with evidence,
change requests and disputes with SLA escalation, maker-checker approvals,
certification validity and expiry reminders, offline drafts that sync when the
network returns.

**Readiness & analytics** — role-readiness and gap analysis that separate
_unmeasured_ from _zero_, executive dashboard, capability map, benchmark and
comparator views, report builder with scheduled delivery, department briefs,
key-person and retention risk, workforce planning signals.

**Talent** — 9-box calibration (one person, one position), succession plans and
coverage floors, individual development plans, coaching plans, performance
improvement plans, mobility postings, recognition, pulse surveys.

**Governance & security** — fine-grained RBAC with geographic/organisational
scopes, access reviews and a tamper-evident (hash-chained) audit trail, MFA
(TOTP + backup codes), SSO (OpenID Connect incl. Microsoft Entra ID, SAML 2.0,
Google), SCIM provisioning, per-client API keys, GDPR export/erasure with legal
hold, retention policies, rate limiting, CSP with nonces.

**Integrations** — versioned JSON API (`/api/v1`, OpenAPI 3), signed webhooks,
LMS connectors (LTI 1.3, xAPI LRS and more), SMTP notifications and digests,
optional LLM "talent copilot" behind an anonymisation layer (off by default).

**Operations** — health/readiness/metrics endpoints, in-process job scheduler
(or BullMQ on Redis for multi-instance), daily database backups, restore drills,
installable PWA, Windows installer, Docker image.

## Quick start

### Option A — Docker Compose (evaluation)

```bash
git clone https://github.com/mliad313sn/IDevelop-Community-edition.git
cd IDevelop-Community-edition
cp .env.example .env
# edit .env: set SESSION_SECRET, APP_KEY and DB_PASSWORD (openssl rand -hex 32)
docker compose up -d --build
docker compose logs app | grep -A2 "FIRST-RUN SUPERADMIN"   # one-time admin password
docker compose exec app npm run db:seed:starter -- --commit   # optional starter framework
docker compose exec app npm run db:seed:demo-org -- --commit  # optional: 24 fictional people to explore
```

Open <http://localhost:3000>, sign in as `admin` with the printed password,
choose a new password and enrol an authenticator app (MFA is enforced for
super-administrators). The **Setup checklist** on the dashboard walks you
through the rest.

### Option B — Node.js + PostgreSQL

Requirements: Node.js **20.19+** (22 LTS recommended) and PostgreSQL **16+**.
Redis is optional.

```bash
npm ci
cp .env.example .env            # set DATABASE_URL, SESSION_SECRET, APP_KEY
createdb idevelop               # or let your DBA create it
npm run db:migrate:all          # schema + all migrations (also runs on boot)
npm run db:seed:starter -- --commit   # optional: generic starter framework
npm run db:seed:demo-org -- --commit  # optional: fictional demo organisation (--clean to deactivate)
npm start                       # http://localhost:3000
```

### Option C — Windows server

A one-shot installer (Node.js, PostgreSQL, service registration, backups,
upgrades with automatic rollback) lives in [`installer/`](installer/README.md).

### Importing a public taxonomy (ESCO)

Instead of (or as well as) the starter framework, you can load skills from
[ESCO](https://esco.ec.europa.eu), the European Commission's multilingual
classification of skills. No ESCO data ships with this repository: download the
CSV package (classification **skills**, format **CSV**, language **English**,
optionally also **French**) and convert it:

```bash
# Convert: ESCO skill groups become pillars (depth 1) and sub-domains (depth 2)
npm run import:esco -- --dir ~/esco-v1.2 --group "working with computers" --out esco.json
#   --lang-fr <skills_fr.csv>  French descriptions (auto-detected in --dir)
#   --group <uri|label>        keep a subset (repeatable); the full ESCO has ~13,900 skills
#   --limit <n>                keep at most n skills; --type knowledge|skill/competence

# Load it, like the starter framework: dry run first, then --commit
npm run db:seed:starter -- --file esco.json
npm run db:seed:starter -- --file esco.json --commit
```

The load is idempotent (rows are matched by name, never overwritten). ESCO is
licensed under **CC BY 4.0**: if you import it, you must credit it where your
users can see it (for example in your internal documentation or the framework
description). See [NOTICE](NOTICE) for the attribution text.

## Configuration

All configuration is environment-based; [`.env.example`](.env.example) documents
every variable. The essentials:

| Variable                                  | Purpose                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | PostgreSQL connection string (required)                                                                                       |
| `SESSION_SECRET`                          | Session signing secret — **required and checked for strength in production**                                                  |
| `APP_KEY`                                 | At-rest encryption key for stored secrets (MFA seeds, SSO/LMS/SMTP credentials); rotate only with `scripts/rotate-app-key.js` |
| `REDIS_URL`                               | Optional: BullMQ workers and shared rate-limit store for multi-instance deployments                                           |
| `V2_FEATURES=1`                           | Enables the extended talent suite (campaigns, IDP, coaching, PIP, lifecycle) under `/v2/*`                                    |
| `APP_BASE_URL`, `TRUSTED_HOSTS`           | Public URL used in e-mails and host-header allow-list                                                                         |
| `SMTP_*`                                  | Outgoing mail (can also be set in _Settings → Email_)                                                                         |
| `OIDC_*`, `AZURE_*`, `SAML_*`, `GOOGLE_*` | Single sign-on providers                                                                                                      |

Most business behaviour (readiness threshold, dispute SLAs, notification
triggers, retention, branding, optional modules) is configured at run time in
**Settings** by a super-administrator and stored in the database.

## Tech stack

| Layer     | Technology                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Runtime   | Node.js (CommonJS), Express 4                                                                             |
| Views     | Server-rendered EJS + progressive-enhancement vanilla JS, Chart.js (vendored), Font Awesome (self-hosted) |
| Data      | PostgreSQL 16+ via `pg`; plain SQL migrations in `db/postgres/`                                           |
| Auth      | Passport (local, OIDC, SAML, Google), `otplib` TOTP, `jose` for bearer tokens                             |
| Jobs      | In-process scheduler with advisory locks, or BullMQ + Redis                                               |
| i18n      | i18next, JSON catalogues in `locales/{fr,en}/`                                                            |
| Tests     | Jest (unit + PostgreSQL integration), Playwright (smoke), ESLint, Prettier                                |
| Packaging | Docker (multi-stage), Windows installer (PowerShell + WinSW), Capacitor shell                             |

## Project layout

```
server.js                 HTTP bootstrap: security middleware, sessions, i18n, routers, jobs
src/
  config/                 product identity, app config, permissions, SSO, i18n
  routes/                 route tables (index + feature routers under /v2/*)
  controllers/            HTTP adapters: parse request → call services → render/JSON
  services/               business logic (framework-agnostic, the bulk of the code)
  models/                 data access objects (SQL)
  database/               PostgreSQL adapter, transactions, migration runner
  middleware/             auth, RBAC, rate limiting, logging, request ids
  jobs/                   scheduled background jobs
  api/v1/                 versioned JSON API + OpenAPI contract
  integrations/lms/       LMS / LTI / xAPI connectors
  utils/                  pure helpers (branding, formatting, validation, crypto)
views/                    EJS layouts, partials and pages
public/                   static assets: css, js, brand/, icons/, vendor/
locales/{fr,en}/          UI strings
db/postgres/              schema + numbered migrations + seed data
scripts/                  operator tooling (migrate, seed, key rotation, exports)
installer/                Windows installer and service tooling
mobile/                   Capacitor wrapper for the PWA
tests/unit, tests/e2e     Jest and Playwright suites
docs/                     architecture, brand guide, contracts, user guide
```

## Development

```bash
npm run dev                 # nodemon
npm run lint && npm run format:check && npm run lint:icons
npm test                    # Jest; set DATABASE_URL to a disposable *_test database
npm run test:smoke          # Playwright (needs a running instance + E2E_* credentials)
npm run contracts:export    # refresh docs/contracts/ after changing the API or palette
```

The Jest suite runs against a real PostgreSQL database. CI does exactly this on
PostgreSQL 16 and 17:

```bash
createdb idevelop_test
DATABASE_URL=postgres://…/idevelop_test npm run db:migrate:all
psql "$DATABASE_URL" -f db/postgres/seed-test.sql
DATABASE_URL=postgres://…/idevelop_test npm test
```

A handful of integration suites need a _populated_ organisation (several sites,
assessed people, decided reviews). They skip unless `DATABASE_URL` points at a
database whose name contains `idevelop_fixtures` — see
[CONTRIBUTING.md](CONTRIBUTING.md#integration-fixtures).

## Architecture

IDevelop CE is a layered monolith with explicit seams designed so that any layer
can be re-implemented — in another framework or another language — without a big
bang rewrite. The database schema, the HTTP API, the UI strings, the design
tokens and the starter content are all **language-neutral contracts** kept as
plain files. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Branding & white-label

The stock identity ("Open Horizon": Iris `#7C6CFF`, Coral `#FF7A59`) is
documented in [docs/BRAND.md](docs/BRAND.md). An organisation can apply its own
name, tagline, logo, favicon and accent colour from **Settings → Branding**
without touching code; a fork changes the stock identity in
`src/config/product.js`, `public/brand/` and `src/utils/branding.js`.

## Contributing, security, licence

- Contributions are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) and the
  [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Release notes: [CHANGELOG.md](CHANGELOG.md).
- IDevelop CE is free software under the **GNU Affero General Public License
  v3.0 or later** — see [LICENSE](LICENSE) and [NOTICE](NOTICE). If you run a
  modified version as a network service, you must offer its source to its users.
