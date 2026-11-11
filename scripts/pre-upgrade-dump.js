'use strict';

/**
 * pre-upgrade-dump.js — the encrypted, verified database dump the Windows
 * installer takes on an EXISTING install right before it applies migrations
 * (upgrade, -Patch and -Migrate when migrations run; never on -Reinstall, where
 * the database is recreated). Security record: SA-57 in docs/SECURITY-AUDIT.md;
 * the way back that uses it: docs/ROLLBACK.md.
 *
 * Why: once a newer version has migrated the database, the migration pre-flight
 * refuses an older package (the database is "ahead"), and the code copy under
 * app-backups only rolls the CODE back. This file is the database half of the
 * rollback.
 *
 * Same pipeline as the daily job (src/jobs/db-backup.js): `pg_dump -F c` to
 * STDOUT, encrypted as it is produced (BackupCryptoService: AES-256-GCM stream,
 * DPAPI-held or APP_KEY-derived master key) into
 *   <out-dir>/pre-upgrade-<db>-<from>-to-<to>-<stamp>.dump.enc  (+ .manifest.json)
 * then verified (signed manifest, every chunk authenticated, `pg_restore --list`
 * on the decrypted stream). No clear copy touches the disk. The name does NOT
 * start with "<db>-", so the daily retention (db-backup.isBackupName) never
 * removes it.
 *
 * Fail closed: no DATABASE_URL, not enough free space, no key, a pg_dump error,
 * an empty dump or a failed verification => exit 1 and nothing is left behind.
 * The installer then stops before any migration (unless the operator passed
 * -SkipPreMigrationDump, which is logged).
 *
 * Credentials: PGPASSWORD in the child's environment, never on a command line.
 * The output names the file and its sizes, never the connection string.
 *
 * usage: node scripts/pre-upgrade-dump.js --from <old version> --to <new version> [--out-dir <dir>]
 * stdout (last line): PRE_UPGRADE_DUMP {"ok":true,"file":"...","sizeBytes":n,"verify":"..."}
 */

const fs = require('fs');
const path = require('path');

try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
} catch (_) {
    /* dotenv optional: the installer passes DATABASE_URL in the environment */
}

const Crypto = require('../src/services/BackupCryptoService');
const Backup = require('../src/jobs/db-backup');

/** Head room asked for on top of the table data (bytes). */
const SPACE_MARGIN = 256 * 1024 * 1024;

/** A label safe in a file name: letters, digits, dot, dash, underscore. */
function safeLabel(v, fallback) {
    const s = String(v || '').replace(/[^0-9A-Za-z._-]/g, '');
    return s || fallback;
}

function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[a.slice(2)] = next;
            i++;
        } else flags[a.slice(2)] = true;
    }
    return flags;
}

/** The dump's file name (pure). */
function dumpFileName(dbName, from, to, now = new Date()) {
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    return (
        `pre-upgrade-${safeLabel(dbName, 'db')}-${safeLabel(from, 'prev')}` +
        `-to-${safeLabel(to, 'new')}-${stamp}.dump${Crypto.ENC_EXT}`
    );
}

/** pg_dump arguments: custom format on stdout, no password, no output file (pure). */
function pgDumpArgs(url) {
    return [
        '-h',
        url.hostname || 'localhost',
        '-p',
        url.port || '5432',
        '-U',
        decodeURIComponent(url.username || 'postgres'),
        '-d',
        decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
        '-F',
        'c',
    ];
}

/**
 * Is there room for the dump? The uncompressed table data plus SPACE_MARGIN is
 * asked for; the compressed custom-format dump is normally much smaller, so
 * this errs on the safe side. Unknown free space or data size: the check passes
 * (the dump itself still fails closed). Pure.
 */
function spaceCheck(freeBytes, dataBytes, margin = SPACE_MARGIN) {
    if (!Number.isFinite(freeBytes) || !Number.isFinite(dataBytes)) {
        return { ok: true, detail: 'free space or database size unknown - not checked' };
    }
    const need = dataBytes + margin;
    const mb = (n) => `${Math.ceil(n / 1048576)} MB`;
    if (freeBytes < need) {
        return {
            ok: false,
            detail: `not enough free space: ${mb(freeBytes)} free, ${mb(need)} needed (table data ${mb(dataBytes)} + ${mb(margin)})`,
        };
    }
    return { ok: true, detail: `${mb(freeBytes)} free, ${mb(need)} needed` };
}

