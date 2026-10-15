'use strict';

/**
 * db-backup — daily pg_dump of the application database with retention.
 *
 * The tick runs hourly but only the first run after BACKUP_HOUR (default 2 AM)
 * each day produces a backup (idempotent via the dated filename). Compressed
 * custom-format dumps land in the backup directory; the newest BACKUP_KEEP
 * files are kept (default 14 = two weeks of dailies). Credentials go through
 * PGPASSWORD env — never on the command line.
 *
 * WHERE THE FILES GO. The directory used to default to
 * <cwd>/backups/auto, which depends on the working directory of whichever
 * process ran the tick: the status said "ok" while the newest file in the
 * folder the operator looked at was nine days old. It now resolves, in order:
 *   1. BACKUP_DIR (explicit ops override);
 *   2. %ProgramData%\IDevelop\backups — next to the SQL-console restore points,
 *      outside the application folder, so a reinstall does not take the backups
 *      with it — when that folder is writable;
 *   3. <cwd>/backups/auto (the historic fallback, e.g. a Linux dev box).
 * The file PATH and SIZE are recorded with the status, and a 0-byte dump is a
 * FAILURE (the file is removed), never an "ok (0.0 MB)".
 *
 * ENCRYPTED (SA-39). pg_dump writes to stdout and the stream is encrypted on
 * the fly (BackupCryptoService: AES-256-GCM stream, DPAPI-held or
 * APP_KEY-derived master key) into "<db>-<stamp>.dump.enc" plus
 * "<file>.manifest.json" (SHA-256, size, key id, app version, HMAC). No key
 * means no backup (fail closed, alerted), never a clear dump. Each new backup
 * is then verified (manifest, every chunk authenticated, `pg_restore --list` on
 * the decrypted stream; nothing is written in clear), the key of EVERY backup on
 * disk is checked to still be held by this server, and, when BACKUP_OFFHOST_DIR
 * is set, the backup is copied there. A copy or key-check failure alerts; it
 * never fails the local backup. Older plaintext ".dump" files stay as they are,
 * are listed with `encrypted: false` and rotate out under the same retention.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Crypto = require('../services/BackupCryptoService');

// Hour/keep are runtime-tunable from App Settings (category "jobs"), read per
// tick with the env var (then the historic default) as fallback.
const ENV_BACKUP_HOUR = Number(process.env.BACKUP_HOUR) || 2;
const ENV_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
/** Newest successful backup older than this is reported as stale. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

let _dir = null;
/** Resolve the backup directory once per process (see the header). */
function backupDir() {
    if (_dir) return _dir;
    if (process.env.BACKUP_DIR) {
        _dir = process.env.BACKUP_DIR;
        return _dir;
    }
    const pd = process.env.ProgramData;
    if (pd) {
        const candidate = path.join(pd, 'IDevelop', 'backups');
        try {
            fs.mkdirSync(candidate, { recursive: true });
            fs.accessSync(candidate, fs.constants.W_OK);
            _dir = candidate;
            return _dir;
        } catch {
            /* not writable (non-admin dev session) → fall through */
        }
    }
    _dir = path.join(process.cwd(), 'backups', 'auto');
    return _dir;
}

/**
 * Best-effort: cut a fresh dump's ACL down to SYSTEM + Administrators (+ the
 * file's OWNER, so a non-elevated dev run can still restore its own dump).
 * 3.23.17 (S-01): dumps inherited BUILTIN\Users:(RX) from %ProgramData% — any
 * local user could read the whole HR database. SIDs, not names: the group is
 * "Administrateurs" on a French appliance. The installer hardens the folder
 * itself; this covers BACKUP_DIR overrides and folders it has not reached yet.
 * NEVER fails the backup: resolves { ok, detail } whatever happens.
 */
function restrictFileAcl(file, platform = process.platform) {
    if (platform !== 'win32') {
        try {
            fs.chmodSync(file, 0o600);
            return Promise.resolve({ ok: true, detail: 'chmod 600' });
        } catch (e) {
            return Promise.resolve({ ok: false, detail: String(e.message).slice(0, 120) });
        }
    }
    const args = [
        file,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-18:F',
        '*S-1-5-32-544:F',
        '*S-1-3-4:F',
    ];
    return new Promise((resolve) => {
        try {
            execFile('icacls.exe', args, { windowsHide: true, timeout: 60 * 1000 }, (err) => {
                resolve(
                    err
                        ? { ok: false, detail: String(err.message).slice(0, 120) }
                        : { ok: true, detail: 'icacls' }
                );
            });
        } catch (e) {
            resolve({ ok: false, detail: String(e.message).slice(0, 120) });
        }
    });
}

