# IT operations guide

This page is for the IT operator who keeps an IDevelop server running once it
is in production: what runs, when the background jobs fire, where the logs
are, how backups and restores are checked, which settings tune the server, and
how an upgrade is carried out. It assumes the installation is done
([installer/README.md](../installer/README.md) on Windows,
[README.md](../README.md#quick-start) for Linux and Docker) and the go-live
checklist is signed ([GO-LIVE.md](GO-LIVE.md)).

Related pages: [BACKUPS.md](BACKUPS.md) (backup keys, restore by hand),
[ROLLBACK.md](ROLLBACK.md) (going back after an upgrade, recovering on a new
server), [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md) (security incidents and
personal-data breaches), [SIZING.md](SIZING.md) (sizing and the model cache),
[POWERBI.md](POWERBI.md) (the Power BI feeds), [HRIS-SYNC.md](HRIS-SYNC.md)
(HRIS connectors).

## What runs

| Component         | Windows package                                                                                                                                 | Linux (Node.js)                                           | Docker Compose                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| The application   | the `IDevelop` Windows service (WinSW), or a Scheduled Task of the same name, running Node.js from `<InstallDir>` (`C:\Program Files\IDevelop`) | `npm start` under your process manager                    | the `app` service                        |
| The database      | the PostgreSQL service the installer created or reused                                                                                          | your PostgreSQL 16 or later                               | the `db` service and its `pgdata` volume |
| Background jobs   | inside the application process (see [Jobs and schedules](#jobs-and-schedules))                                                                  | same                                                      | same                                     |
| Redis (optional)  | Memurai, only if `REDIS_URL` is set                                                                                                             | Redis, only if `REDIS_URL` is set                         | add a service and set `REDIS_URL`        |
| External watchdog | `scripts\Health-Watchdog.ps1`, registered by you as a Scheduled Task (every 5 minutes; mails IT when `/health` stops answering; see its header) | your monitoring                                           | your monitoring                          |
| Data on disk      | `%ProgramData%\IDevelop` (backups, keys, audit anchors, logs) and `<InstallDir>\uploads` (evidence files)                                       | the application's `uploads`, `backups` and `data` folders | the `appdata` volume                     |

The application listens on `PORT` (3000 by default). Put a reverse proxy with
TLS in front of it and set `TRUST_PROXY` to that proxy.

## Health and monitoring

| Probe                             | Who may call it                                                         | What it says                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /health` (`/healthz`)        | anyone                                                                  | the process answers (status only)                                                                |
| `GET /readyz` (`/health/ready`)   | anyone                                                                  | the process answers and the database is reachable (status only)                                  |
| `GET /metrics`                    | loopback, `METRICS_ALLOW_IPS`, or `Authorization: Bearer METRICS_TOKEN` | service details for your monitoring                                                              |
| Instance health (`/admin/health`) | a SuperAdmin                                                            | pending migrations, every job's last run and failures, the backup state and the next backup time |

A job that fails, or a daily job that has not run for 36 hours, raises an
`ops.job_failed` notification to every SuperAdmin. Security events (emergency
access sign-in, a SuperAdmin's second factor or password changed, a locked
administrator account) reach every SuperAdmin at once, by e-mail too. Make sure
at least two SuperAdmins read their mail.

## Jobs and schedules

The jobs run inside the application. Without Redis, one process holds a
PostgreSQL advisory lock and runs them on timers; with `REDIS_URL` set, they
are BullMQ repeatable jobs and several instances can share them. Both modes read
the same list (`src/jobs/index.js`). Most jobs wake every hour and decide for
themselves whether there is work today, so a server restarted at any time
catches up on its next tick. Every run is recorded and shown on Instance health.

| Every                  | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 minutes              | single sign-on migration invitations (waits while SSO is not live)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 15 minutes             | dispute deadlines and escalation, snoozed notifications released, scheduled reports that are due, the safety-competency gate, uploads waiting for the antivirus                                                                                                                                                                                                                                                                                                                                               |
| hour, real work hourly | LMS catalogue and completions (only with an LMS integration)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| hour, once a day       | database backup (first tick after `backupHour`, default 2 AM), audit-chain anchor, audit seals and retention, retention purge (report-only until `retentionPurgeMode` = `apply`), indicator snapshots, indicator alerts (after `KPI_ALERTS_HOUR`, default 6), fit history, certificate expiry, coverage rules, retention-risk sweep, campaign deadlines, campaign reminders, the daily notification summary, reminders, 360° feedback rounds, telemetry pruning, HRIS synchronisation (only with a connector) |
| hour, weekly or longer | manager digest, department digest and brief, planning digest, succession review, « What changed » summaries (only with `personaDigestsEnabled`)                                                                                                                                                                                                                                                                                                                                                               |

Hours are the server's local time. `BACKUP_HOUR` (or the `backupHour` setting),
`KPI_ALERTS_HOUR` and `AUDIT_ANCHOR_HOUR` move the daily ones. Do not stop the
application during the backup hour without a reason: the backup then runs at
the next tick.

## Logs

| What                                                  | Windows package                                                 | Linux                                        | Docker                    |
| ----------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| Application output (`LOG_LEVEL`, default `info`)      | `<InstallDir>\service\logs` (WinSW)                             | your process manager                         | `docker compose logs app` |
| Installation and upgrade runs                         | `%ProgramData%\IDevelop\install-<stamp>.log` and `…summary.txt` | —                                            | —                         |
| `Setup.bat` menu choices                              | `%ProgramData%\IDevelop\logs\setup-session.log`                 | —                                            | —                         |
| PowerShell transcripts of the installer               | `%ProgramData%\IDevelop\transcripts`                            | —                                            | —                         |
| Audit trail (who did what in the application)         | the `system_logs` table, read in System Logs (`/system-logs`)   | same                                         | same                      |
| Daily anchor of the audit chain, outside the database | `%ProgramData%\IDevelop\audit-anchors\chain-head.log`           | `data/audit-anchors` (or `AUDIT_ANCHOR_DIR`) | on the `appdata` volume   |

The application output never carries passwords, tokens or keys. It can carry
identifiers of people and request paths: keep it on the server, restrict it to
the operators, and give it a retention in your log platform. The audit trail is
append-only and hash-chained; it is kept for `auditLogRetentionYears` (5 by
default) and then purged in sealed steps.

## Backups and restores

The full description is in [BACKUPS.md](BACKUPS.md). What the operator does:

| When                 | Action                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every morning        | Instance health shows last night's backup as done and verified. The « Last backup verified » line of `/setup` says the same.                                             |
| Every week           | The off-host copy (`BACKUP_OFFHOST_DIR`) holds the same files as the backup folder.                                                                                      |
| Every quarter        | A restore drill (below), and a check that the offline recovery copy of the backup key is where the register says it is.                                                  |
| Before every upgrade | Free space on the backup volume: the table data of the database plus 256 MB (the Windows installer refuses to migrate without its dump).                                 |
| After every upgrade  | The `pre-upgrade-*` dump named in the summary exists. Delete older ones yourself once the version they lead back to is no longer a candidate: no retention removes them. |

The evidence files (`<InstallDir>\uploads`, or `uploads/`) are not in the
database dumps nor in the code copies. Your file backup must cover them.

### Restore drill

On Windows, run the drill shipped with the package. It verifies the newest
backup, restores it into a scratch database, checks the core tables and drops
the scratch database; the live database is never touched:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\IDevelop\scripts\Verify-BackupRestore.ps1"
```

Exit code 0 means the backup restores. Anything else: read the output, then
[BACKUPS.md](BACKUPS.md), "When a backup will not restore". On Linux or Docker,
restore by hand into a scratch database as described in
[BACKUPS.md](BACKUPS.md), "Restore by hand", and drop it afterwards. Write the
date and the result in your operations record.

## Settings an operator tunes

These live in `.env` (or the service environment) and need a restart. The rest
of the configuration is in App Settings.

| Variable                                                                                    | Default                      | Purpose                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_MODEL_CACHE`                                                                     | on (off in tests)            | `0` turns off the per-reader cache of the dashboard, the manager's home and the board pack.                                     |
| `DASHBOARD_MODEL_CACHE_TTL_MS`                                                              | `300000` (5 min)             | The longest a reader's model is kept when nothing is saved. Any successful save drops the cache of the process that handled it. |
| `DASHBOARD_MODEL_CACHE_MAX_ENTRIES`                                                         | `600`                        | Entries kept per process; the least recently used goes first.                                                                   |
| `REDIS_URL`                                                                                 | unset                        | Background jobs on BullMQ instead of in-process timers.                                                                         |
| `BACKUP_HOUR`, `BACKUP_DIR`, `BACKUP_OFFHOST_DIR`, `BACKUP_KEY_MODE`, `BACKUP_KEYRING_FILE` | see [BACKUPS.md](BACKUPS.md) | The daily backup.                                                                                                               |
| `KPI_ALERTS_HOUR`, `AUDIT_ANCHOR_HOUR`, `AUDIT_ANCHOR_DIR`                                  | `6`, `1`, see above          | Daily jobs.                                                                                                                     |
| `METRICS_ALLOW_IPS`, `METRICS_TOKEN`                                                        | unset                        | Who may read `/metrics` besides loopback.                                                                                       |
| `LOG_LEVEL`                                                                                 | `info`                       | Application output.                                                                                                             |
| `SQL_CONSOLE_ENABLED`                                                                       | unset (off)                  | The SQL console. Leave it off except for a planned intervention.                                                                |

The model cache lives in each Node.js process. With one process (the Windows
package, a single container) a save is seen at once. With several instances
behind a load balancer, a save made through one instance reaches the others'
readers after at most the TTL: lower `DASHBOARD_MODEL_CACHE_TTL_MS` there, or
set `DASHBOARD_MODEL_CACHE=0`. The cache never mixes two readers; how it is
keyed and sized is in [SIZING.md](SIZING.md).

## Upgrades

Read the « Upgrade » line of every [CHANGELOG.md](../CHANGELOG.md) entry
between your version and the new one before you start: it lists the
migrations, the settings that change on upgrade and what users will notice.

### Windows

`Setup.bat`, option **2** « Upgrade (APP + DB) » or **M** « Migrate (version) »
(option 1 « Patch » refuses a package that carries a migration not yet
applied; unattended: `Install-IDevelop.ps1 -Patch` or `-Migrate`, see [installer/README.md](../installer/README.md), "Upgrading /
patching an existing install"). Setup takes a code copy and an encrypted,
verified dump of the database before the first migration, applies the pending
migrations, restarts the service and checks its health; a failed step puts the
previous code back. The package builds its own third-party notices and carries
its dependencies offline. Going back after a successful upgrade:
[ROLLBACK.md](ROLLBACK.md).

### Linux (Node.js)

1. Take a backup and verify it (`node scripts/backup-key.js verify --in <file>`).
2. Stop the application, put the new release in place, then
   `npm ci --omit=dev`.
3. `npm run db:migrate:preflight` lists what will be applied;
   `npm run db:migrate:all` applies it (the application also applies pending
   migrations at start-up).
4. `npm run notices:build` writes the third-party notices served at
   `/about/third-party-notices` (the Docker image and the Windows package do
   this when they are built).
5. Start the application, then `npm run db:migrate:postflight`: it must report
   nothing pending.

### Docker Compose

Back up the `pgdata` and `appdata` volumes, rebuild or pull the image
(`docker compose up -d --build`), and read `docker compose logs app`: the
migrations run when the container starts.

### After any upgrade

- Instance health: no pending migration, no failed job.
- A test account of each kind (employee, manager, administrator) signs in.
- The settings the changelog says were changed on upgrade are what your
  organisation wants (the ones changed by the 4.0.0 port also leave a notice
  to every SuperAdmin).

## Power BI feeds: version 1 is being withdrawn

Two Power BI feeds have a version 2 with a corrected shape:

| Version 1 (deprecated)     | Version 2                     | What changed                                                                                   |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/powerbi/readiness`   | `/api/powerbi/v2/readiness`   | a readiness state instead of a yes/no that read « not ready » for people not yet assessed      |
| `/api/powerbi/assessments` | `/api/powerbi/v2/assessments` | the level the indicators count: empty while not assessed, never credited above the requirement |

A version 1 feed keeps its columns for one release and answers with the
headers `Deprecation: true` and a `Link` to its successor; the release after
that removes it. Before you upgrade to that release, list the reports and the
API keys that still read version 1 (ask the report owners; the gateway or proxy
log shows the paths called) and move them. The columns of both versions are in
[POWERBI.md](POWERBI.md).

## Third-party notices

`/about/third-party-notices` serves `THIRD-PARTY-NOTICES.txt`, written from the
production dependencies when the Docker image or the Windows package is built.
A copy installed from source has no such file until `npm run notices:build` is
run once after `npm ci --omit=dev`, and after each dependency change, followed
by a restart; until then the page says how to write them.

## Routine

| When          | Who         | What                                                                                                       |
| ------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Daily         | IT operator | Instance health; the watchdog's mails; free disk space on the data and backup volumes.                     |
| Weekly        | IT operator | The off-host copy; operating-system and PostgreSQL updates in your maintenance window.                     |
| Monthly       | SuperAdmin  | System Logs for unusual denials or sign-in failures; the running safety-gate waivers.                      |
| Quarterly     | IT operator | Restore drill; the backup key's recovery copy; the release notes of IDevelop for security fixes.           |
| Quarterly     | SuperAdmin  | The access review of administrators (`/admin/access-review`); the « Ready for go-live » block still green. |
| Every upgrade | IT operator | The steps above, the changelog's upgrade lines, the rollback runbook at hand.                              |