function freeBytesOf(dir) {
    try {
        const s = fs.statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch (_) {
        return NaN;
    }
}

/** Size of the table data the dump will hold (heap + TOAST, no index). NaN when unknown. */
async function tableDataBytes(connectionString) {
    let client;
    try {
        const { Client } = require('pg');
        client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
        await client.connect();
        const r = await client.query(
            "SELECT COALESCE(SUM(pg_table_size(c.oid)), 0)::bigint AS n FROM pg_class c WHERE c.relkind IN ('r', 'm', 'p')"
        );
        return Number(r.rows[0].n);
    } catch (_) {
        return NaN;
    } finally {
        if (client) await client.end().catch(() => {});
    }
}

function removeQuietly(file) {
    for (const p of [file, file + '.partial', Crypto.manifestPath(file)]) {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (_) {
            /* ignore */
        }
    }
}

async function run({ from, to, outDir, pgDumpBin, dataBytes } = {}) {
    if (!process.env.DATABASE_URL) return { ok: false, error: 'DATABASE_URL is not set' };
    let url;
    try {
        url = new URL(process.env.DATABASE_URL);
    } catch (_) {
        return { ok: false, error: 'DATABASE_URL is not a valid URL' };
    }
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');
    const dir = outDir || Backup.backupDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        return {
            ok: false,
            error: 'cannot create the dump folder: ' + String(e.message).slice(0, 200),
        };
    }

    const data =
        dataBytes !== undefined ? dataBytes : await tableDataBytes(process.env.DATABASE_URL);
    const space = spaceCheck(freeBytesOf(dir), data);
    if (!space.ok) return { ok: false, error: space.detail };

    const file = path.join(dir, dumpFileName(dbName, from, to));
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') };
    const bin = pgDumpBin || Backup.findPgDump();

    const r = await Crypto.spawnToEncryptedFile(bin, pgDumpArgs(url), file, {
        env,
        kind: 'pre-upgrade',
        timeoutMs: 60 * 60 * 1000,
    });
    if (!r.ok) {
        removeQuietly(file);
        return { ok: false, error: String(r.error || 'pg_dump failed').slice(0, 400) };
    }
    if (!r.plainBytes) {
        removeQuietly(file);
        return { ok: false, error: 'empty dump (pg_dump wrote 0 bytes)' };
    }
    // The dump holds the whole HR database: SYSTEM + Administrators + owner only.
    const acl = [];
    for (const p of [file, Crypto.manifestPath(file)]) acl.push(await Backup.restrictFileAcl(p));
    const verify = await Backup.verifyBackup(file);
    if (!verify.ok) {
        removeQuietly(file);
        return { ok: false, error: 'verification failed: ' + verify.detail };
    }
    const aclBad = acl.filter((a) => !a.ok);
    return {
        ok: true,
        file,
        sizeBytes: fs.statSync(file).size,
        plainBytes: r.plainBytes,
        verify: verify.detail,
        space: space.detail,
        acl: aclBad.length ? 'NOT restricted: ' + aclBad[0].detail : 'restricted',
    };
}

if (require.main === module) {
    const flags = parseArgs(process.argv.slice(2));
    run({
        from: flags.from,
        to: flags.to,
        outDir: typeof flags['out-dir'] === 'string' ? flags['out-dir'] : undefined,
    }).then(
        (res) => {
            process.stdout.write('PRE_UPGRADE_DUMP ' + JSON.stringify(res) + '\n');
            process.exit(res.ok ? 0 : 1);
        },
        (e) => {
            process.stdout.write(
                'PRE_UPGRADE_DUMP ' +
                    JSON.stringify({ ok: false, error: String(e.message).slice(0, 400) }) +
                    '\n'
            );
            process.exit(1);
        }
    );
}

module.exports = { run, dumpFileName, pgDumpArgs, safeLabel, spaceCheck, SPACE_MARGIN };
