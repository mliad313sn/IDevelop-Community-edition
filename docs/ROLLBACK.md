# Rolling back an upgrade, and recovering a lost server

This page is for whoever runs an IDevelop server on Windows. It says how to go
back to the previous version after an upgrade that came up healthy but must be
undone, and how to rebuild the service on a new server. Security record: SA-57
in [SECURITY-AUDIT.md](SECURITY-AUDIT.md). Backups, keys and restores in
general: [BACKUPS.md](BACKUPS.md). The installation package carries both pages
in its `docs\` folder. Print this page and attach it to the change record of
every upgrade.

## Which situation you are in

| Situation                                                            | What happens, what to do                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The upgrade **failed** (npm, migration, health check)                | Setup rolls the code back by itself and restarts the previous version (`Auto-rollback : YES` in the summary). If the failure came **before** the migrations (for example the pre-migration dump), the database was not touched. If a migration failed, read [§ A migration failed](#a-migration-failed) below. |
| The upgrade **succeeded** but a blocking defect makes you go back    | Follow [§ Going back to the previous version](#going-back-to-the-previous-version).                                                                                                                                                                                                                            |
| `Setup.bat` took a restore point before the upgrade (`Manage -List`) | `Manage-IDevelop.ps1 -Restore -RestorePoint <name>` restores the code and the database of that point in one step (it checks the dump first and re-applies the erasures). The steps below do the same from the pre-migration dump, and keep the newer database aside instead of dropping it.                    |
| The server is lost                                                   | Follow [§ Recovering on a new server](#recovering-on-a-new-server).                                                                                                                                                                                                                                            |

**Data entered after the upgrade is lost by a rollback.** The database goes
back to the dump taken just before the migrations. Tell the users before you
start, and list what they will have to enter again.

## What Setup leaves for the way back

Every upgrade of an existing install leaves two things, both named in the
installation summary (`…summary.txt`):

| Summary line    | What                                                                                                                                                                     | Where                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `DB dump (pre)` | the database as it was just before the first migration: `pg_dump -Fc`, encrypted with the backup key and verified (`pg_restore --list` on the decrypted stream) by Setup | `%ProgramData%\IDevelop\backups\pre-upgrade-<db>-<old>-to-<new>-<stamp>.dump.enc` (+ `.manifest.json`) |
| `Code backup`   | the previous version's code, with its `.env`, without `node_modules`, `uploads`, `backups`, `data` and `logs`                                                            | `%ProgramData%\IDevelop\app-backups\app-<old>-<stamp>\`                                                |

If the dump cannot be taken (no backup key, `pg_dump` error, not enough disk
space, verification refused), Setup **stops before any migration**: the
database is unchanged and the previous code is put back. Fix the cause and run
Setup again. `-SkipPreMigrationDump` goes past it, logged as a warning, for a
very large database that already has its own verified backup; then this page
does not apply and your own backup is the only way back.

The daily backup's retention never removes a `pre-upgrade-*` dump. Delete old
ones yourself once the version they lead back to is no longer a candidate.
Setup keeps the newest `AppBackupKeep` code copies (5 by default, `config.psd1`)
and logs each one it removes.

## Before you start

- The path of the pre-migration dump (summary line `DB dump (pre)`, or the
  newest `pre-upgrade-*-to-<new>-*.dump.enc`) and its `.manifest.json` beside it.
- The installation package of the **previous** version, if you still have it.
- The PostgreSQL superuser (`postgres`) password, and `DbName` and `DbUser`
  from `config.psd1` (defaults `idevelop`, `idevelop_app`).
- An administrator PowerShell console in the install directory
  (`C:\Program Files\IDevelop` by default). `$pg` below stands for the
  PostgreSQL `bin` folder, for example `C:\Program Files\PostgreSQL\17\bin`.
- Never put a password on a command line: set `$env:PGPASSWORD` in the console
  and clear it at the end.

## Going back to the previous version

Count about a quarter of an hour for a database of a few hundred MB.

1. **Stop the service:** `Stop-Service IDevelop` (or
   `Stop-ScheduledTask IDevelop` when it runs as a Scheduled Task).
2. **Check the dump** before anything else is changed:

    ```powershell
    node scripts\backup-key.js verify --in "<dump>.dump.enc" --pg-restore "$pg\pg_restore.exe"
    ```

    It must end with exit code 0 and print `"pgRestoreList": "ok (… TOC entries)"`.
    If it does not, **stop here**: restart the service on the new version and
    treat the dump as unusable (see [BACKUPS.md](BACKUPS.md), "When a backup
    will not restore").

3. **Set the current database aside.** Nothing is deleted:

    ```powershell
    $env:PGPASSWORD = Read-Host 'postgres password'
    & "$pg\psql.exe" -U postgres -d postgres -c "ALTER DATABASE idevelop RENAME TO idevelop_rolled_back"
    ```

    If sessions are still open, end them first:
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'idevelop'`.

