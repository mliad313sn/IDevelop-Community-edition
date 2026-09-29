# Distribution readiness report — IDevelop Community Edition 1.0.0

This report records how IDevelop Community Edition was derived from an internal
code base, what was removed, scrubbed and rebranded, how the result was
verified, and what remains for the owner to do before public announcement.

It deliberately does **not** repeat any of the names, credentials or data it
describes: publishing them here would defeat the purpose.

## 1. Method

1. The internal code base was exported **without its Git history**. The public
   repository starts from a fresh history, so no earlier commit, author,
   message or deleted file can be recovered from it.
2. Every file was audited with automated scans (product and customer names,
   hostnames, IP addresses, e-mail domains, Windows paths, GUIDs, key and token
   formats, hard-coded passwords, person names) and a manual review of the
   areas the scans flagged.
3. Transformations were applied as replayable scripts and each pass was
   verified; one faulty pass was detected and the affected files were rebuilt
   deterministically from the pristine source.
4. The result was verified by the full test suite on a fresh database, lint,
   format checks, a repository-wide hashed denylist test, and a visual check of
   the running application in both themes.

## 2. What was removed

| Category             | Items                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credentials          | Production database super-user password and standard administrator password hard-coded in the Windows installer configuration and a deployment script; a TLS certificate backup (`.pfx`)                                                                                             |
| Customer data        | An export of a customer's production skill catalogue, a capability framework tied to one company's strategy, generated mapping/categorisation batches, description drafts for that catalogue                                                                                         |
| Personal data        | Real employee names and account names copied from a live database into code comments, a SQL migration comment and tests; a user guide whose embedded screenshots showed real colleagues                                                                                              |
| Internal documents   | ~50 MB of internal documentation (assessments, committee notes, UAT logs, planning, manuals, test-credential notes), requirement matrices (`.xlsx`), requirement document, per-release deployment runbooks, a data-remediation SQL script, migration reports, the internal changelog |
| Internal tooling     | Scripts that copied production databases to development machines, seeded accounts with known passwords, loaded the customer framework, captured UAT screenshots, or built internal PDFs; 47 MB of UAT screenshots; a bundled third-party service wrapper binary                      |
| Legacy compatibility | Code that migrated browser storage from the former product's identifiers                                                                                                                                                                                                             |

## 3. What was scrubbed or generalised

| Area                     | Change                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product names            | Former product name, abbreviation and technical prefix replaced everywhere (code, SQL, installer, locales, tests, file names); a former community-edition brand and its publisher name removed |
| Customer identity        | Customer name, abbreviation, site names, and industry-specific wording ("mine site") replaced with neutral or fictional equivalents; local-content statutes kept as a generic, opt-in feature  |
| Live-instance references | Comments quoting measurements from a production or development copy of customer data neutralised; user-guide text reworded to "sample instance"                                                |
| Internal process markers | Delivery-lot, UAT-round, committee and rulebook references stripped from comments; code-section markers renamed to functional names                                                            |
| Database names           | Internal database names replaced by `idevelop`, `idevelop_dev`, `idevelop_test`, `idevelop_fixtures`                                                                                           |
| Installer                | Credentials blanked; database snapshot bundling made opt-in; customer-name guard replaced by an operator-supplied, git-ignored denylist                                                        |
| Tests                    | Suites that required a populated copy of customer data now run only against an opt-in fixture database; fixture names replaced with fictional ones                                             |

## 4. What was rebranded

- **Identity**: IDevelop Community Edition, declared once in
  `src/config/product.js`.
- **Logo and assets**: new mark, horizontal logos, favicons, PWA and Apple
  icons, social card (`public/brand/`, `public/icons/`).
- **Visual theme**: new Iris / Coral token system for dark and light themes,
  new typography, new chart palette with measured accessibility
  (`docs/BRAND.md`).
- **Text**: page titles, login subtitle, footer, meta description, Open Graph
  tags, PWA manifest, e-mail subjects and sender defaults, OpenAPI title,
  exported workbook metadata, MFA issuer, log service name, About page.
- **Packaging**: `package.json` metadata, Docker labels, Compose stack, mobile
  bundle id, installer names and window titles.

## 5. Verification evidence

| Check                                                                                    | Result                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Jest suite on a freshly migrated + seeded PostgreSQL 16 database                         | 359 suites passed, 0 failed (12 fixture-only suites skipped) — about 5,000 tests                                                        |
| ESLint                                                                                   | 0 errors                                                                                                                                |
| Prettier                                                                                 | all files formatted                                                                                                                     |
| Icon lint                                                                                | passed                                                                                                                                  |
| Repository-wide hashed denylist (legacy product, customer, sites, people, account names) | 0 hits, including tests, docs, SQL and file names                                                                                       |
| Secret scan (key formats, tokens, private keys, hard-coded passwords)                    | no credential in the tree; seed/demo passwords only in local test fixtures                                                              |
| Application run                                                                          | boots on an empty database, prints a one-time admin password, enforces password change and MFA, renders the new identity in both themes |

## 6. Architecture for future re-platforming

See [ARCHITECTURE.md](ARCHITECTURE.md). The schema, API (OpenAPI), UI strings,
design tokens, product identity and starter content are kept as
language-neutral contracts (`docs/contracts/`, `db/postgres/`, `locales/`),
guarded against drift by tests, with a documented strangler-fig migration path.

## 7. Items for the owner before announcement

| #   | Item                                                                                                                                                                    | Why                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | **Rotate every credential that existed in the internal repository** (database super-user and standard administrator passwords, certificates, any tokens shared in chat) | They were present in the internal history, which is not affected by this clean export |
| 2   | Confirm the organisation owns the copyright of the code and may publish it under AGPL-3.0-or-later (including contributions by contractors)                             | Licensing is only valid if the licensor holds the rights                              |
| 3   | Run a trademark clearance search for "IDevelop" in the target markets                                                                                                   | The name and logo are new; the AGPL does not cover trademarks                         |
| 4   | Keep the internal repository private                                                                                                                                    | Its history still contains the removed material                                       |
| 5   | Validate the Windows installer on a clean Windows Server                                                                                                                | It was refactored but can only be exercised on Windows                                |
| 6   | Provide a synthetic fixture generator (or dataset) to re-enable the fixture-only integration suites in CI                                                               | They currently skip on the public CI                                                  |
| 7   | Provide Playwright credentials as repository secrets to run the manual e2e job                                                                                          | The smoke suite needs known test accounts                                             |