function findPgDump() {
    if (process.env.PG_DUMP_PATH && fs.existsSync(process.env.PG_DUMP_PATH))
        return process.env.PG_DUMP_PATH;
    // Common Windows install locations (newest first), then PATH.
    for (const v of ['18', '17', '16', '15']) {
        const p = `C:\\Program Files\\PostgreSQL\\${v}\\bin\\pg_dump.exe`;
        if (fs.existsSync(p)) return p;
    }
    return 'pg_dump';
}

/** pg_restore next to the pg_dump in use (same major version), else PATH. */
function findPgRestore() {
    const dump = findPgDump();
    if (dump !== 'pg_dump') {
        const p = path.join(
            path.dirname(dump),
            /\.exe$/i.test(dump) ? 'pg_restore.exe' : 'pg_restore'
        );
        if (fs.existsSync(p)) return p;
    }
    return 'pg_restore';
}

/** A backup file this job wrote: legacy plaintext `.dump` or encrypted `.dump.enc`. */
function isBackupName(f, dbName) {
    return (
        f.startsWith(dbName + '-') && (f.endsWith('.dump') || f.endsWith('.dump' + Crypto.ENC_EXT))
    );
}

/** Remove a backup and everything that travels with it (manifest, partial). */
function removeBackup(file) {
    for (const p of [file, file + '.partial', Crypto.manifestPath(file)]) {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
            /* ignore */
        }
    }
}

/**
 * Verification of a backup: the manifest must match, every chunk must
 * authenticate, then the DECRYPTED stream is fed to `pg_restore --list` on its
 * stdin (no plaintext file). Returns { ok, detail }. Never throws.
 */
async function verifyBackup(file) {
    try {
        const m = await Crypto.verifyManifest(file);
        if (!m.ok) return { ok: false, detail: 'manifest: ' + String(m.reason).slice(0, 300) };
        // Every chunk authenticates (pg_restore --list stops reading after the TOC).
        const d = await Crypto.verifyDecrypt(file);
        if (!d.ok) return { ok: false, detail: 'decryption: ' + String(d.reason).slice(0, 300) };
        const r = await Crypto.spawnWithPlainStdin(findPgRestore(), ['--list'], file);
        if (r.streamError)
            return {
                ok: false,
                detail: 'decryption: ' + String(r.streamError.message).slice(0, 300),
            };
        if (r.code !== 0)
            return {
                ok: false,
                detail: `pg_restore --list exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`,
            };
        const entries = (/TOC Entries:\s*(\d+)/.exec(r.stdout) || [])[1];
        if (!entries)
            return { ok: false, detail: 'pg_restore --list printed no table of contents' };
        return { ok: true, detail: `${entries} TOC entries` };
    } catch (e) {
        return { ok: false, detail: String(e.message).slice(0, 200) };
    }
}

/**
 * Is the key of every encrypted backup on disk still held by this server? A
 * backup whose key is gone cannot be restored here: that is reported loudly
 * (alert + status) with the ids of the missing keys on the day it happens, not
 * on the day someone needs the backup. Returns { ok, checked, missing: [{keyId, files}] }.
 */
async function checkBackupKeys(files) {
    const byKey = new Map();
    for (const f of files) {
        if (!f.encrypted) continue;
        const id = Crypto.keyIdOfFile(f.file);
        if (!id) continue;
        if (!byKey.has(id)) byKey.set(id, []);
        byKey.get(id).push(f.name);
    }
    const missing = [];
    for (const [keyId, names] of byKey) {
        let key = null;
        try {
            key = await Crypto.findKey(keyId);
        } catch {
            key = null;
        }
        if (!key) missing.push({ keyId, files: names });
    }
    return { ok: missing.length === 0, checked: byKey.size, missing };
}

/**
 * Off-host target: BACKUP_OFFHOST_DIR (a mounted network folder or a UNC path),
 * set by the operator in the environment; '' = not set. It is not an App
 * Setting on purpose: where the whole HR database is copied is an operator
 * decision, not something to change from a browser. It must be absolute and
 * must not be the backup folder or inside it.
 */
function offHostDir() {
    const v = String(process.env.BACKUP_OFFHOST_DIR || '').trim();
    if (!v || !path.isAbsolute(v)) return '';
    const target = path.resolve(v);
    const local = path.resolve(backupDir());
    if (target === local || target.startsWith(local + path.sep)) return '';
    return target;
}

/**
 * Copy the encrypted backup and its manifest to the off-host folder, check the
 * copy against the manifest, apply the same retention there. A failure is
 * REPORTED (alert + status) and never fails the local backup.
 */
