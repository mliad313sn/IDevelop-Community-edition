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
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
    const file = path.join(DIR, `${dbName}-${stamp}.dump`);
    if (!force && fs.existsSync(file)) return { done: false, skipped: 'already_today' };

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
        'c', // compressed custom format (pg_restore-able)
        '-f',
        file,
    ];
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') };

    let status = await new Promise((resolve) => {
        execFile(findPgDump(), args, { env, timeout: 10 * 60 * 1000 }, (err) => {
            resolve(err ? 'failed: ' + String(err.message).slice(0, 160) : 'ok');
        });
    });

    // A 0-byte dump is not a backup (one sat in the folder, counted as
    // a success). Treat it as a failure and remove it so idempotence cannot
    // false-positive on it tomorrow.
    let size = 0;
    if (status === 'ok') {
        try {
            size = fs.statSync(file).size;
        } catch {
            size = 0;
        }
        if (!size) status = 'failed: empty dump file';
    }

    if (status !== 'ok') {
        // Remove a partial file so tomorrow's idempotence check doesn't false-positive.
        try {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {
            /* ignore */
        }
    } else {
        // S-01: the dump holds the whole database - not for BUILTIN\Users.
        const acl = await restrictFileAcl(file);
        if (!acl.ok)
            console.warn(`[db-backup] could not restrict the ACL of ${file}: ${acl.detail}`);
        // Retention: keep the newest KEEP dumps for this database.
        try {
            const files = fs
                .readdirSync(DIR)
                .filter((f) => f.startsWith(dbName + '-') && f.endsWith('.dump'))
                .sort()
                .reverse();
            files.slice(keep).forEach((f) => {
                try {
                    fs.unlinkSync(path.join(DIR, f));
                } catch {
                    /* ignore */
                }
            });
        } catch {
            /* retention best-effort */
        }
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
    } catch {
        /* status write best-effort */
    }

    if (status !== 'ok') {
        // Same day de-duplication as every ops alert (JobRunService.alert).
        try {
            await require('../services/JobRunService').alert(
                'ops.backup_stale',
                `backup-failed:${today}`,
                { status, link: '/admin/health' }
            );
        } catch {
            /* best-effort */
        }
    }

    return { done: status === 'ok', status, file: status === 'ok' ? file : null, sizeBytes: size };
}

/** Files in the backup directory for THIS database, newest first. */
function listBackups() {
    const DIR = backupDir();
    const dbName = dbNameFromUrl();
    try {
        return fs
            .readdirSync(DIR)
            .filter((f) => f.startsWith(dbName + '-') && f.endsWith('.dump'))
            .map((f) => {
                const st = fs.statSync(path.join(DIR, f));
                return {
                    name: f,
                    file: path.join(DIR, f),
                    sizeBytes: st.size,
                    modifiedAt: st.mtime.toISOString(),
                    empty: st.size === 0,
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
    };
}

module.exports = {
    tick,
    status,
    listBackups,
    backupDir,
    diskSpace,
    restrictFileAcl,
    STALE_AFTER_MS,
};
