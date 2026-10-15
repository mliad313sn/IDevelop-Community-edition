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

### Security (webhooks, API population, input limits)

- **Outgoing webhooks carry an allow-list of events** (audit SA-21). Only
  operational kinds leave (lifecycle, campaigns, self-assessments, IDP,
  coaching, training, certifications, coverage, mobility postings); the 9-box,
  PIP, retention and privacy families never do, whatever a subscription asks
  for. 360° feedback, one-to-one and HRIS sync kinds leave only when a
  SuperAdmin lists them in the new security-class setting `webhookOptInEvents`
  (empty by default). Payloads are reduced to ids, ISO dates and an in-app link,
  for JSON, Slack and Teams alike.
- **`/api/v1` person feeds exclude leavers and erased people for every caller**,
  SuperAdmin keys included (SA-22).
- **`TRUST_PROXY` is validated at boot** (SA-23): `/0`, a short IPv4-mapped or
  zero-leading IPv6 subnet and anything that is not an address, a subnet, a hop
  count or `loopback` / `linklocal` / `uniquelocal` stop the start-up with the
  reason.
- The relaxed CSP of the standalone guides applies only to the guides and the
  offline page, not to any path ending in `.html` (SA-24).
- Free-text reasons are capped at 2 000 characters on every route (400 or the
  form with its draft); new admin usernames are letters, digits and `. _ @ -`,
  2 to 64 characters; the SQL console's function scan is linear (SA-25).
- `express-flash` is replaced by an in-house helper with the same API, which
  never creates a session for an anonymous visitor; `node-mocks-http` is a
  development dependency (SA-26).
- Webhook-family settings (`webhook*`) are security-class (SuperAdmin only).

### Notifications (catalogue, one renderer, delivery)

