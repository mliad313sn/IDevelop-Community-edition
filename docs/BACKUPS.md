# Database backups: encryption, keys and restores

This page is for whoever runs an IDevelop server. It covers the daily database
backup, the SQL-console restore points, the key that encrypts them, and what to
do when a backup will not restore. Security record: SA-39 in
[SECURITY-AUDIT.md](SECURITY-AUDIT.md).

**The rule to remember: a backup whose key is lost is lost.** Encryption protects
a copy of the HR database that leaves the server. It also means the key must be
kept as carefully as the backups, and apart from them.

## What is written

| File                                                                      | Written by                                    | Content                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `<db>-<date>.dump.enc`                                                    | the daily `db-backup.tick` job, "Back up now" | `pg_dump -Fc` output, encrypted as it is produced: no clear copy ever touches the disk |
| `<db>-<date>.dump.enc.manifest.json`                                      | same                                          | SHA-256 and size of the file, key id, app version, signed (HMAC) with the backup key   |
| `sql-restore-points/<db>/<name>.dump.enc` (+ manifest, + `.json` sidecar) | the SQL console before a destructive script   | same format                                                                            |
| `<db>-<date>.dump` (no `.enc`)                                            | versions before SA-39                         | plaintext; kept, listed as **not encrypted**, removed by the usual retention           |
| `restore-points/rp-<version>-<date>/database.sql.enc` (+ manifest)        | `Manage-IDevelop.ps1 -Backup` (Windows)       | plain `pg_dump` encrypted with the same key, then the plain file deleted (SA-54)       |

The format is a chunked AES-256-GCM stream: every file has its own random data
key, wrapped by the backup **master key**. Chunks cannot be altered, reordered,
dropped or appended without the restore refusing the file. The file starts with
the 8 bytes `IDVBKENC`.

If no key can be had, **no backup is written** (the job fails and alerts). A
backup is never written in clear as a fallback.

## Where the master key lives

| Platform                                    | Key                                                  | Where                                                                                            |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Windows (installer)                         | 32 random bytes, protected with DPAPI (LocalMachine) | `%ProgramData%\IDevelop\keys\backup-keyring.json` (SYSTEM, Administrators, service account Read) |
| Linux, Docker, or `BACKUP_KEY_MODE=derived` | HKDF-SHA256 of `APP_KEY`                             | nothing to store: `APP_KEY` in `.env` is the key                                                 |

The **keyring** file (`BACKUP_KEYRING_FILE`; default `%ProgramData%\IDevelop\keys`
on Windows, `<app>/data/keys` elsewhere, `/app/data/keys` in the Docker image)
also holds older keys: keys retired by an `APP_KEY` rotation and recovery copies
imported from another server. On Linux and Docker those entries are wrapped
under the current `APP_KEY`; they never sit in the file in clear.

Production on Windows fails closed when DPAPI is unavailable. In development a
Windows machine falls back to the derived key, with a warning.

## What to keep offline, apart from the backups

- **Windows:** the recovery copy of the key, once, right after installation.
  The Windows installer does it for you: every run calls `backup-key.js init`
  (it never replaces an existing key), and until the copy has been exported it
  asks for a file path at the console (removable media, never the install
  directory) or, unattended, writes
  `%ProgramData%\IDevelop\keys\backup-recovery-<keyId>.txt` and warns you to
  move it offline. By hand:

    ```powershell
    node scripts\backup-key.js init
    node scripts\backup-key.js export --out D:\offline\idevelop-backup-key.txt
    ```

    A DPAPI key cannot leave its machine. Without this line, no backup restores
    on another server. A second export needs `--force` and is recorded. The
    health page warns until the key has been exported.

- **Linux and Docker:** a copy of `APP_KEY`. It decrypts every backup made while
  it was the current key, on any server. `backup-key.js export` also prints a
  recovery line for the backup key alone, if you prefer not to hand out
  `APP_KEY` (which also opens the stored application secrets).

Keep the copy in a password vault or a sealed envelope, not in the backup folder
or on the off-host share.

## Changing APP_KEY

On Linux and Docker the backup key is derived from `APP_KEY`, so a new `APP_KEY`
is a new backup key. **Change `APP_KEY` only with the rotation script:**

```bash
NEW_APP_KEY=$(openssl rand -hex 32) node scripts/rotate-app-key.js          # dry run
NEW_APP_KEY=<the same value>      node scripts/rotate-app-key.js --commit
# then set APP_KEY=<new value> in .env and restart
```

In Docker: `docker compose exec -e NEW_APP_KEY=<value> app node scripts/rotate-app-key.js --commit`,
then edit `.env` and `docker compose up -d`.

