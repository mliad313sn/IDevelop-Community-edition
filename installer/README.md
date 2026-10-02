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

| Option                   | Purpose                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `-InstallDir <path>`     | Install location (default `C:\Program Files\IDevelop`)                                                      |
| `-AppPort <n>`           | App HTTP port (default `3000`)                                                                              |
| `-PgSuperPassword <pw>`  | postgres superuser password (required when reusing PG)                                                      |
| `-UseExistingPostgres`   | Force reuse mode (never install PG)                                                                         |
| `-PgHost`, `-PgPort`     | Target an existing PostgreSQL                                                                               |
| `-PgSsl`                 | Connect to PostgreSQL over TLS                                                                              |
| `-SkipFirewall`          | Don't add the firewall rule                                                                                 |
| `-NoService`             | Deploy + configure DB but don't register/start the service                                                  |
| `-ServiceMode <m>`       | `Service` (real Windows service), `ScheduledTask`, or `Auto` (default)                                      |
| `-UseScheduledTask`      | Shortcut for `-ServiceMode ScheduledTask`                                                                   |
| `-AllowPasswordRecovery` | Allow the temporary `pg_hba.conf` trust window that resets an unknown local `postgres` password (see below) |

Defaults live in **`config.psd1`**.

### Service hosting (Windows service vs Scheduled Task)

The app is hosted as a background, auto-start, **restart-on-failure** process. Node
itself is not SCM-aware, so a _real Windows service_ is created via the tiny
**WinSW** wrapper (`github.com/winsw/winsw`) — it appears in `services.msc` /
`Get-Service`, runs as `LocalSystem`, restarts on crash, and rolls its stdout/stderr
logs under `…\IDevelop\service\`.

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
  it never appears in the process list, crash dumps or EDR process logs.
- **Read-only warnings.** Setup and `Manage-IDevelop.ps1 -CheckDb` report any
  `trust` entry in `pg_hba.conf` (passwordless login, never changed by Setup) and
  an unsynchronised Windows clock (TOTP codes, session expiry and audit
  timestamps depend on it). Setup changes the Windows Time service only if you
  type `Y` when asked.
- **Firewall rules.** Every rule Setup creates carries the Group `IDevelop`. On
  each run, rules for ports no longer in use, duplicates and older untagged
  rules are removed; the uninstaller removes every rule of the group.
- **Service logs.** The `service\` folder (the wrapper's stdout / stderr logs)
  is restricted to SYSTEM, Administrators and the service account before the
  service writes its first line.

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