- **One catalogue of notifications** (SA-47). `src/services/notificationCatalogue.js` declares every kind the platform emits, IDevelop's own included (360° feedback, one-to-one topics, safety waivers and contests, scheduled reports, the assessment reset): its category, severity, e-mail tier, whether it is mandatory, whether it may leave by webhook (360° feedback and one-to-one kinds only on a SuperAdmin opt-in, HRIS and confidential kinds never) and its title and subject in French and English. A test fails when a kind is emitted that the catalogue does not declare.
- **One e-mail renderer, one language per mail.** Every mail — notifications, the daily summary, the manager, department and workforce-planning digests, the department brief, invitations, set-password and reset links, SSO notices, the SMTP test — is built from blocks by `utils/emailTemplate.js` (`renderEmail`): one layout, the logo as an inline attachment, a real plain-text part, and a footer that says why the mail was sent or that it is mandatory. A mail is written in ONE language: the recipient's when the sender knows it, else the new **`mailDefaultLanguage`** setting (App Settings → E-mail, `fr` by default). The bilingual side-by-side mails are gone.
- **No name, figure or status in a subject.** The subject is always « {app} — {catalogue subject} »; a decision or a status (« rejected », « blocked », a performance plan) has a neutral subject, and the campaign, the person, the dates and the counts are in the body only.
- **Delivery state, retry for 24 hours, suppression** (migration 182). A failed send is retried after 1 hour and after 23 more hours, then marked abandoned; the stored error masks every address. A person who has left, was voided or erased, or a deactivated administrator, is never e-mailed, including a mail held by quiet hours or waiting for a retry. The daily summary lists only what was not already e-mailed and its subject no longer carries a count. The notifications monitor shows each e-mail's state and attempts; « Re-queue » gives a failed e-mail one more real attempt instead of marking it sent.
- **Mandatory safety and security mails.** Safety-gate and security alerts are e-mailed even when the person switched e-mail off or the domain toggle is off; the global e-mail switch and the SMTP configuration still apply.
- `scripts/render-notification-samples.js` renders every kind in French and English, every block type and the daily summary to files for review.
- **Upgrade:** migration 182 is additive (four columns on `notifications`, two CHECKs, two partial indexes, the `mailDefaultLanguage` setting); sent e-mail rows are marked `sent`, older failed rows are not retried. Mails are French until an administrator sets `mailDefaultLanguage` to `en`: an English-speaking install should set it before the upgrade. Safety and security notifications now reach people who had switched e-mail off. Integrations or filters that matched a subject line (a person's name, a campaign code, « [IDevelop] ») must match the new subjects. The unused BullMQ `notifications` queue is no longer created. The delivery columns are erased with the person's own notifications and returned in the personal-data export; a held e-mail body about an erased person is removed.

### Security (uploads and escaping proofs)

- **Every upload passes the antivirus** (SA-45). Imports, the HRIS CSV, the skills-library archive, the skill quality and SQL console workbooks, branding images, certificates and evidence are all scanned (ClamAV, else Microsoft Defender) before they are used. One rule, App Setting **`uploadAvScan`** (on by default, SuperAdmin only): a threat is refused, deleted and audited (`UPLOAD_REJECTED_AV`); when no scanner gives a verdict the upload is refused while `requireMalwareScan` applies (`UPLOAD_REFUSED_NOT_SCANNED`), otherwise accepted, marked not scanned and audited (`UPLOAD_NOT_SCANNED`). Evidence and certificates record that verdict instead of scanning twice.
- **Safe file names.** A file whose name carries a folder path, a control character, only dots or more than 200 characters is refused with a message asking to rename it (FR/EN).
- **Escaping proofs** (SA-46). An inventory test pins every raw template output and every script that writes HTML, per file, and an escaped output inside an inline script is limited to ids and the CSRF token. Two suites over the real app prove that stored text (names, comments, justifications, branding, 360° feedback, one-to-one, HRIS runs…) and every query parameter of every page are escaped. They found and fixed: the admin scope editors turned a place name holding a `\u003c` escape into live markup; the campaign burn-down, two dashboard groupings, the dashboard employee list and the benchmark fit answered 500 on a malformed filter, now 400.
- **Mobile build gate.** `mobile/scripts/check-server-url.js` refuses a mobile build whose server address is not https (http://localhost only in a development build), and once the native projects exist, an Android manifest without `allowBackup="false"`, with cleartext traffic or debuggable in a release build, and an iOS Info.plist with App Transport Security off. Navigation stays on the configured host.
- **Upgrade:** no migration. The antivirus check starts on the first upload after the upgrade and adds about 0.5 to 3 seconds per file where a scanner answers. Without a scanner, uploads keep working and are marked not scanned, unless `requireMalwareScan` is true (or `auto` with a detected scanner that fails), in which case they are refused until the scanner answers. Integrations that sent a file name with a folder path, or a malformed dashboard filter, now get 400.

### Talent and workflow (authority, resets, decisions with reasons)

- **Workflow decisions only by their authority** (SA-42). The former `/v2/talent` rating and placement writes answer 410 and point to the 9-box console. A performance improvement plan is proposed, activated, closed or withdrawn only by the person's direct manager, a SuperAdmin or an administrator whose clearance covers the person; supervisors and managers higher up the line read it. Activation is journaled with its author, and « met » or « not met » only closes a plan that ran: a plan that never started is withdrawn with a reason. The former supervisor console decides only a pending review on an assessment still awaiting review, with a level from 0 to 4; a cancelled or rejected assessment is never revived. Requesting changes and withdrawing a review save everything together. An arbitrated rejection needs a reason, putting an assessment in arbitration needs an open dispute, and the person is told the outcome.
- **« Reset the assessment »** (SuperAdmin maintenance panel, migration 181). One assessment, or a whole employee × campaign, goes back to draft with the previous answer prefilled, and its review goes back to pending, so the person and their reviewer do it again. The official level does not change until a new approval. A reason is required; a whole campaign also needs the person's employee number typed again; a closed or locked campaign is refused. An open dispute or change request is closed. Nothing is deleted; the history shows « Self-assessment reset for redo » and the audit log `MAINT_RESET_ASSESSMENT`.
- **Nothing deleted, every decision says who, when and why** (migration 180, SA-43). A successor is removed with a reason instead of deleted, and stays off the bench until someone names them again; band overrides, incumbent changes and plan archives are audited. Coverage rules and planned absences are deactivated with a reason. An LMS uplift decision records who decided, when and why, and a decline needs a reason. Recording an arrival or a move needs the employee-edit right and a reason; without the right it becomes a request an administrator decides.
- **Survey results only once closed.** While a survey is open its owner sees whether the anonymity floor is reached, never a count or a result.
- **Flight risk** is read only by the person's manager or a holder of the retention-risk permission; a handover's incoming person must be in the caller's scope.
- **Development plan page.** The plan's authority adds objectives and actions from the page; empty lists say what to do next; the page says whose plan it is and names the action types in words. A plan created from the page is written in the reader's language (it was always French, with English action titles).
- **Export-only data page** (SA-44). An auditor, a read-only viewer or a local admin who may export but not import opens « Import & export » on the export blocks only, instead of being sent back to the dashboard.
- **Upgrade:** migrations 180 and 181 are additive. Existing successors, absences and rules stay active; the ones deleted before the upgrade cannot be recovered. `v_continuity_coverage` is recreated with the same columns, counting active successors only. Integrations that called the former `/v2/talent` rating or placement routes get 410. Supervisors lose the PIP buttons' effect (403) where they are not the person's manager. Supervisors and HR who decline an uplift, cancel an absence, remove a successor or deactivate a rule are now asked for a reason. The new reason columns are in the erasure registry and the personal-data export.

### Talent data (9-box movements, coaching signatures, data fixes)

- **9-box movements** (migration 175, SA-41). Each placement records the person's previous approved placement and the direction of the move: first placement, unchanged, moved up, moved down or sideways, judged on the two axes. A box change needs a written reason of at least 20 characters, a real sentence and not a copy of the person's previous reason, at submission, at approval, when a reviewer changes a submitted box and at calibration. The console shows « before → now », the previous placement in the assess dialog and, on request, where each person came from on the grid. A new **9-box movements** page (from the console) gives the counts by direction, the box-to-box matrix, filters by campaign, site, department and direction, and a CSV.
- **What the person sees.** The direction of a disclosed move appears on the employee's home page only when the previous placement was disclosed to them too; the reason is never shown to them. It is returned on a formal access request, withheld from the self-service download with the rest of the 9-box, and erased with the person. The 9-box journal records a move, and a calibration, by ids only.
- **Coaching signatures** (migration 177). Only the person coached and the coach named on the session can sign it; an administrator who can read the session is no longer able to sign for the coach. The signature records the account used.
- **Where an official skill level comes from** (migration 176). Every path that writes an official level now says whether it was validated (assessor entry, review, approval, dispute decision, validated training) or not (an import that changes a level). Existing levels are marked validated only where their note proves it.
- **Data fixes.** People erased before the tombstone table existed get a tombstone, so a restored backup cannot bring them back (migration 178). Applications to an opportunity accept only applied, withdrawn, accepted and declined (migration 179); the never-computed review priority index is marked deprecated.
- **Upgrade:** additive migrations. Placements decided before the upgrade are rebuilt as « rebuilt from history » with no reason, never an invented one. If `opportunity_applications` holds another status, the new CHECK is added NOT VALID with a NOTICE instead of failing the upgrade: correct those rows, then validate the constraint. The movement reason and the coaching `actor_ref` are in the erasure registry and the personal-data export.

### Safety gate (waivers, contests, rules required by law)

- **A human path on the safety-competency gate** (migration 174, SA-40). The person's line manager, or HSE within their scope, can grant a **waiver** on one blocking skill: a reason is required, it lasts 72 hours at most and can be renewed once. It is never granted by the person themselves. A new waiver waits 72 hours after the end of the previous one, and a person can be waived at most 144 hours per skill over any 30 days.
- **Authorised by waiver, never cleared.** While a waiver runs, the status is WAIVED: « Authorised by waiver (until …) » on the pages, and `cleared: true` with `waived: true` and `waiverExpiresAt` in the API and the webhook. When it ends, the computed status applies at once; the person and their line are told.
- **Contests.** A person, or their line manager, can contest a block with a reason. HSE or HR records the decision with its reason: block kept, or lifted by a waiver or a data correction. The person is told.
- **« My safety clearance »** (`/safety-gate/me`): the person's own status, waivers and contests, and the contest form, from the personal menu.
- **Rules required by law.** A rule can be marked as required by law: no waiver lifts it, running waivers end when it is marked, and it is always enforced. Only a SuperAdmin can remove the mark, with a reason. Switching any other rule to observe now needs a reason.
- **Upgrade:** additive migration; existing rules are not marked as required by law and keep their mode. The two new tables are in the erasure registry, the personal-data export, the compliance register and the go-live reset.

### Security (encrypted backups)

- **Backups are encrypted** (audit SA-39). The daily database backup and the
  SQL-console restore points are encrypted as `pg_dump` writes them (AES-256-GCM
  stream, `<db>-<date>.dump.enc`), with a signed SHA-256 manifest beside each
  file; no clear copy touches the disk, and no key means no backup rather than a
  clear one. Every restore checks the manifest and authenticates the whole file
  first and refuses a changed, truncated or extended one. After each backup the
  file is verified (`pg_restore --list` on the decrypted stream) and every
  backup on disk is checked to still have its key here; failures alert the
  super administrators. Admin → Instance health shows the key, the last
  verification and key check, the off-host copy, and flags each file « non
  chiffrée » / "not encrypted".
- **The key:** DPAPI-protected on Windows (`node scripts/backup-key.js init`,
  then `export` once and keep the recovery copy offline), derived from
  `APP_KEY` on Linux and Docker. `scripts/rotate-app-key.js` keeps older
  backups readable (the old derived key is retired into the keyring before the
  database is touched; the rotation stops if it cannot be). `backup-key.js`
  also imports a recovery copy or a previous `APP_KEY`, verifies, encrypts
  and streams a backup into `pg_restore`. `Verify-BackupRestore.ps1` verifies
  and restores encrypted backups. Optional off-host copy: `BACKUP_OFFHOST_DIR`.
  See `docs/BACKUPS.md`.
- **Upgrade note:** existing plaintext `.dump` files stay where they are, are
  restorable with a warning and leave through the usual retention. On Windows,
  run `node scripts/backup-key.js init` and `export --out <file>` once after the
  upgrade (the first backup creates the key otherwise; the health page warns
  until it is exported). On Linux and Docker, keep an offline copy of
  `APP_KEY`, and never change it by hand: older backups would be unreadable
  until the previous value is imported (`backup-key.js import-app-key`).

### Security (mail privacy)

- **No password by e-mail** (audit SA-37). An invitation or a credentials resend
  now sends the username and a one-time **Set my password** link, valid 72 hours
  and usable once; the account holds a random password nobody knows until the
  person chooses theirs. Sending a new invitation burns the previous link. When
  nothing can be mailed (no address, e-mail off, a failed send) no link stays
  live and the temporary password is shown once on the administrator's
  credentials sheet, as before. A used, expired or unknown reset or
  set-password link answers 410 on the « forgot password » page.
- **Scheduled reports go to accounts, as a link** (SA-38). Recipients are chosen
  among the accounts (administrators and managers) whose clearance covers the
  report's scope; a typed address is refused. The clearance is checked again at
  every run and when the copy is downloaded. Each run keeps one in-app copy and
  the recipients are told in the app and by an e-mail that only links to it;
  the report is never attached. Copies are emptied after
  `reportRunRetentionDays` (default 90, 1 to 365, SuperAdmin-only) and when a
  person in their scope is erased; an emptied copy answers 410.
- **Upgrade note:** a schedule that e-mailed typed addresses keeps running only
  when every address matches exactly one active account, which becomes its
  recipient. Any other is **suspended** and its owner gets an in-app notice;
  choosing accounts on Reports → Schedules re-enables it. Nothing is deleted:
  the old addresses stay visible on the row.

### Security (privacy and sessions)

- **Diversity data is self-declared, with explicit consent** (audit SA-32).
  Only the person declares gender, age band, nationality and, for workplace
  accommodation, disability, from **My diversity data**
  (`/v2/cap/my-diversity`, linked from « What is recorded about me »); the page
  stays reachable whatever the talent module says, so consent can always be
  withdrawn. Disability needs its own consent. Withdrawal deletes every declared
  value at once; the consent ledger (field names, text version, dates, never a
  value) is kept and exported. A manager or an admin can no longer write
  someone's diversity data (403). Ethnicity is off until a SuperAdmin types a
  legal sign-off (audited). Disability is readable by the person and by HR
  holding « edit employees » only. Analytics count only consented
  self-declarations of active, non-erased people, with complementary small-cell
  suppression; values recorded before consent existed are set aside and listed
  for HR review (field names only, reason recorded).
- **One nationality switch** (SA-35): the Local content module. While it is off,
  a submitted nationality is ignored on employee create and edit, the bias scan
  leaves out the nationality axis, and the diversity analytics and the « My
  diversity data » page do not offer it. Nothing is deleted. The switch and the
  home country are SuperAdmin-only, audited and confirmed.
- **Back to the requested page after sign-in; no anonymous sessions** (SA-33).
  A link opened before sign-in is remembered in a short signed cookie (15 min,
  one use, same-origin relative paths only) and the password, MFA and SSO
  sign-ins land there; the login page shows a neutral notice instead of a red
  error. An anonymous visitor gets a session only on a page that renders a form.
- **Shared-computer mode, off by default** (SA-34): `kioskModeEnabled`
  (SuperAdmin) offers a « Shared computer » box at sign-in, or applies the mode
  to addresses in `kioskIpRanges`. A shared session idles out after
  `kioskIdleMinutes` (default 5), uses a browser-session cookie, signs out when
  the tab closes, shows a badge with one-click sign-out and resets the menu and
  language for the next person.
- **Offline drafts wiped**: a self-assessment rating is queued on the device only
  when it could not reach the server, and every sign-out removes the person's
  drafts from the browser.
- **SAML stays strict by default** (SA-36): the whole response and the assertion
  must be signed; a new « Strict » switch on the SuperAdmin SSO page
  (`samlStrict`) allows assertion-only signing, applied without a restart.
  `SAML_WANT_RESPONSE_SIGNED=0` still applies until the setting is stored.
- **Sensitive settings band**: on `/app-settings`, the nationality switch,
  shared-computer mode and mandatory MFA come first, each with its consequence,
  and every change asks for confirmation.

### Security (audit log)

- **Audit lines carry ids, not names** (audit SA-29). Sign-in, SSO, admin,
  campaign, onboarding, account-link, e-mail and HRIS lines name people as
  `employee:<id>` / `admin:<id>`; an unknown identifier typed at sign-in is kept
  only as a keyed `fp:<10 hex>` fingerprint; a failed e-mail is logged with a
  masked address. Whatever a caller writes, `LogService` replaces the row's own
  subjects' names, logins and addresses by their ref, masks every other e-mail
  address with a linear (ReDoS-safe) pattern and caps each logged string at
  4 KB. The system-logs page, its CSV/JSON export and the employee journal
  resolve the names when the log is read; an erased person reads "Erased person
  #id" in the reader's language. The actor filter still finds a person by name.
- **Erasure reaches the audit log**: inside the erasure transaction, the
  person's names, login and addresses (including older addresses recorded
  against them) are replaced by their ref; a chained `AUDIT_REDACTION` entry
  vouches for each changed row, which keeps its original hash. The erasure fails
  if this fails.
- **Seals, retention and one verifier** (SA-30): one `AUDIT_SEAL` entry per
  complete month; rows older than `auditLogRetentionYears` (new SuperAdmin
  setting, 1-10 years, default 5) are deleted by whole sealed months only,
  never a seal, redaction or purge entry, never a row about a person under
  legal hold, and only when the chain verifies (`audit-retention.tick`, daily
  after `AUDIT_RETENTION_HOUR`, default 2). `GET /v2/cap/audit/verify` and the
  new « Verify integrity » button of the system-logs page (SuperAdmin) use one
  verifier in the database that follows the hash links: historic forks left by
  the old id/lock race are reported as benign, any other change is flagged. The
  chain trigger now draws the row id under its lock.
- The redaction and purge functions are not executable by `PUBLIC` (so not by
  the SQL console's read role), and the SQL console refuses them and the
  `idevelop.audit_*` settings that open the path.

### Fixed

- An ordinary employee sign-in no longer leaves a spurious "unknown
  identifier" `LOGIN_FAILED` row; a failure is written once, when both the
  admin and the employee lookups miss (SA-31).

- A random production secret containing a year-like digit run (about 9 % of
  64-hex values) was refused and the service boot-looped; the year test now
  applies only to values that do not look random, and the Windows installer
  re-rolls such a secret.
- The LMS completion webhook was refused by the origin guard (no `Origin` on a
  server-to-server call); its validated `X-Webhook-Secret` now stands in for it.
- "Training completions to validate" crashed as soon as one completion was
  waiting (an undefined `locale`); uplift refusals are now translated.
- Erased people still marked active no longer appear on the employee list, in
  the active population behind scope filters or in a manager's governed team.
- The Power BI certification feed printed `IssuedOn` / `ExpiresOn` one day
  early on a server east of UTC (`dateFormat.sqlDateIso`, `appDayIso`).
- SAML refusals name their cause (signature, audience, issuer, clock,
  `InResponseTo`) on the test sign-in page and in `SSO_ERROR`.
- The critical-compliance KPI is floored, never rounded up: 1 999 of 2 000
  critical requirements met reads 99.9 %, not 100 %. Status colours are decided
  on the value printed (`utils/displayedValue.js`), on the dashboard and in the
  department brief.
- The dead hourly `priority-index.refresh` job (its service never existed) is
  removed.
- The audit-trail owner role of the Windows installer is now
  `idevelop_audit_owner`; a role under the legacy name is renamed in place by
  the installer and by migration 169.
- `.gitignore` covers `certs/`, `*.pfx`, `*.pfx.bak` and `*.p12` anywhere.

### Database

- **Migration 168** adds `public.fn_console_reader_sync()`, the SQL console
  read-role grant of migration 167 as a reusable function. Every later
  migration that adds a table, a view or a column ends with
  `SELECT public.fn_console_reader_sync();` (checked by a test).
- **Migration 169** renames a legacy audit-trail owner role.
- **Migration 170** adds the audit-log redaction, seal, sealed-purge and verify
  functions (`fn_system_logs_*`), lets `block_mutation()` through only on those
  vouched paths, draws the chain id under the advisory lock, indexes the chain
  links and seeds `auditLogRetentionYears`. No existing row is rewritten. It was
  rehearsed on a populated copy (about 30 000 chained rows over seven years,
  pre-chain rows and historic forks): the chain verified before and after.
- **Migration 171** adds the `dei_consents` ledger and the provenance,
  needs-review and HR-review columns of `employee_demographics`; rows that exist
  at upgrade are flagged `legacy_unknown` and leave every statistic. Re-grants
  the console reader.
- **Migration 172** adds `report_schedule_recipients` and `report_schedule_runs`
  and the `enabled` / `disabled_reason` columns of `report_schedules`, maps or
  suspends the schedules that sent to typed addresses (owner told once).
  **Migration 173** makes a copy's content emptiable (`purged_at`,
  `purge_reason`) and seeds `reportRunRetentionDays`. Both re-grant the console
  reader.
- **Migration 180** adds the successor state and removal columns, the LMS
  decision trail (`decided_by_ref`, `decided_at`, `decision_reason`), and the
  deactivation reason of coverage rules and planned absences, with CHECKs that a
  removal, a decline and a cancellation carry a reason; recreates
  `v_continuity_coverage` over active successors (same columns). Re-grants the
  console reader. **Migration 181** widens `employee_movements.kind` with
  `assessment_reset`, keeping every former value.

### Tests

- DB-backed suites are serialised across jest workers by a PostgreSQL advisory
  lock (`tests/helpers/dbSuiteEnvironment.js`), so `npm run test:unit` no
  longer deadlocks; they get a 60 s default timeout.
- Every suite guards on the database **name** (`tests/helpers/testDatabase.js`),
  never on a substring of `DATABASE_URL`.
- Real-app suites wait for the server's i18n middleware (`i18nReady()`) instead
  of a fixed sleep; dead skipped placeholders are removed.
- Audit log: `auditIdsOnly`, `auditSsoIdsOnly`, `auditLoginFailedOnce`,
  `auditLogLinearScrub`, and the database suites
  `auditChainRedactionSealPurge-db` and `auditErasureNeedles-db`.
- Privacy and sessions: `deiConsentSelfDeclaration`, `deiConsent-db`,
  `nationalitySwitch`, `returnToAfterSignIn`, `anonymousNoSession`,
  `sharedComputerMode`, `sharedComputerLoginView`, `selfAssessmentDraftsWiped`,
  `samlStrictMode` and `sensitiveSettingsBand`.
- Mail privacy: `accountSetupLink` and the database suite
  `reportScheduleAccounts-db`.

### Security (CSRF on uploads, SSO notices, security panels)

- **CSRF on multipart uploads (audit SA-15, fixed).** The data-management and
  full-system imports, the skill-matrix workbook and the certificate evidence
  form were exempt from the CSRF token check because multer parses the body
  after it. Nothing is exempt now: the token travels in the `x-csrf-token`
  header (every same-origin `fetch` mutation gets it from `public/js/main.js`)
  or, for a native multipart form, as `?_csrf=` on its action (read for
  multipart requests only, redacted in the request log). A missing or wrong
  token is refused with 403. `/api/v1` keeps its key model. A test enumerates
  every upload mount (21 routes, HRIS CSV and ESCO upload included) from the
  live routers.
- **SSO invitations**: neutral wording ("your {{provider}} account"; the
  Windows/Outlook sentence only for a Microsoft account; "your company account"
  when the provider has no name); the reminder prefix in both halves of the
  subject; the in-app notice opens `/account/sso-change`, the same explanation
  as the e-mail for the signed-in person only, with the go-live date or the
  provider as its subtitle. A printed notice is due for everyone who never
  received the e-mail (no address or e-mail off).
- **Security panels** that the earlier ports left without a view: the
  unencrypted SMTP relay warning (settings page and dashboard) and its
  SuperAdmin form; the copilot egress gate (why the AI provider is off, the
  allowed private hosts, the recorded transfer basis and its form); a locked
  badge and notice on security-class settings for local admins; the MFA grace
  banner; the per-key `?apiKey=` toggle with a deprecation notice; the
  antivirus status on the Health and Compliance pages.
- **New App Settings**: `requireMalwareScan` (`auto` by default: required once a
  scanner is detected), `privacySelfExportPerHour` (5),
  `unreadNotificationRetentionDays` (blank follows the read window) and
  `onboardingRejectedRetentionDays` (180). All are SuperAdmin-only.

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
- SSO reply URLs: a base URL that points at a page of the app (`…/login`,
  `…/dashboard`, `…/auth/…`) is normalised to the application root, with a
  warning in the log; `/login/auth/sso/:provider/callback` is answered by the
  same handler and `/login/login` redirects to `/login`; the SAML reply URL
  configured on the SSO page is answered too when it differs from the
  canonical one (same handler and checks; the origin guard and the CSRF skip
  accept it). The SSO settings page receives `callbackMismatch` to name the
  address to register instead.
- **Secrets at rest (audit SA-18 closed). `APP_KEY` is now required in
  production:** the service refuses to start when it is missing, shorter than
  32 characters or a placeholder, and `SESSION_SECRET` is never used as an
  encryption key there.
    - secretBox v2: `enc:v2:<purpose>:…`, AES-256-GCM under HKDF-SHA256 of
      `APP_KEY`, the purpose bound as additional data. Existing `enc:v1:` values
      stay readable and are re-encrypted on their next write or by the rotation
      script.
    - MFA secrets v2 (HKDF over the whole `APP_KEY` instead of its first 32
      characters); a v1 secret is re-encrypted after its next successful use.
      Confirming an already-active MFA enrolment is refused, and the code used to
      confirm is consumed.
    - The SMTP password and the AI provider key are encrypted in `app_settings`
      (lazily for existing values), shown only as a mask, never exported to JSON,
      never imported from JSON and never copied into snapshots; snapshots taken
      earlier are scrubbed once at start-up.
    - `scripts/rotate-app-key.js` re-encrypts every store, v1 and v2: app
      settings, LMS, webhooks, safety gate, HRIS connector credentials and MFA
      secrets.
- **Two-factor authentication is mandatory** for every administrator role and
  for managers who sign in with a password (SSO sessions rely on the identity
  provider's MFA), migration 162. An upgraded install gets a grace period
  (14 days for administrators, 30 for managers) with a countdown at each
  sign-in; a new install enforces it at once. The gate fails closed, and so
  does the per-account `mfa_required` policy. SuperAdmins can switch the
  policies off (`mfaRequiredForPrivileged`, `mfaRequiredForManagers`).
- **Session defaults: 30 minutes idle, 12 hours absolute** (they were 60 min
  and 24 h). An upgrade changes them only where the old default was never
  changed.
- Sign-in throttling: progressive delays per (address, identifier) and per
  endpoint, a per-address ceiling high enough for a site behind one address
  (`LOGIN_IP_CEILING`, default 100); administrator accounts are locked after
  10 failures (`ADMIN_HARD_LOCK_AFTER`) and the SuperAdmins alerted; other
  accounts are slowed, never refused, and the person is notified. A wrong
  current password on `/change-password` or a wrong code at `/login/mfa`,
  `/v2/uam/mfa/verify` or `/v2/uam/mfa/disable` counts toward the lockout,
  and those checks are rate-limited per user.
- **API keys go in headers** (`X-API-Key`, or an opaque bearer token in
  `Authorization`). A key in the URL (`?apiKey=`) is refused with a 401 that shows the
  header form, except for a key that carries the per-key compatibility flag
  (migration 163: keys that existed at the upgrade keep it, new keys never get
  it) or the env shared key with `API_KEY_QUERY_STRING=1`. A SuperAdmin
  switches the flag per key (`POST /api/v1/admin/api-keys/:id/query-string`,
  audited). In Power Query:
  `Web.Contents(url, [Headers=[#"X-API-Key"="ak_…"]])`.
- **Security-class settings are SuperAdmin-only** (refused server-side,
  audited): authentication, sessions, MFA, SSO, onboarding, data retention,
  AI/copilot, API, backup, the public base URL, the outgoing mail server and
  HRIS. Operational settings stay delegable (`manage_app_settings`). The
  settings page receives `locked` / `securityClass` per row for a read-only
  badge.
- **SMTP requires TLS.** STARTTLS is mandatory (`requireTLS`), so an attacker
  cannot strip it and credentials are never sent in clear. Product decision:
  one internal relay may be exempted by a SuperAdmin
  (`POST /app-settings/smtp/plaintext-relay`, reason mandatory, audited); it
  must resolve to a private or loopback address, it is reached at the pinned
  address, and SMTP credentials are still never sent to it without TLS. The
  dashboard and the settings page receive the relay status for a permanent
  warning.
- **Copilot egress gate (audit SA-17).** Product decision, safe by default:
  a private, loopback or link-local AI target is refused unless a SuperAdmin
  lists it in `copilotAllowedPrivateHosts` (or `copilotTrustedHosts`); plain
  http only for an allow-listed loopback model without an API key; the
  connection is pinned to the checked address and redirects are refused; an
  external provider stays blocked until a SuperAdmin records the legal basis
  of the transfer and the processor-agreement acknowledgement for that
  provider and host (`/app-settings/copilot/transfer-basis`, audited,
  withdrawable). A blocked call answers with the built-in engine and sends
  nothing. `COPILOT_BLOCK_PRIVATE_HOSTS` is no longer read.
- **SQL console secret guard.** The SuperAdmin SQL console refuses, read and
  write, every statement that reaches sessions, second factors, reset tokens,
  password and API-key hashes, LMS, webhook and safety-gate secrets, HRIS
  connector credentials and secret settings. The script is tokenised the way
  PostgreSQL reads it (comments, quoted and qualified names, views, routine
  and `DO` bodies, computed dynamic SQL), and the doors to the same data are
  closed (server files, large objects, `dblink`, `*_to_xml`, `SET ROLE`,
  role and extension management). Each refusal is audited
  (`SQL_CONSOLE_SECRET_REFUSED`); a top-level `SELECT *` that is allowed has
  its secret cells masked.
- **Migration 167: `sqlconsole_reader` role.** Pure reads from the console
  run under a read-only role that has no privilege on the secret tables or
  columns (column-level grants, including `hris_connectors.credentials`). Once
  it exists, `SELECT *` on a table with a secret column is refused by
  PostgreSQL and the console asks for a column list. Without CREATEROLE the
  migration logs a notice and the application guard still applies. A later
  migration that adds tables must repeat its grant block (CONTRIBUTING.md).
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
