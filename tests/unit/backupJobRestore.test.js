'use strict';
/**
 * SA-39 — encrypted backups wired end to end, with a FAKE pg_dump / pg_restore
 * (child_process.spawn spied): the daily job writes only an encrypted dump and
 * its manifest, verifies it (pg_restore --list on the decrypted stream), checks
 * that every backup on disk still has its key, copies it off-host when asked;
 * the SQL-console restore points are encrypted and refused on tamper before
 * anything reads them; the health page flags what is not protected.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

// Real crypto on a 3 MiB dump: generous under a parallel run.
jest.setTimeout(30000);

const mockSettings = {};
const mockOverrides = {};
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        k in mockOverrides ? mockOverrides[k] : k in mockSettings ? mockSettings[k] : d
    ),
    setValue: jest.fn(async (k, v) => {
        mockSettings[k] = v;
    }),
}));
jest.mock('../../src/services/JobRunService', () => ({ alert: jest.fn(async () => 1) }));
const mockPool = { query: jest.fn(), connect: jest.fn() };
jest.mock('../../src/config/database', () => ({
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn(),
    runTransaction: jest.fn(),
    pool: mockPool,
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));

const Crypto = require('../../src/services/BackupCryptoService');
const JobRunService = require('../../src/services/JobRunService');

const DB = 'stonebridge_hr';
let dir;
const saved = {};
const ENV = [
    'BACKUP_DIR',
    'DATABASE_URL',
    'BACKUP_KEY_MODE',
    'BACKUP_KEYRING_FILE',
    'APP_KEY',
    'SESSION_SECRET',
    'BACKUP_OFFHOST_DIR',
    'SQL_CONSOLE_BACKUP_DIR',
    'NODE_ENV',
];
let dumpBytes;
let restoreMode; // 'ok' | 'fail'
let restoreSeen;

function fakeChild(onStart) {
    const ch = new EventEmitter();
    ch.stdout = new PassThrough();
    ch.stderr = new PassThrough();
    ch.stdin = new PassThrough();
    ch.kill = () => {};
    setImmediate(() => onStart(ch));
    return ch;
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idv-bkjob-'));
    ENV.forEach((k) => (saved[k] = process.env[k]));
    process.env.BACKUP_DIR = path.join(dir, 'backups');
    process.env.DATABASE_URL = `postgres://u:p@localhost:5432/${DB}`;
    process.env.BACKUP_KEY_MODE = 'derived';
    process.env.BACKUP_KEYRING_FILE = path.join(dir, 'keys', 'backup-keyring.json');
    process.env.APP_KEY = 'job-test-app-key-0123456789abcdef';
    process.env.SQL_CONSOLE_BACKUP_DIR = path.join(dir, 'rp');
    process.env.NODE_ENV = 'test';
    delete process.env.BACKUP_OFFHOST_DIR;
    delete process.env.SESSION_SECRET;
    Object.keys(mockSettings).forEach((k) => delete mockSettings[k]);
    Object.keys(mockOverrides).forEach((k) => delete mockOverrides[k]);
    Crypto._resetCache();
    JobRunService.alert.mockClear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    dumpBytes = Buffer.concat([Buffer.from('PGDMP'), crypto.randomBytes(3 * 1024 * 1024 + 123)]);
    restoreMode = 'ok';
    restoreSeen = null;
    jest.spyOn(cp, 'spawn').mockImplementation((bin, args) =>
        fakeChild((ch) => {
            if (/pg_dump/i.test(bin)) {
                // like pg_dump: many small writes on stdout, then exit 0
                let off = 0;
                const pump = () => {
                    while (off < dumpBytes.length) {
                        const n = Math.min(65536, dumpBytes.length - off);
                        const ok = ch.stdout.write(dumpBytes.subarray(off, off + n));
                        off += n;
                        if (!ok) return ch.stdout.once('drain', pump);
                    }
                    ch.stdout.end();
                    ch.stderr.end();
                    setImmediate(() => ch.emit('close', 0));
                };
                pump();
            } else if (/pg_restore/i.test(bin)) {
                const parts = [];
                ch.stdin.on('data', (d) => parts.push(d));
                ch.stdin.on('end', () => {
                    restoreSeen = { args, data: Buffer.concat(parts) };
                    if (restoreMode === 'fail') {
                        ch.stderr.end(
                            'pg_restore: error: input file does not appear to be a valid archive'
                        );
                        ch.stdout.end();
                        return setImmediate(() => ch.emit('close', 1));
                    }
                    ch.stdout.end(`;\n;     dbname: ${DB}\n;     TOC Entries: 42\n`);
                    ch.stderr.end();
                    setImmediate(() => ch.emit('close', 0));
                });
            } else {
                ch.stdout.end();
                ch.stderr.end();
                setImmediate(() => ch.emit('close', 0));
            }
        })
    );
});
afterEach(() => {
    ENV.forEach((k) =>
        saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
    );
    jest.restoreAllMocks();
    Crypto._resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
});

function freshJob() {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../src/jobs/db-backup');
        // The job's own (isolated) crypto module, to reset its key cache.
        mod.cryptoForTest = require('../../src/services/BackupCryptoService');
    });
    return mod;
}

async function plainOf(file) {
    const parts = [];
    await new Promise((res, rej) =>
        Crypto.openPlainStream(file)
            .on('data', (d) => parts.push(d))
            .on('end', res)
            .on('error', rej)
    );
    return Buffer.concat(parts);
}

describe('SA-39 — the daily backup job', () => {
    test('writes ONLY an encrypted dump + manifest; no plaintext on disk; the content survives intact', async () => {
        const r = await freshJob().tick({ force: true });
        expect(r).toMatchObject({ done: true, status: 'ok', encrypted: true });
        const names = fs.readdirSync(process.env.BACKUP_DIR);
        expect(names.some((n) => /\.dump$/.test(n))).toBe(false);
        expect(names.filter((n) => n.endsWith('.dump.enc'))).toHaveLength(1);
        expect(names.filter((n) => n.endsWith('.dump.enc.manifest.json'))).toHaveLength(1);
        const raw = fs.readFileSync(r.file);
        expect(raw.includes(dumpBytes.subarray(5, 64))).toBe(false);
        expect((await plainOf(r.file)).equals(dumpBytes)).toBe(true);
        expect(mockSettings.backupLastStatus).toMatch(/^ok/);
    });

    test('verification runs pg_restore --list on the DECRYPTED stream and records it; keys are checked', async () => {
        const r = await freshJob().tick({ force: true });
        expect(r.verify).toEqual({ ok: true, detail: '42 TOC entries' });
        expect(restoreSeen.args).toEqual(['--list']);
        expect(restoreSeen.data.subarray(0, 5).toString()).toBe('PGDMP');
        expect(mockSettings.backupLastVerify).toMatch(/^ok .*42 TOC entries/);
        expect(r.keys).toMatchObject({ ok: true, checked: 1, missing: [] });
        expect(mockSettings.backupKeyCheck).toMatch(/^ok .*1 key\(s\) held/);
        expect(JobRunService.alert).not.toHaveBeenCalled();
    });

    test('a failed verification alerts; the backup itself stays', async () => {
        restoreMode = 'fail';
        const r = await freshJob().tick({ force: true });
        expect(r.done).toBe(true);
        expect(r.verify.ok).toBe(false);
        expect(mockSettings.backupLastVerify).toMatch(/^failed/);
        expect(JobRunService.alert).toHaveBeenCalledWith(
            'ops.job_failed',
            expect.stringMatching(/^backup-verify:/),
            expect.objectContaining({ tick: 'db-backup.verify' })
        );
    });

    test('no key: no backup at all (never a clear dump), and an alert', async () => {
        delete process.env.APP_KEY;
        const r = await freshJob().tick({ force: true });
        expect(r.done).toBe(false);
        expect(r.status).toMatch(/encryption key unavailable/);
        const names = fs.existsSync(process.env.BACKUP_DIR)
            ? fs.readdirSync(process.env.BACKUP_DIR)
            : [];
        expect(names).toEqual([]);
        expect(JobRunService.alert).toHaveBeenCalledWith(
            'ops.backup_stale',
            expect.any(String),
            expect.any(Object)
        );
    });

    test('a pg_dump that writes nothing is a failure, and leaves nothing behind', async () => {
        dumpBytes = Buffer.alloc(0);
        const r = await freshJob().tick({ force: true });
        expect(r).toMatchObject({ done: false, status: 'failed: empty dump file' });
        expect(fs.readdirSync(process.env.BACKUP_DIR)).toEqual([]);
    });

    test('APP_KEY changed by hand: the next run names the backups this server can no longer decrypt', async () => {
        const job = freshJob();
        await job.tick({ force: true });
        process.env.APP_KEY = 'changed-by-hand-app-key-0123456789ab';
        job.cryptoForTest._resetCache();
        const st = await job.status();
        expect(st.unreadableCount).toBe(1);
        await new Promise((res) => setTimeout(res, 1100)); // distinct forced stamp
        const r = await job.tick({ force: true });
        expect(r.done).toBe(true);
        expect(r.keys.ok).toBe(false);
        expect(r.keys.missing).toHaveLength(1);
        expect(mockSettings.backupKeyCheck).toMatch(/^failed .*not held here/);
        expect(JobRunService.alert).toHaveBeenCalledWith(
            'ops.job_failed',
            expect.stringMatching(/^backup-keys:/),
            expect.objectContaining({ tick: 'db-backup.keys' })
        );
    });

    test('off-host copy lands with its manifest; a failing target alerts but never fails the backup', async () => {
        process.env.BACKUP_OFFHOST_DIR = path.join(dir, 'offhost');
        let r = await freshJob().tick({ force: true });
        expect(r.offHost.ok).toBe(true);
        const copied = fs.readdirSync(process.env.BACKUP_OFFHOST_DIR);
        expect(copied.filter((n) => n.endsWith('.dump.enc'))).toHaveLength(1);
        expect(copied.filter((n) => n.endsWith('.manifest.json'))).toHaveLength(1);

        const blocker = path.join(dir, 'not-a-dir');
        fs.writeFileSync(blocker, 'x');
        process.env.BACKUP_OFFHOST_DIR = path.join(blocker, 'sub');
        JobRunService.alert.mockClear();
        await new Promise((res) => setTimeout(res, 1100)); // distinct forced stamp
        r = await freshJob().tick({ force: true });
        expect(r.done).toBe(true);
        expect(r.offHost.ok).toBe(false);
        expect(mockSettings.backupOffHostLastStatus).toMatch(/^failed/);
        expect(JobRunService.alert).toHaveBeenCalledWith(
            'ops.job_failed',
            expect.stringMatching(/^backup-offhost:/),
            expect.objectContaining({ tick: 'db-backup.offhost' })
        );
    });

    test('an off-host folder that is relative, or inside the backup folder, is ignored', () => {
        const job = freshJob();
        process.env.BACKUP_OFFHOST_DIR = 'relative/dir';
        expect(job.offHostDir()).toBe('');
        process.env.BACKUP_OFFHOST_DIR = path.join(process.env.BACKUP_DIR, 'copy');
        expect(job.offHostDir()).toBe('');
        process.env.BACKUP_OFFHOST_DIR = path.join(dir, 'elsewhere');
        expect(job.offHostDir()).toBe(path.join(dir, 'elsewhere'));
    });

    test('legacy plaintext dumps stay, are flagged encrypted:false and count in the unchanged retention', async () => {
        fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.BACKUP_DIR, `${DB}-2026-01-01.dump`), 'PGDMP-old');
        fs.writeFileSync(path.join(process.env.BACKUP_DIR, `${DB}-2026-01-02.dump`), 'PGDMP-old2');
        const job = freshJob();
        let st = await job.status();
        expect(st.plaintextCount).toBe(2);
        expect(st.unreadableCount).toBe(0);
        expect(st.files.every((f) => f.encrypted === false)).toBe(true);
        expect(st.offHost.dir).toBeNull();
        expect(st.encryption).toMatchObject({ ok: true, protection: 'app-key-derived' });

        mockOverrides.backupKeep = 2;
        await job.tick({ force: true });
        st = await job.status();
        expect(st.files.map((f) => [f.name.replace(/T\d+/, 'T'), f.encrypted])).toEqual([
            [`${DB}-` + new Date().toISOString().slice(0, 10) + 'T.dump.enc', true],
            [`${DB}-2026-01-02.dump`, false],
        ]);
        expect(st.plaintextCount).toBe(1);
    });
});

describe('SA-39 — the health page flags what is not protected', () => {
    const ejs = require('ejs');
    const fr = require('../../locales/fr/admin.json');
    const section = () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../views/pages/admin/health.ejs'),
            'utf8'
        );
        const a = src.indexOf('<%# SA-39');
        const b = src.indexOf('<form method="POST" action="/admin/health/backup"');
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(a);
        return src.slice(a, b);
    };
    const render = (backup) =>
        ejs.render(section(), {
            backup,
            _fdt: (d) => String(d),
            __: (k, o = {}) =>
                String(fr[k.replace(/^admin:/, '')] || k).replace(/\{\{(\w+)\}\}/g, (_, n) => o[n]),
        });

    test('« non chiffrée », no off-host target, derived key and unreadable backups are all said', async () => {
        fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.BACKUP_DIR, `${DB}-2026-01-01.dump`), 'PGDMP-old');
        const job = freshJob();
        await job.tick({ force: true });
        const st = await job.status();
        const html = render(st);
        expect(html).toContain(fr.bkp_plain_warn.replace('{{n}}', '1'));
        expect(html).toContain(fr.bkp_offhost_unset);
        expect(html).toContain('42 TOC entries');
        expect(html).toContain('dérivée d’APP_KEY');
        expect(html).toContain(fr.bkp_key_derived_hint);
        expect(html).not.toContain(fr.bkp_unreadable_warn.slice(10, 50));
        const lost = render({ ...st, unreadableCount: 2 });
        expect(lost).toContain(fr.bkp_unreadable_warn.replace('{{n}}', '2'));
        const dpapi = render({
            ...st,
            encryption: {
                ok: true,
                keyId: 'abcd',
                protection: 'dpapi-localmachine',
                exportedAt: null,
            },
        });
        expect(dpapi).toContain(fr.bkp_key_not_exported.split('<')[0]);
        const broken = render({ ...st, encryption: { ok: false, error: 'no APP_KEY' } });
        expect(broken).toContain('indisponible (no APP_KEY)');
    });

    test('each file row and each restore point carries its protection badge', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../views/pages/admin/health.ejs'),
            'utf8'
        );
        expect(src.match(/admin:bkp_plain'\)/g).length).toBeGreaterThanOrEqual(2);
        expect(src.match(/admin:bkp_enc'\)/g).length).toBeGreaterThanOrEqual(2);
        expect(fr.bkp_plain).toBe('non chiffrée');
    });
});

describe('SA-39 — SQL-console restore points', () => {
    const svc = () => require('../../src/services/SqlConsoleService');
    beforeEach(() => {
        mockPool.connect.mockResolvedValue({
            query: jest.fn(async () => ({ rows: [] })),
            release() {},
        });
    });

    test('a restore point is written encrypted (+ manifest) and listed so; legacy points are flagged', async () => {
        const s = svc();
        const rp = await s.createRestorePoint('sql-console');
        expect(rp.encrypted).toBe(true);
        expect(rp.file.endsWith('.dump.enc')).toBe(true);
        expect(fs.existsSync(rp.file + '.manifest.json')).toBe(true);
        expect((await plainOf(rp.file)).equals(dumpBytes)).toBe(true);
        fs.writeFileSync(path.join(s._restoreDir(), 'old-legacy.dump'), 'PGDMP');
        const list = s.listRestorePoints();
        expect(list.find((r) => r.name === rp.name)).toMatchObject({
            encrypted: true,
            database: DB,
        });
        expect(list.find((r) => r.name === 'old-legacy')).toMatchObject({ encrypted: false });
        expect(s._restorePointFile(rp.name)).toMatchObject({ encrypted: true, scope: 'database' });
        expect(s._restorePointFile('old-legacy')).toMatchObject({ encrypted: false });
        // Contained: a traversal name never resolves.
        expect(s._restorePointFile('../' + rp.name)).toMatchObject({ file: rp.file });
        expect(s._restorePointFile('..')).toBeNull();
    });

    test('no key: no restore point (and so no destructive script)', async () => {
        delete process.env.APP_KEY;
        await expect(svc().createRestorePoint('sql-console')).rejects.toThrow(
            /encryption key unavailable/
        );
    });

    test('a TAMPERED encrypted point is refused before pg_restore ever reads it', async () => {
        const s = svc();
        const rp = await s.createRestorePoint('sql-console');
        const raw = fs.readFileSync(rp.file);
        raw[Math.floor(raw.length / 2)] ^= 0x01;
        fs.writeFileSync(rp.file, raw);
        cp.spawn.mockClear();
        const dbName = jest.spyOn(s, '_dumpDatabaseName');
        await expect(s.revertRestorePoint(rp.name)).rejects.toThrow(
            /Refusing to restore .*SHA-256 mismatch/
        );
        expect(dbName).not.toHaveBeenCalled();
        expect(cp.spawn).not.toHaveBeenCalled();
    });

    test('an intact encrypted point is identified from its decrypted stream (stdin), no clear file', async () => {
        const s = svc();
        const rp = await s.createRestorePoint('sql-console');
        restoreSeen = null;
        expect(await s._dumpDatabaseName(rp.file)).toBe(DB);
        expect(restoreSeen.args).toEqual(['-l']);
        expect(fs.readdirSync(path.dirname(rp.file)).some((n) => /\.dump$/.test(n))).toBe(false);
    });

    test('pruning removes an encrypted point with its manifest and sidecar', async () => {
        const s = svc();
        const rp = await s.createRestorePoint('sql-console');
        const old = new Date(Date.now() - 30 * 86400000);
        fs.utimesSync(rp.file, old, old);
        s._pruneRestorePoints(20);
        const left = fs.readdirSync(path.dirname(rp.file));
        expect(left.filter((n) => n.startsWith(rp.name))).toEqual([]);
    });
});