4. **Create an empty database** with the same owner:
   `& "$pg\psql.exe" -U postgres -d postgres -c "CREATE DATABASE idevelop OWNER idevelop_app"`
5. **Restore the dump.** The decrypted stream goes straight into `pg_restore`;
   no clear copy is written:

    ```powershell
    node scripts\backup-key.js pipe --in "<dump>.dump.enc" --run "$pg\pg_restore.exe" -U postgres -d idevelop --exit-on-error
    ```

    Exit code 0 is expected.

6. **Remove the newer migration files.** A copy back never deletes, and the
   service applies at start-up every numbered file in `db\postgres` that the
   database has not recorded. Delete the ones the code copy does not carry:

    ```powershell
    $copy = "$env:ProgramData\IDevelop\app-backups\app-<old>-<stamp>"
    Get-ChildItem .\db\postgres -Filter *.sql | Where-Object { -not (Test-Path (Join-Path "$copy\db\postgres" $_.Name)) } | Remove-Item
    ```

7. **Put the previous code back.** With the previous package: run its
   `Setup.bat` and choose the upgrade (or
   `Install-IDevelop.ps1 -Patch -UseExistingPostgres`). The database is back at
   that version, so its pre-flight has nothing to refuse; it restores the code
   and dependencies and restarts the service after a health check. Without the
   package: `robocopy "$copy" . /E`, then `npm ci --omit=dev --ignore-scripts`,
   then `Start-Service IDevelop`. Keep users out until step 8 is done: the
   restored database holds again the people erased after the dump.
8. **Re-apply the GDPR erasures** made after the dump was taken:
   `node scripts\reapply-erasures.js`. Exit code 0 means nothing is left to
   erase again; 1 lists the people it could not erase (handle them before the
   users come back).
9. **Check:** `/health` answers 200, Administration → About shows the previous
   version, Admin → Instance health lists no pending migration, and a test
   account signs in.
10. **Clear the password** (`Remove-Item Env:PGPASSWORD`) and keep
    `idevelop_rolled_back` until the defect is understood. Dropping it is the
    data owner's decision, never an automatic step.

## A migration failed

Each migration file runs in its own transaction, so a failed file leaves no
half-applied change of its own, but the files before it in the same run are
applied. Setup puts the previous code back; the summary says the upgrade did
not apply. Then either fix the cause and run the **new** package again (its
pre-flight shows what is still pending), or go back fully with the steps above:
the pre-migration dump is from before the first file of the run.

## Recovering on a new server

| What                        | Where it lives                                                             | How to get it back                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The database                | the newest daily backup, or its off-host copy (`BACKUP_OFFHOST_DIR`)       | Fresh install of the **same version** on the new server, `node scripts\backup-key.js import --in <recovery file> --current`, then steps 1 to 5 and 8 above with that backup                                                                |
| The backup key              | the recovery file kept offline when the server was installed               | Without it no backup can be read on another server. Check every quarter that it is where you think it is                                                                                                                                   |
| Evidence and uploaded files | `<InstallDir>\uploads` (not in the code copies, not in the database dumps) | Your organisation's file backup must include it                                                                                                                                                                                            |
| Configuration               | `.env`, `config.psd1`                                                      | Setup writes a new `.env`; enter SMTP, SSO and the other integration settings again from your own records. Keep an offline copy of the `APP_KEY` line: it opens the secrets stored in the database (and, on Linux and Docker, the backups) |

If the old server ran with audit-trail ownership separation, run the fresh
install with `-EnableAuditOwnerSeparation` so the owner role exists before the
restore.

Indicative targets: up to 24 hours of data lost (one daily backup), and half a
day to recover once the replacement server and the recovery key are at hand.
Measure your own on a copy before you rely on them.

## Rehearse it

Rehearse this page on a copy before the first real upgrade, and after any
change to the installer: the steps are part of the Windows VM checklist in
[installer/README.md](../installer/README.md) ("Release rehearsal on a Windows
VM"). Compare the people, skills, assessments, `schema_meta` and the table list
before the upgrade and after the rollback: they must be identical.