Before it touches the database, the script prepares the backup keyring: the
backup key of the current `APP_KEY` becomes a retired key, every older retired
key is re-wrapped under the new `APP_KEY`, and each wrap is verified. With
`--commit` the keyring is written **before** the database transaction (both keys
open it at that point), trimmed to the new key after the commit, and put back as
it was if the transaction fails. If the keyring cannot be prepared or written
(unreadable file, read-only folder), the rotation **stops and changes nothing**.

Keep the old `APP_KEY` offline as well: it is the last resort if the keyring is
ever lost.

## When a backup will not restore

Every restore (SQL-console revert, `Verify-BackupRestore.ps1`,
`backup-key.js verify|pipe|decrypt`) checks the manifest and decrypts the whole
file first. The refusal says why:

| Message                                                                       | Meaning                                                            | What to do                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup was encrypted with key <id>, which this server does not hold`         | the key is not on this server                                      | From another Windows server: `node scripts/backup-key.js import --in <recovery file>`. After a hand-made `APP_KEY` change: `node scripts/backup-key.js import-app-key --in -` and type the previous `APP_KEY`. |
| `SHA-256 mismatch` / `size mismatch` / `manifest signature invalid`           | the file or its manifest changed after it was written              | Use another backup; find out who or what changed the file                                                                                                                                                      |
| `authentication failed on chunk N`, `truncated`, `data after the final chunk` | the file is corrupt or was cut or extended                         | Use another backup; check the disk and the copy that produced it                                                                                                                                               |
| `manifest missing or unreadable`                                              | an encrypted file without its manifest: integrity cannot be proven | Copy the `.manifest.json` that goes with it (the off-host copy has one)                                                                                                                                        |
| `UNENCRYPTED legacy backup` (warning)                                         | a plaintext dump from before encryption                            | Restored as-is; nothing to do                                                                                                                                                                                  |

The daily job does not wait for that day. After each backup it checks that
**every encrypted backup on disk** still has its key on this server, records the
result ("Keys of the backups on disk" on Admin → Instance health) and alerts the
super administrators when one is missing. The health card also counts them.

## Restore by hand

```bash
# check only (exit 0 = restorable)
node scripts/backup-key.js verify --in <file>.dump.enc --pg-restore "$(command -v pg_restore)"
# restore into a scratch database, plaintext streamed to pg_restore's stdin
node scripts/backup-key.js pipe --in <file>.dump.enc --run pg_restore -d scratch_db --no-owner --no-privileges
```

On Windows, `scripts\Verify-BackupRestore.ps1` does the same for the newest
backup into a throwaway database, runs sanity checks and drops it. Run it every
quarter and after any change to the backup set-up.

`backup-key.js decrypt --in <file> --out <plain>` writes a clear copy (ACL
restricted) for the rare case where nothing else works. Delete it after use.

## Windows restore points (`Manage-IDevelop.ps1`)

`Setup.bat` takes a restore point (code and database) before every patch,
upgrade or reinstall; `Manage-IDevelop.ps1 -Backup` takes one by hand. The
database part is a plain `pg_dump` that is encrypted at once with the backup key
(`backup-key.js encrypt --remove-plain`, kind `installer-restore-point`) and
kept as `database.sql.enc`. If the key tool fails, the restore point is refused
and the plain dump deleted, unless you pass `-AllowPlainBackup`. One exception:
an installed version older than the backup key has no `backup-key.js`, so the
restore point taken before upgrading it stays plain and is listed
`[UNENCRYPTED]` by `-List`.

`Manage-IDevelop.ps1 -Restore` runs `backup-key.js verify` on the dump before it
stops the service or drops the database, and refuses a changed or truncated
file. It then streams the decrypted SQL into `psql` (`backup-key.js pipe`):
nothing clear is written to disk. Plain `database.sql` points from earlier
versions are restored as they are, with a warning.

## Off-host copy

Set `BACKUP_OFFHOST_DIR` to an absolute path on another machine's storage (a
mounted network share or a UNC path). After each backup the encrypted file and
its manifest are copied there, the copy is checked against the manifest, and the
same retention applies. A failed copy alerts; it never fails the local backup.
It is an operator setting, in the environment, on purpose: where the whole HR
database goes is not changed from a browser. A folder inside the backup folder,
or a relative path, is ignored.

## Docker

The image keeps the keyring in `/app/data/keys` (`BACKUP_KEYRING_FILE`), on the
`appdata` volume with the backups. The image does not ship the PostgreSQL client
tools: to run the daily `pg_dump` inside the container, add `postgresql17-client`
to the image, or take the dumps from the `db` service with your own schedule and
encrypt them with `backup-key.js encrypt --remove-plain`.
