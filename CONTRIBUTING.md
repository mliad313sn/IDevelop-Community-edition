# Contributing to IDevelop Community Edition

Thank you for helping! This guide gets you from a fresh clone to a merged pull
request.

## Ground rules

- Be kind and constructive — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security issues are **not** filed as public issues — see [SECURITY.md](SECURITY.md).
- By contributing you agree that your contribution is licensed under the
  project licence, **AGPL-3.0-or-later**.
- **Never commit real personal data.** Fixtures, screenshots and examples use
  invented people and organisations only. A repository-wide test
  (`brandTokensAbsent`) rejects known leaked tokens; reviewers reject the rest.

## Development setup

```bash
git clone https://github.com/mliad313sn/IDevelop-Community-edition.git
cd IDevelop-Community-edition
npm ci                     # also installs the git hooks (husky)
cp .env.example .env       # DATABASE_URL, SESSION_SECRET, APP_KEY
npm run db:migrate:all
npm run db:seed:starter -- --commit
npm run dev
```

Requirements: Node.js 20.19+ (22 LTS recommended), PostgreSQL 16+. Redis is
optional.

## Running the checks

```bash
npm run lint && npm run format:check && npm run lint:icons
createdb idevelop_test
export DATABASE_URL=postgres://USER:PASS@localhost:5432/idevelop_test
npm run db:migrate:all
psql "$DATABASE_URL" -f db/postgres/seed-test.sql
npm test
```

CI runs the same steps on PostgreSQL 16, 17 and 18 and must be green before merge.

### Integration fixtures

About a dozen integration suites assert behaviour that only shows up in a
_populated_ organisation (several sites, assessed people, decided reviews,
placements). They are skipped unless `DATABASE_URL` points at a database whose
name contains `idevelop_fixtures`. Contributions of a **synthetic** fixture
generator (invented people only) that makes these suites runnable in CI are very
welcome.

## Making a change

1. Open or pick an issue; for anything non-trivial, describe the approach first.
2. Branch from `main`.
3. Keep the architecture rules in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#6-replacing-a-component-framework-or-language-migration):
   business logic in `src/services/`, no SQL in controllers, every string in
   `locales/fr` **and** `locales/en`, every schema change as a new numbered
   migration in `db/postgres/`, no literal product names or colours.
4. Add or update tests. Bugs get a regression test.
5. If you changed the API, the chart palette or `src/config/product.js`, run
   `npm run contracts:export` and commit `docs/contracts/`.
6. Commit using [Conventional Commits](https://www.conventionalcommits.org/);
   the hook validates the message. Allowed scopes are listed in
   `commitlint.config.js` (for example `feat(framework): …`, `fix(auth): …`).
7. Open a pull request using the template.

## Database migrations

- File name: `NNN_short_description.sql`, next free number, idempotent
  (`IF NOT EXISTS`, guarded `DO` blocks).
- Never edit a migration that has shipped; add a new one.
- Provide a `NNN_short_description_down.sql` when a rollback is meaningful.
- The migrator runs each file in one transaction and records it in `schema_meta`.
- A new table must be classified twice, or the tests fail: in
  `scripts/reset-for-golive.js` (KEEP or WIPE) and in
  `src/services/erasureRegistry.js` (each employee column with its erasure
  treatment, or the table in `TABLES_WITHOUT_SUBJECT_COLUMN` with the reason).

## Translations

French and English are maintained together. Add the key to both
`locales/fr/<namespace>.json` and `locales/en/<namespace>.json`. New languages
are welcome: copy `locales/en`, translate, and register the language in
`src/config/i18n.js`.

## User guide screenshots

`node scripts/build-user-guide.js` builds the guide from
`src/config/userGuideContent.js`. Screenshots are optional and must be captured
on an instance holding **invented data only**; place them in
`tests/uat/screenshots-min/` (git-ignored) before building.
