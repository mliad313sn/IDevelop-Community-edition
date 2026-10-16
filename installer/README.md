# IDevelop Community Edition — Windows installer

One-shot installer that stands up **IDevelop** and every prerequisite on a
fresh Windows machine: Node.js, PostgreSQL, the database, the app, and an
auto-start service.

Supported: **Windows 11**, **Windows Server 2019 / 2022**, and newer.

It is the recommended path for on-premise Windows deployments. For Linux,
containers and Kubernetes see the Docker instructions in the main README; for
a step-by-step manual install see [MANUAL-DEPLOY.md](MANUAL-DEPLOY.md).

---

## Quick start (target machine)

1. Copy the unzipped package folder to the machine (contains
   `Install-IDevelop.ps1`, `config.psd1`, and `app\`).
2. Open **PowerShell as Administrator** in that folder (the script self-elevates
   if you forget, and now keeps the window open so you can read the result).
3. Run:

```powershell
# Fresh machine (installs Node + PostgreSQL + everything):
powershell -ExecutionPolicy Bypass -File .\Install-IDevelop.ps1 -PgSuperPassword 'ChooseAStrongPgPassword!'
```

When it finishes it prints the URL (default `http://localhost:3000/`) and a
**one-time random admin password** (change required at first login).

### Email notifications (optional, post-install)

The app can email users when system actions occur (self-assessment
approve/reject/changes, maker-checker decisions, PIP lifecycle, coaching plans).
This is **off by default**. To enable it after install, sign in as an admin and go
to **Settings → Email (SMTP)**: enter your SMTP host/port/credentials and the
from-address, use **Send Test Email** to confirm delivery, then turn on the
**enableEmailNotifications** master switch. Per-domain triggers live under
**Settings → Email Triggers**. Credentials can alternatively be supplied via the
`SMTP_*` variables in `.env` (used only when the matching Settings value is blank).
No SMTP server is installed or required by the installer.

### Reusing an existing PostgreSQL

```powershell
.\Install-IDevelop.ps1 -UseExistingPostgres -PgHost localhost -PgPort 5432 -PgSuperPassword 'theRealPostgresPassword'
```

### Remote / managed PostgreSQL over TLS

```powershell
.\Install-IDevelop.ps1 -UseExistingPostgres -PgHost db.internal -PgPort 5432 -PgSsl -PgSuperPassword 'theRealPostgresPassword'
```

> The PostgreSQL **client tools** (`psql.exe`) must be present on the Windows box
> when targeting a remote server, so the installer can run migrations. Install
> "Command Line Tools" from the PostgreSQL installer if needed.

### Common options

| Option                        | Purpose                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-InstallDir <path>`          | Install location (default `C:\Program Files\IDevelop`)                                                      |
| `-AppPort <n>`                | App HTTP port (default `3000`)                                                                              |
| `-PgSuperPassword <pw>`       | postgres superuser password (required when reusing PG)                                                      |
| `-UseExistingPostgres`        | Force reuse mode (never install PG)                                                                         |
| `-PgHost`, `-PgPort`          | Target an existing PostgreSQL                                                                               |
| `-PgSsl`                      | Connect to PostgreSQL over TLS                                                                              |
| `-SkipFirewall`               | Don't add the firewall rule                                                                                 |
| `-NoService`                  | Deploy + configure DB but don't register/start the service                                                  |
| `-ServiceMode <m>`            | `Service` (real Windows service), `ScheduledTask`, or `Auto` (default)                                      |
| `-UseScheduledTask`           | Shortcut for `-ServiceMode ScheduledTask`                                                                   |
| `-AllowPasswordRecovery`      | Allow the temporary `pg_hba.conf` trust window that resets an unknown local `postgres` password (see below) |
| `-MigrateServiceAccount`      | Upgrade: move a `LocalSystem` service to its virtual account once the upgrade is healthy (see below)        |
| `-EnableAuditOwnerSeparation` | Turn on audit-trail ownership separation (off by default; see below)                                        |
| `-ApplyPgHardening`           | Apply the recommended PostgreSQL settings on a server Setup did not create (see below)                      |
| `-EnforceManifest`            | Move files the release does not list out of the install directory (never deletes; see below)                |

Defaults live in **`config.psd1`**.

### Service hosting (Windows service vs Scheduled Task)

The app is hosted as a background, auto-start, **restart-on-failure** process. Node
itself is not SCM-aware, so a _real Windows service_ is created via the tiny
**WinSW** wrapper (`github.com/winsw/winsw`) — it appears in `services.msc` /
`Get-Service`, runs as its own virtual account on a new install (see _The service
account_ below), restarts on crash, and rolls its stdout/stderr logs under
`…\IDevelop\service\logs\` (`…\service\` on installs made before this release).

- **`Auto`** (default): install a real Windows service; fall back to a SYSTEM
  **Scheduled Task** only if WinSW can't be obtained (offline _and_ not bundled).
- **`Service`**: require the real service (fails if WinSW is unavailable).
- **`ScheduledTask`** / **`-UseScheduledTask`**: keep the legacy task host (no extra binary).

WinSW is sourced from a copy **bundled** at `<package>\bin\WinSW-x64.exe` if present
(drop it there to make the package fully self-contained / airgap-ready), otherwise
**downloaded** at install time from `config.psd1` → `WinSwUrl`. Switching modes on an
existing install is clean: the installer removes the other host before registering
the chosen one (no double-run). Re-running the installer / `-Patch` converts a box
that previously used a Scheduled Task into a real service automatically (mode `Auto`).

### Security checks during install and upgrade

- **Pinned downloads.** Node.js, PostgreSQL, the Visual C++ Redistributable and
  the WinSW service wrapper are each pinned by SHA-256 in `config.psd1`
  (`NodeMsiSha256`, `PgInstallerSha256`, `VcRedistSha256`, `WinSwSha256`), and
  the vendor-signed ones by their Authenticode publisher too. A file whose hash
  or signature does not match is deleted and never run, and the install stops.
  A file pre-placed in `%TEMP%` for an offline install is reused only when its
  hash matches; a WinSW copy bundled in `bin\` is held to the same hash.
  Changing a URL means changing its hash in the same edit.
- **PostgreSQL 17.11** is the version installed when no PostgreSQL is found. An
  existing server is never upgraded.
- **No silent `trust` window.** When the `postgres` password of a LOCAL
  PostgreSQL is unknown, Setup can reset it by opening a temporary `pg_hba.conf`
  trust window (about 10 s, loopback only, database and user `postgres` only).
  It does so only with `-AllowPasswordRecovery` or after you type `TRUST` at the
  console; an unattended run without the switch stops with an explanation. Every
  decision and every opening / closing is recorded in
  `%ProgramData%\IDevelop\logs\pg-trust-window.log`. `Manage-IDevelop.ps1
-SetPgPassword` follows the same rule.
- **Passwords never on a command line.** SQL that sets a password (`ALTER ROLE`
  / `CREATE ROLE ... PASSWORD`) is sent to `psql` through its standard input, so
  it never appears in the process list, crash dumps or EDR process logs. The
  PostgreSQL installer receives the superuser password from an option file in a
  private temporary folder (deleted as soon as it returns), and
  `scripts\set-admin-password.js` reads the new admin password from the
  `SET_ADMIN_PASSWORD` environment variable. `Manage -SetAdminPassword` uses the
  same variable, also against an older installed script (a fixed `node -e`
  wrapper hands it over inside node).
- **The package is checked before anything changes.** `app\release-manifest.sha256`
  lists the SHA-256 of every file the release ships. Setup compares the
  extracted package with it **before** it stops the service or copies a file;
  an altered, missing or added file stops the run with the list of differences.
  Re-extract the original package (or rebuild it) and run Setup again.
- **Read-only warnings.** Setup and `Manage-IDevelop.ps1 -CheckDb` report any
  `trust` entry in `pg_hba.conf` (passwordless login, never changed by Setup) and
  an unsynchronised Windows clock (TOTP codes, session expiry and audit
  timestamps depend on it). Setup changes the Windows Time service only if you
  type `Y` when asked.
- **Firewall rules.** Every rule Setup creates carries the Group `IDevelop`. On
  each run, rules for ports no longer in use, duplicates and older untagged
  rules are removed; the uninstaller removes every rule of the group.
- **Service logs.** The `service\logs\` folder (the wrapper's stdout / stderr
  logs) is restricted to SYSTEM, Administrators and the service account before
  the service writes its first line. The `service\` folder itself (the wrapper
  and its configuration) is read-only for the service account.

### The service account

`config.psd1` → `ServiceAccount = 'Auto'`:

- **A new install** runs the Windows service as its virtual account
  `NT SERVICE\IDevelop`: no password to manage, and no rights on the machine
  beyond what Setup grants it.
- **An upgrade keeps the account the service runs as today.** A service still
  on `LocalSystem` is never switched in passing: Setup logs a recommendation,
  asks at the console when one is attached, and otherwise waits for
  `-MigrateServiceAccount`:

    ```powershell
    .\Install-IDevelop.ps1 -Migrate -UseExistingPostgres -MigrateServiceAccount
    ```

    The switch happens **after** the upgrade has answered its health check. The
    account is first granted every folder listed below; if one cannot be
    granted, nothing is switched (`ABORTED-ACL`). Then `sc.exe` changes the
    account, the service restarts and must answer its health check again. If it
    does not, Setup puts it back on `LocalSystem` by itself, withdraws the
    grants and restarts it (`ROLLED-BACK`); the upgrade itself is kept. The
    result is in the log and in `…summary.txt` (`Service acct`).

What the virtual account gets:

| Where                                                                                                    | Right                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `%ProgramData%\IDevelop` and its `backups`, `sql-restore-points`, `audit-anchors`, `tls`, `keys`, `logs` | Modify                                                             |
| `<InstallDir>\uploads`, `data`, `logs`, `backups`, `tmp`, `certs`, `AI_Engine_Docs`, `service\logs`      | Modify                                                             |
| `<InstallDir>\.env`, `%ProgramData%\IDevelop\keys\backup-keyring.json`                                   | Read                                                               |
| `<InstallDir>` (the code) and `<InstallDir>\service` (the wrapper)                                       | Read and execute only: the service can never rewrite the code      |
| `%ProgramData%\IDevelop\app-backups`, `restore-points` (code copies an administrator may run)            | Nothing                                                            |
| `HRIS_DROP_ROOT` from `.env`, when it is a local folder                                                  | Read and execute (added; the folder's other rights are left alone) |

An HRIS drop folder on a network share is read as the **computer account**
(`DOMAIN\<machine>$`): grant that account read access on the share. A drop
folder set only in the HRIS page and not under `HRIS_DROP_ROOT` is not known
to Setup: grant `NT SERVICE\IDevelop` read access to it yourself.

To go back to `LocalSystem` on purpose, set `ServiceAccount = 'LocalSystem'` in
`config.psd1` and run an upgrade: the service is registered as `LocalSystem`
again and the virtual account's grants are removed. In an emergency,
`sc.exe config IDevelop obj= LocalSystem` then `Restart-Service IDevelop` works
at once (the remaining grants are harmless). A Scheduled Task host always runs
as SYSTEM.

### Audit-trail ownership separation

`config.psd1` → `AuditOwnerSeparation = 'Auto'`. When it is on, the append-only
tables (the audit log, assessment history, signatures…) and their guard
functions belong to a role that cannot sign in, `idevelop_audit_owner`; the
application role keeps `SELECT` and `INSERT` only, so a stolen `DATABASE_URL`
cannot rewrite history. The role can read `employees`, `admins` and
`pii_cleanup_jobs`, which the erasure redaction and the audit-log purge check;
GDPR erasure works with the separation on.

It is **off by default**, on new installs too, because four SuperAdmin tools
are refused while it is on: Danger-Zone database cleanup, data reset, snapshot
restore and SQL-console revert. Turn it on with `-EnableAuditOwnerSeparation`
(or answer `Y` at the console during an upgrade). An upgrade keeps the state its
database is in: a separated database stays separated. `$true` / `$false` in
`config.psd1` force the choice (`$false` hands a separated database back to the
application role). A role created under the name used by earlier installers is
renamed to `idevelop_audit_owner` in place (migration 169 does the same).

### PostgreSQL hardening

Every run checks the PostgreSQL server and writes a **PostgreSQL hardening
report** to the log (`[OK]`, `[APPLIED]`, `[TO DO]`, `[FAILED]`, plus the
`trust` entries of `pg_hba.conf`). The recommended settings are:

- `log_connections = on`, `log_disconnections = on`, and a `log_line_prefix`
  that names the user, the database and the client address;
- `CONNECT` on the application database for the application role only
  (`REVOKE CONNECT … FROM PUBLIC`);
- `listen_addresses = 'localhost'`, **only** when `PgHost` is a loopback address
  (the application and PostgreSQL on the same machine). It takes effect at the
  next PostgreSQL restart.

On a server **Setup installed itself** (recorded in
`%ProgramData%\IDevelop\pg-created-by-installer.json`, which only an
administrator or SYSTEM may own) they are applied automatically, and Setup
restarts PostgreSQL when `listen_addresses` changed. On any other server Setup
changes nothing without your consent: it warns, asks at the console, or applies
them with `-ApplyPgHardening`, and never restarts that server. `pg_hba.conf` is
never changed by Setup: replace each `trust` line with `scram-sha-256` yourself.
If another application or a reporting account connects to the same database
through the `PUBLIC` privilege, grant it `CONNECT` explicitly before you apply
the hardening.

### Files the release does not ship

After the copy Setup compares the install directory with the release manifest.
Files the release does not list, outside the customer folders, are reported in
the log and in `…summary.txt` (`Manifest`): a file an older version shipped, a
hand-copied fix, a leftover. With `-EnforceManifest` they are **moved** (never
deleted) to `%ProgramData%\IDevelop\app-backups\retired-<timestamp>\`, keeping
their relative path. These folders are never looked at: `uploads`, `branding`,
`logs`, `backups`, `config`, `.env`, `certs`, `data`, `node_modules`, `tmp`,
`app-backups`, `service`, `maintenance`, `AI_Engine_Docs`, `hris`, `hris-drop`,
`imports`, `public\uploads`, `public\branding`, and `HRIS_DROP_ROOT` when it lies
inside the install directory. Keep your own files in one of them.

### The backup encryption key (after install or upgrade)

The application's daily backups, the SQL-console restore points and the
restore points of `Manage -Backup` are encrypted with a key protected by Windows
DPAPI on this machine (`%ProgramData%\IDevelop\keys`). A DPAPI key cannot leave
the machine, so its recovery copy must be exported **once** and kept offline,
apart from the backups.

Setup does both on every run:

1. `node scripts\backup-key.js init` creates the key when there is none (it
   never replaces an existing one) and gives the service account read access to
   the keyring.
2. Until the recovery copy has been exported once, Setup asks for a file path at
   the console (removable media, never the install directory) and writes it
   there. With no console, or a blank answer, it writes
   `%ProgramData%\IDevelop\keys\backup-recovery-<keyId>.txt` (SYSTEM and
   Administrators only) and warns: **move that file offline and delete it from
   the server.** The key itself never appears in the log.

By hand, from the install directory:

```powershell
cd "C:\Program Files\IDevelop"
node scripts\backup-key.js init
node scripts\backup-key.js export --out E:\idevelop-backup-recovery-key.txt
```

Without it no backup restores on another server (`backup-key.js import --in
<file>` there). Admin → Instance health warns until the key has been exported.

`Manage -Backup` writes the restore point's database dump as
`database.sql.enc`, verified, and deletes the plain dump. If the key tool fails
the restore point is refused, unless you pass `-AllowPlainBackup`; the one
exception is an installed version older than the backup key (no
`backup-key.js` yet), whose pre-upgrade restore point stays plain and is listed
`[UNENCRYPTED]`. `Manage -Restore` checks the dump (signed manifest and full
decryption) **before** it stops the service or drops the database, then
decrypts it straight into `psql`; nothing clear is written to disk. Older plain
`database.sql` points remain restorable. Details, restores and failure messages:
[docs/BACKUPS.md](../docs/BACKUPS.md).

### Release rehearsal on a Windows VM (required before shipping installer changes)

The installer's PowerShell is checked by the test suite from its source text,
and its functions are run by the tests on Windows only. Changes to the service
account, the ACLs, the PostgreSQL hardening, the release manifest or the backup
key **must be rehearsed on a clean Windows Server VM before a release**. Keep
the log, the `…summary.txt` and the transcript of each run with the release
notes.

1. **Fresh install.** On a clean VM, `Install-IDevelop.ps1` with a new
   PostgreSQL. Check: `sc.exe qc IDevelop` shows `NT SERVICE\IDevelop`; the app
   answers on `/health`; `icacls "C:\Program Files\IDevelop"` shows
   `NT SERVICE\IDevelop:(OI)(CI)(RX)` (never `M`); `icacls` on `uploads`, `tmp`,
   `logs`, `AI_Engine_Docs` and `service\logs` shows `(M)`; WinSW writes
   `service\logs\IDevelop.out.log`; the summary shows `Service acct`,
   `Audit owner : not separated`, `PG hardening` (all applied, PostgreSQL
   restarted), `Manifest : no unknown file` and `Backup key`. As that account:
   upload an evidence file, import a spreadsheet in Data Management, run
   "Back up now" and a SQL-console restore point, sign in with TLS if enabled,
   and check the audit-anchor job runs.
2. **Upgrade from the current release running as LocalSystem.** Install the
   current release, add data, then run this package with `-Migrate`. Check: the
   service stays `LocalSystem`, the log shows the `RECOMMENDED` line, no data
   is lost, `Manage -Backup` taken by Setup.bat before the upgrade is listed
   `[UNENCRYPTED]` (the old version has no key tool) and the next one is
   encrypted.
3. **`-MigrateServiceAccount`, success.** Re-run with `-Migrate
-MigrateServiceAccount`. Expect `MIGRATED`, steps
   `acl-grant:0 > sc:NT SERVICE\IDevelop > restart > healthy`, and the checks of
   step 1 passing as the virtual account (backup, upload, keyring readable).
4. **`-MigrateServiceAccount`, forced failure.** Make the virtual account fail
   its health check (for example deny it Read on `.env`, or stop PostgreSQL for
   the minute of the health check), then run the migration. Expect
   `ROLLED-BACK`: the service is back on `LocalSystem`, healthy, and
   `icacls` no longer lists the virtual account anywhere (the way back purges a
   deny entry along with the grants). Then re-run step 3.
5. **`-EnableAuditOwnerSeparation` with a GDPR erasure.** Run an upgrade with
   the switch. Check `pg_tables` owners (`idevelop_audit_owner` on
   `system_logs`), then erase a test person from the app: the erasure succeeds,
   the audit log shows « Erased person #… », the integrity check passes, and the
   four SuperAdmin tools refuse with a message. On a database that still has
   the role under the older name, the log shows `AUDIT_OWNER_RENAMED`.
6. **`-ApplyPgHardening`.** Against a PostgreSQL that Setup did not install
   (installed by hand, `log_connections` off, `listen_addresses = '*'`): an
   unattended run reports `[TO DO]` and changes nothing; with the switch,
   `[APPLIED]` (listen_addresses waits for the next restart, which Setup does
   not do); the app still connects; a second role that relied on `PUBLIC` can
   no longer connect.
7. **Manifest tamper.** Change one byte of a file under `app\`, add a file and
   delete one, then run Setup: it stops before the service is stopped, listing
   the three files. Re-extract the package. Then put a stray file in the install
   directory: it is reported; with `-EnforceManifest` it is moved to
   `app-backups\retired-<timestamp>\` and nothing in `uploads` is touched.
8. **Backup and restore round trip.** `Manage-IDevelop.ps1 -Backup`, change
   data, then `-Restore` that point: the dump is verified first, decrypted into
   `psql`, the data is back, erasures are re-applied, and no `database.sql` is
   left on disk. Corrupt the `.enc` file of a second point: `-Restore` refuses
   before stopping the service. Run `scripts\Verify-BackupRestore.ps1`. On a
   second VM, import the recovery file (`backup-key.js import --in`) and restore
   a copied backup there.

---

## Troubleshooting

The full log is at `C:\ProgramData\IDevelop\install-*.log`. The last
`STEP x/7` line before any `[ERROR]` tells you which stage failed.

- **"Cannot connect to PostgreSQL"** — wrong `-PgSuperPassword`, wrong port, the
  server doesn't allow your host in `pg_hba.conf`, or it needs TLS (`-PgSsl`).
  On an unattended run with an unknown local password, re-run with
  `-AllowPasswordRecovery` or supply the current password.
- **"INTEGRITY CHECK FAILED"** — a download did not match the SHA-256 (or the
  publisher) pinned in `config.psd1`: a proxy rewriting downloads, a truncated
  file, or a URL changed without its hash. The file was deleted and not run.
- **"Migrations failed"** — read the captured SQL error in the log. If it's
  _permission denied for schema public_, the DB pre-existed with different
  ownership; re-run the installer (it re-applies grants) or grant the app role
  manually.
- **"App did not respond"** — run it in the foreground to see the boot error:
  `cd "C:\Program Files\IDevelop"; node server.js`. Usually a bad
  `DATABASE_URL` in `.env` or a port already in use.

---

## The progress window

Every install, upgrade, migrate, repair or reinstall opens a progress window
(`Installer-Gui.ps1`) in the style of the Office installer: the product header,
"Installing IDevelop…" (or "Updating IDevelop from 1.0.0 to 1.1.0…"), the
current step ("Step 3 of 7 – PostgreSQL"), the last notable message, a bar
that keeps moving inside a long step, and a **Show details** toggle with the
full log. When the run ends it becomes the end screen — **You're all set!**
with _Open IDevelop_, or _Update failed – previous version restored_ /
_Something went wrong_ with _Open log_ — and waits for **Close**. The setup
console keeps the full text output and still takes the few prompts (postgres
password, reinstall confirmation) when they are needed.

- `-NoGui` — console progress only (scripted / unattended runs, where nobody
  presses Close). Automatically the case on a non-interactive host.
- `-GuiAutoClose <seconds>` — keep the window but close the end screen by itself.

## Default `admin` password (fresh install / full reinstall)

A **fresh database** — a fresh install or a _Full reinstall_, whether the bundled
snapshot was imported or the seed ran — gets the standard appliance admin
password from `config.psd1` (`StandardAdminPassword`), with a **change required
at first login**. The summary prints `Admin login : admin / the standard appliance
admin password`. Leave `StandardAdminPassword` blank to get a random password
shown once on the console instead (seeded DB) or the snapshot's imported
credentials (imported DB). A **patch / upgrade / migrate never touches it** —
existing logins are preserved. If `admin` cannot sign in after an install: **Setup.bat →
`A. Reset admin password`** (`Manage-IDevelop.ps1 -SetAdminPassword`) sets it
back to the standard value, change required at first login.

## Upgrading / patching an existing install

Two equivalent ways to apply a new version onto a machine that already runs
IDevelop — both **keep the database, all data and `.env`**:

```powershell
# Explicit patch mode (recommended for updates) — refuses to run if no install exists,
# never imports the bundled snapshot, and backs up the current code first for rollback:
.\Install-IDevelop.ps1 -Patch -UseExistingPostgres -PgSuperPassword 'theRealPostgresPassword'
```

```powershell
# Plain re-run (implicit upgrade) — same preservation behaviour:
.\Install-IDevelop.ps1 -UseExistingPostgres -PgSuperPassword 'theRealPostgresPassword'
```

What a patch does, in order: stops the service → **backs up the current app code**
to `C:\ProgramData\IDevelop\app-backups\app-<oldVersion>-<timestamp>\` → overlays
the new code (keeping `.env`, `node_modules`, `logs`, `data`) → installs any new
dependencies → applies only **pending** migrations (idempotent) → restarts the
service → **verifies the new version answers its health check** → reports
`installed → package` versions in the log and `…summary.txt`.

A patch **never** drops/recreates the database, never re-imports the data
snapshot, and never resets the admin password (existing logins are preserved).

### Migrate mode — version-to-version upgrade with schema proof

```powershell
# Setup.bat → option  M. Migrate (version)   — or, unattended:
.\Install-IDevelop.ps1 -Migrate -UseExistingPostgres -PgSuperPassword 'theRealPostgresPassword'
```

`-Migrate` is `-Patch` plus three guards around the database step, for moving an
**older installed version to this package** (any distance is
one run):

1. **Pre-flight** (`npm run db:migrate:preflight`) before anything touches the
   database: lists the migrations this package ships, what `schema_meta` already
   holds, and exactly what will be applied. It **refuses a downgrade** (exit 2,
   `MIGRATE REFUSED`) when the database already carries a migration number this
   package does not ship — i.e. it was produced by a NEWER version — before a
   single statement runs.
2. The normal migration pass (`db:migrate:all`, idempotent, each file in its own
   transaction, tracked in `schema_meta`).
3. **Post-flight** (`db:migrate:postflight`) proves nothing is left pending; the
   log ends with `MIGRATE: schema verified - nothing pending; <old> to <new>.`

"Pending" means exactly what the runner means: a `.sql` file in `db\postgres`
whose key (file name without `.sql`) is absent from **any** `schema_meta` row.
A prerequisite script an operator once applied by hand and recorded there (for
example `01a_enum_prereqs`) is therefore honoured, not re-applied — even though
its file still sits in the install directory (the installer overlays code and
never deletes stale files). If the post-flight ever fails after a successful
migration pass, the database already carries the new schema: **re-run Migrate**
(pre-flight will show 0 pending) rather than keeping the rolled-back version.

Everything else is the patch contract: `.env`, the database, its data, the
`postgres` superuser password and the application role password are **kept**
(the app password is re-read from the existing `.env`; the superuser password is
the one from `config.psd1`), the previous code is backed
up first, and a failed run rolls back automatically. Because every schema change
is a numbered, idempotent, `schema_meta`-tracked file, the same mode migrates
this install to **every later version** as well — a newer package simply applies
the files this database has not seen yet.

`-Migrate` cannot be combined with `-SkipMigrations` (that would defeat the proof).

### Automatic rollback (self-healing upgrades)

When upgrading/patching an **existing** install, rollback is **automatic**: if the
new version fails to deploy (npm/migration error) or fails its post-deploy health
check, the installer restores the pre-upgrade backup over the install directory,
reconciles dependencies, restarts the service and re-verifies health — so the box
is never left down on a bad build. The console then shows
`NEW VERSION FAILED … AUTOMATIC ROLLBACK SUCCEEDED` and `…summary.txt` records
`Auto-rollback : YES …`. The exit code is still non-zero (the upgrade did not
apply) so CI/automation notices, but the service is back UP on the previous
version.

- Opt out with **`-NoRollback`** to leave the failed build in place for inspection
  (the backup is still created).
- **Manual rollback** (e.g. to undo an upgrade that _did_ come up healthy): stop the
  app host, copy the backed-up `app-…` folder back over the install directory, then
  restart it — `Start-Service IDevelop` for the default WinSW service host, or
  `Start-ScheduledTask IDevelop` if hosted as a Scheduled Task. (Roll the DB back from
  your own PostgreSQL backup only if a migration must be undone.)

> `-Repair` is different: it force-rebuilds `node_modules` and regenerates a
> broken `.env`. Use `-Patch` for routine version updates; `-Repair` to fix a
> partial/corrupt install.

## The setup wizard

Double-clicking `IDevelop-Setup-<version>.exe` now opens a wizard, not a console
menu. It follows the Windows 11 visual language (system light/dark, Segoe UI
Variable, rounded cards, a single primary action, Enter and Esc wired up).

**First install on a machine**

`Welcome` (what setup will do, where it goes, the database and web address, plus
an Options panel: Start Menu shortcuts, firewall rule, open when finished)
→ `License` (the product licence with an explicit "I accept")
→ `Progress` (the creeping bar, step text and a details log)
→ `Finish` (Open IDevelop / Open log / Close).

Nothing on the machine is touched until the action button is pressed. Cancel
exits **1602**, the Windows code for "cancelled by the user".

**Machine that already has the product** — the maintenance chooser, which offers
every operation this package supports, so nobody needs to know that `Setup.bat`,
`Manage-IDevelop.ps1` and `Uninstall-IDevelop.ps1` exist:

| Group              | Action                        | Runs                                                                                                                                      |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Recommended        | Update to version X           | `Install -Migrate` (code + pending migrations)                                                                                            |
| Recommended        | Update application files only | `Install -Patch -SkipMigrations` (refused when the package carries a migration the database has not applied; `db\postgres` is not copied) |
| Recommended        | Repair this installation      | `Install -Patch`                                                                                                                          |
| Data               | Back up now                   | `Manage -Backup`                                                                                                                          |
| Data               | Restore a previous version    | `Manage -Restore`                                                                                                                         |
| Data               | List restore points           | `Manage -List`                                                                                                                            |
| Tools              | Check the database            | `Manage -CheckDb`                                                                                                                         |
| Tools              | Reset the admin password      | `Manage -SetAdminPassword`                                                                                                                |
| Tools              | Set the PostgreSQL password   | `Manage -SetPgPassword`                                                                                                                   |
| Remove and replace | Reinstall from scratch        | `Install -Reinstall` (destructive)                                                                                                        |
| Remove and replace | Uninstall                     | `Uninstall-IDevelop.ps1`                                                                                                                  |

Destructive actions are flagged in colour and never pre-selected. The chooser
and the dispatcher are `Setup-Wizard.bat` → `Setup-Wizard.ps1`; pass
`-Action <id>` to skip the chooser and run one directly.

### The modern interface is the only interface

The console menu is not an offered choice. It is a **rescue
path**, not a route a user can take by accident:

- `Setup.bat` hands over to `Setup-Wizard.bat` as soon as it sees a desktop and
  WPF, so double-clicking it opens the wizard rather than the text menu.
- The chooser no longer lists an "Advanced text menu" row.
- The menu is reached only when the window **cannot** open — no desktop, RDP
  without WPF, Server Core — or when `-Action menu` is typed deliberately.

It still ships, because deleting it would leave those machines with no way to
install at all. `SETUP_VIA_WIZARD=1` is the marker the wizard sets before
calling `Setup.bat`; without it the two would hand the job back and forth for
ever.

`Install-IDevelop.ps1 -Wizard` shows the Welcome/License gate on its own;
without it the window is progress-only, which is what every unattended call and
the rescue menu still get. `-NoGui` disables the window entirely and exists for
machines with no desktop, not as a quicker deployment mode.

## Windows integration

A completed install now declares itself to Windows the way a per-machine
application is expected to:

| What                            | Where                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Apps & features** entry       | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\IDevelop` — name, version, publisher, install location and date, measured size, icon, help and about links |
| **Uninstall / Quiet uninstall** | `UninstallString` and `QuietUninstallString` (the `-Silent` form Settings and management tools prefer)                                                               |
| **Modify / repair**             | `ModifyPath` opens the **modern maintenance window** (`Maintain-IDevelop.ps1`); `NoModify`/`NoRepair` are 0                                                          |
| **Start Menu**                  | `%ProgramData%\...\Start Menu\Programs\IDevelop` — the app (a `.url` to `http://localhost:3000/`), Maintenance, and Uninstall                                        |
| **Servicing copy**              | `<InstallDir>\maintenance\` holds the uninstaller, `config.psd1`, the maintenance script, `Maintain-IDevelop.ps1` and `Installer-Gui.ps1`                            |
| **Application icon**            | `<InstallDir>\public\icons\idevelop.ico`, generated at build time from `icon-512.png` at 6 sizes                                                                     |

Why the servicing copy exists: the `UninstallString` must point at a path that
survives. The extracted package under `%ProgramData%\IDevelop\installer` is
wiped by the next run, so an entry pointing there would break as soon as the
product was updated. The uninstaller detects that it is running from inside the
install directory and re-executes itself from a temp copy, so it can delete the
tree it was launched from.

Registration happens **after** the health check, so an install that fails and
rolls back never leaves an entry advertising a version that is not there.

### Modify opens the same modern window

`Modify` used to run `Manage-IDevelop.ps1` with no arguments, which printed a
one-line console usage message and quit — a console interface, reached from
Windows' own UI, that did nothing. It now runs `Maintain-IDevelop.ps1`, the
maintenance chooser in **servicing mode**.

A servicing copy has no application payload, so the four actions that deploy
code (update, files-only, repair, reinstall) are removed from the list rather
than offered and then failed; the window says to run the setup package for the
version you want. What remains is what the copy can honestly do: back up,
restore, list restore points, check the database, reset the admin password, set
the PostgreSQL password, uninstall. `-Action <id>` runs one directly, and the
script waits for its own elevated run so the exit code it returns is the real
one (0 / 1602 cancelled / 1603 error).

On a machine with no desktop the window cannot open; the script then prints the
exact `Manage-IDevelop.ps1` commands to run instead of pretending.

## Uninstall

From **Settings → Apps**, from the Start Menu, or directly:

```powershell
.\Uninstall-IDevelop.ps1
```

```powershell
.\Uninstall-IDevelop.ps1 -Silent -RemoveDatabase -PgSuperPassword 'pgpass' -RemoveData
```

An interactive run lists what will be removed and what will be kept, then
requires typing `YES`. Removed: the service, the firewall rule, the Start Menu
folder, the Apps & features entry and the install directory. Kept unless asked:
the database (`-RemoveDatabase`) and `%ProgramData%\IDevelop` logs and backups
(`-RemoveData`). Node.js and PostgreSQL are always left installed (they may be
shared).

Exit codes follow the Windows convention: `0` success, `1602` cancelled by the
user, `1603` fatal error — including a `-RemoveDatabase` that could not be
carried out, which is a partial removal and must not report success.

## What the package does NOT ship

The payload is the product only. Lint/format/commit configuration, container
recipes, developer batch helpers, test output, internal notes and the
requirements document are excluded at build time (`$excludeFiles` /
`$excludeDirs` in `Build-Package.ps1`), alongside the long-standing exclusions
for `node_modules`, `tests`, `docs` and the dev-only credential seeders. A
production `Program Files` should contain nothing an operator could mistake for
something to run.

- The repository's CI secret-scan configuration (`.gitleaks.toml`) and the
  container ignore file (`.dockerignore`) never ship.
- The project root is an allow-list covering every extension: each entry either
  ships (`$shipRootFiles` / `$shipRootDirs`) or is excluded. Any other file or
  folder left at the root (an export, a query result, a scratch note) fails the
  build. A git worktree's `.git` file is excluded like the `.git` folder.
- `uploads\` ships empty: a file in it on the build machine fails the build.
- A package built with `-IncludeData` excludes the data of every secret table
  (sessions, reset tokens, SAML caches, MFA secrets, API keys, SSO links, sign-in
  history, LMS / webhook / HRIS connector credentials), then reads the dump and
  fails the build if any of those tables still carries a row.