async function copyOffHost(file, dbName, keep, target) {
    try {
        fs.mkdirSync(target, { recursive: true });
        const dest = path.join(target, path.basename(file));
        fs.copyFileSync(file, dest);
        fs.copyFileSync(Crypto.manifestPath(file), Crypto.manifestPath(dest));
        const m = await Crypto.verifyManifest(dest);
        if (!m.ok) return { ok: false, detail: 'copy does not match its manifest: ' + m.reason };
        try {
            fs.readdirSync(target)
                .filter((f) => isBackupName(f, dbName))
                .sort()
                .reverse()
                .slice(keep)
                .forEach((f) => removeBackup(path.join(target, f)));
        } catch {
            /* retention best-effort */
        }
        return { ok: true, detail: dest };
    } catch (e) {
        return { ok: false, detail: String(e.message).slice(0, 200) };
    }
}

function dbNameFromUrl() {
    try {
        return new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '') || 'postgres';
    } catch {
        return 'postgres';
    }
}

/**
 * Run the backup. `force` ignores the hour gate and the once-a-day file check
 * (the "Sauvegarder maintenant" button): the file then carries a time suffix so
 * it never overwrites the scheduled daily dump.
 */
async function tick({ force = false } = {}) {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');
    let backupHour = ENV_BACKUP_HOUR,
        keep = ENV_KEEP;
    try {
        backupHour = Number(await AppSettingsModel.getValue('backupHour', ENV_BACKUP_HOUR));
        // 0 (or non-positive) = "keep all" per the getValue convention — not "keep 1".
        const k = Number(await AppSettingsModel.getValue('backupKeep', ENV_KEEP));
        // Must be a whole count >= 1. Anything else (0, fractional like 0.5, negative,
        // NaN) means "keep all" — floor guards against slice(0.5)→slice(0) wiping the set.
        keep = Number.isFinite(k) && k >= 1 ? Math.floor(k) : Infinity;
    } catch {
        /* settings unavailable → env/default */
    }
    if (!force && now.getHours() < backupHour) return { done: false, skipped: 'before_hour' };

    const today = now.toISOString().slice(0, 10);
    const url = new URL(process.env.DATABASE_URL);
    const dbName = url.pathname.replace(/^\//, '') || 'postgres';
    const DIR = backupDir();
    const stamp = force ? `${today}T${now.toISOString().slice(11, 19).replace(/:/g, '')}` : today;
    // Every new backup is encrypted (".dump.enc" + manifest). A legacy plaintext
    // ".dump" of the same day still counts for idempotence.
    const legacyFile = path.join(DIR, `${dbName}-${stamp}.dump`);
    const file = legacyFile + Crypto.ENC_EXT;
    if (!force && (fs.existsSync(file) || fs.existsSync(legacyFile)))
        return { done: false, skipped: 'already_today' };

    fs.mkdirSync(DIR, { recursive: true });

    const args = [
        '-h',
        url.hostname || 'localhost',
        '-p',
        url.port || '5432',
        '-U',
        decodeURIComponent(url.username || 'postgres'),
        '-d',
        dbName,
        '-F',
        'c', // compressed custom format (pg_restore-able), on stdout, encrypted on the fly
    ];
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') };

    // The key first: no key means no backup at all, never one written in clear.
    let status = 'ok';
    let plainBytes = 0;
    try {
        await Crypto.getCurrentKey();
    } catch (e) {
        status = 'failed: backup encryption key unavailable: ' + String(e.message).slice(0, 160);
    }
    if (status === 'ok') {
        const r = await Crypto.spawnToEncryptedFile(findPgDump(), args, file, {
            env,
            kind: 'db-backup',
            timeoutMs: 10 * 60 * 1000,
        });
        status = r.ok ? 'ok' : 'failed: ' + String(r.error).slice(0, 160);
        plainBytes = r.plainBytes;
    }

    // A 0-byte dump is not a backup (one sat in the folder, counted as a
    // success). Treat it as a failure and remove it so idempotence cannot
    // false-positive on it tomorrow. An empty pg_dump output still yields an
    // encrypted header, so the PLAINTEXT byte count is what decides.
    let size = 0;
    if (status === 'ok') {
        try {
            size = plainBytes ? fs.statSync(file).size : 0;
        } catch {
            size = 0;
        }
        if (!size) status = 'failed: empty dump file';
    }

    let verify = null;
    let offHost = null;
    let keys = null;
    if (status !== 'ok') {
        // Remove a partial file so tomorrow's idempotence check doesn't false-positive.
        removeBackup(file);
    } else {
        // S-01: the dump holds the whole database - not for BUILTIN\Users.
        for (const p of [file, Crypto.manifestPath(file)]) {
            const acl = await restrictFileAcl(p);
            if (!acl.ok)
                console.warn(`[db-backup] could not restrict the ACL of ${p}: ${acl.detail}`);
        }
        // Retention: keep the newest KEEP backups (legacy plaintext or encrypted)
        // for this database; the manifest goes with its file.
        try {
            fs.readdirSync(DIR)
                .filter((f) => isBackupName(f, dbName))
                .sort()
                .reverse()
                .slice(keep)
                .forEach((f) => removeBackup(path.join(DIR, f)));
        } catch {
            /* retention best-effort */
        }
        // Verification of the new backup: manifest, every chunk, pg_restore --list.
        verify = await verifyBackup(file);
        // Every encrypted backup still on disk must still have its key here.
        keys = await checkBackupKeys(listBackups());
        // Optional off-host copy (never fails the local backup).
        const target = offHostDir();
        if (target) offHost = await copyOffHost(file, dbName, keep, target);
    }

    try {
        await AppSettingsModel.setValue(
            'backupLastRunOn',
            today,
            'string',
            'Last automatic DB backup date',
            'ops'
        );
        await AppSettingsModel.setValue(
            'backupLastStatus',
            status === 'ok' ? `ok (${(size / 1048576).toFixed(1)} MB)` : status,
            'string',
            'Last automatic DB backup outcome',
            'ops'
        );
        // Path + size are what an operator needs after an incident.
        await AppSettingsModel.setValue(
            'backupLastFile',
            status === 'ok' ? file : '',
            'string',
            'Path of the last successful DB backup',
            'ops'
        );
        await AppSettingsModel.setValue(
            'backupLastSize',
            String(status === 'ok' ? size : 0),
            'number',
            'Size in bytes of the last successful DB backup',
            'ops'
        );
        if (verify) {
            await AppSettingsModel.setValue(
                'backupLastVerify',
                `${verify.ok ? 'ok' : 'failed'} ${now.toISOString()} ${path.basename(file)}: ${verify.detail}`.slice(
                    0,
                    400
                ),
                'string',
                'Last backup verification (manifest, decryption, pg_restore --list)',
                'ops'
            );
        }
        if (keys) {
            await AppSettingsModel.setValue(
                'backupKeyCheck',
                (keys.ok
                    ? `ok ${now.toISOString()}: ${keys.checked} key(s) held`
                    : `failed ${now.toISOString()}: key(s) not held here: ${keys.missing
                          .map((m) => `${m.keyId} (${m.files.length} file(s))`)
                          .join(', ')}`
                ).slice(0, 400),
                'string',
                'Last check that every backup on disk can still be decrypted here',
                'ops'
            );
        }
        if (offHost) {
            await AppSettingsModel.setValue(
                'backupOffHostLastStatus',
                `${offHost.ok ? 'ok' : 'failed'} ${now.toISOString()}: ${offHost.detail}`.slice(
                    0,
                    400
                ),
                'string',
                'Last off-host backup copy outcome',
                'ops'
            );
        }
    } catch {
        /* status write best-effort */
    }

    // Same day de-duplication as every ops alert (JobRunService.alert).
    const alert = async (kind, key, payload) => {
        try {
            await require('../services/JobRunService').alert(kind, key, {
                ...payload,
                link: '/admin/health',
            });
        } catch {
            /* best-effort */
        }
    };
    if (status !== 'ok') await alert('ops.backup_stale', `backup-failed:${today}`, { status });
    if (verify && !verify.ok)
        await alert('ops.job_failed', `backup-verify:${today}`, {
            tick: 'db-backup.verify',
            error: 'failed: ' + verify.detail,
        });
    if (keys && !keys.ok)
        await alert('ops.job_failed', `backup-keys:${today}`, {
            tick: 'db-backup.keys',
            error:
                'backups this server cannot decrypt: key(s) ' +
                keys.missing.map((m) => m.keyId).join(', '),
        });
    if (offHost && !offHost.ok)
        await alert('ops.job_failed', `backup-offhost:${today}`, {
            tick: 'db-backup.offhost',
            error: 'failed: ' + offHost.detail,
        });

    return {
        done: status === 'ok',
        status,
        file: status === 'ok' ? file : null,
        sizeBytes: size,
        encrypted: status === 'ok',
        verify,
        keys,
        offHost,
    };
}

/** Files in the backup directory for THIS database, newest first. */
function listBackups() {
    const DIR = backupDir();
    const dbName = dbNameFromUrl();
    try {
        return fs
            .readdirSync(DIR)
            .filter((f) => isBackupName(f, dbName))
            .map((f) => {
                const file = path.join(DIR, f);
                const st = fs.statSync(file);
                // A legacy plaintext dump is kept as-is and FLAGGED, never hidden.
                const encrypted = f.endsWith(Crypto.ENC_EXT);
                return {
                    name: f,
                    file,
                    sizeBytes: st.size,
                    modifiedAt: st.mtime.toISOString(),
                    empty: st.size === 0,
                    encrypted,
                    hasManifest: fs.existsSync(Crypto.manifestPath(file)),
                    keyId: encrypted ? Crypto.keyIdOfFile(file) : null,
                };
            })
            .sort((a, b) => (a.name < b.name ? 1 : -1));
    } catch {
        return [];
    }
}

/** Free / total bytes of the volume holding the backup directory (null when unknown). */
function diskSpace() {
    try {
        const s = fs.statfsSync(backupDir());
        return {
            freeBytes: Number(s.bavail) * Number(s.bsize),
            totalBytes: Number(s.blocks) * Number(s.bsize),
        };
    } catch {
        return null;
    }
}

/**
 * The backup card in one object (health page + watchdog): last run/status/
 * file/size from settings, the directory listing, disk space, next run and
 * whether the newest SUCCESSFUL dump is older than 36 h.
 */
async function status(now = Date.now()) {
    const AppSettingsModel = require('../models/AppSettingsModel');
    const get = async (k, d) => {
        try {
            return await AppSettingsModel.getValue(k, d);
        } catch {
            return d;
        }
    };
    const lastRunOn = await get('backupLastRunOn', null);
    const lastStatus = await get('backupLastStatus', null);
    const lastFile = await get('backupLastFile', null);
    const lastSize = Number(await get('backupLastSize', 0)) || 0;
    const backupHour = Number(await get('backupHour', ENV_BACKUP_HOUR));
    const keepRaw = Number(await get('backupKeep', ENV_KEEP));
    const files = listBackups();
    const newestOk = files.find((f) => !f.empty) || null;
    const newestAt = newestOk ? new Date(newestOk.modifiedAt).getTime() : null;
    // Stale = no non-empty dump on disk within 36 h. "Never" (fresh install) is
    // reported as unmeasured (stale=null), not as an alert.
    const stale = files.length === 0 ? null : !(newestAt && now - newestAt < STALE_AFTER_MS);
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    // Next run: the first hourly tick at/after backupHour, today if still ahead, else tomorrow.
    const nextRun = new Date(next);
    nextRun.setHours(backupHour, 40, 0, 0);
    if (
        nextRun.getTime() <= now ||
        (lastRunOn === new Date(now).toISOString().slice(0, 10) &&
            /^ok/.test(String(lastStatus || '')))
    )
        nextRun.setDate(nextRun.getDate() + 1);
    return {
        dir: backupDir(),
        lastRunOn,
        lastStatus,
        lastFile: lastFile || null,
        lastSizeBytes: lastSize,
        lastOk: /^ok/.test(String(lastStatus || '')),
        backupHour,
        keep: Number.isFinite(keepRaw) && keepRaw >= 1 ? Math.floor(keepRaw) : 0,
        files,
        totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
        disk: diskSpace(),
        nextRunAt: nextRun,
        stale,
        // SA-39: encryption, verification, key availability, off-host copy.
        plaintextCount: files.filter((f) => !f.encrypted).length,
        unreadableCount: unreadableCount(files),
        encryption: Crypto.keyStatus(),
        lastVerify: (await get('backupLastVerify', null)) || null,
        lastKeyCheck: (await get('backupKeyCheck', null)) || null,
        offHost: {
            dir: offHostDir() || null,
            lastStatus: (await get('backupOffHostLastStatus', null)) || null,
        },
    };
}

/**
 * Encrypted files whose key this server does not hold. Read-only (key ids
 * only, nothing unwrapped, no DPAPI call): each of them CANNOT be restored here.
 */
function unreadableCount(files) {
    let known;
    try {
        known = Crypto.knownKeyIds();
    } catch {
        return null;
    }
    return files.filter((f) => f.encrypted && !(f.keyId && known.has(f.keyId))).length;
}

module.exports = {
    tick,
    status,
    listBackups,
    backupDir,
    diskSpace,
    restrictFileAcl,
    verifyBackup,
    checkBackupKeys,
    copyOffHost,
    offHostDir,
    isBackupName,
    STALE_AFTER_MS,
};
