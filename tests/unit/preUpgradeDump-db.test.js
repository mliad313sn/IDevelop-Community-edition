'use strict';
/**
 * SA-57 — the pre-migration dump with the REAL pg_dump and pg_restore against
 * the test database: the file is encrypted, verified, restorable through
 * `backup-key.js pipe` (pg_restore --list on the decrypted stream), and the
 * command line never carries the password. Read-only on the database.
 *
 * Skipped when DATABASE_URL is not a test database, or when the pg_dump on
 * PATH is older than the server (pg_dump refuses a newer server).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

jest.setTimeout(120000);

const ROOT = path.join(__dirname, '..', '..');

function clientMajor(bin) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    const m = r.status === 0 && /(\d+)(?:\.\d+)?/.exec(r.stdout || '');
    return m ? Number(m[1]) : null;
}

async function serverMajor(url) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
        const r = await c.query('SHOW server_version_num');
        return Math.floor(Number(r.rows[0].server_version_num) / 10000);
    } finally {
        await c.end();
    }
}

let usable = false;
let dir;
const saved = {};
const ENV = ['BACKUP_KEY_MODE', 'BACKUP_KEYRING_FILE', 'APP_KEY'];

beforeAll(async () => {
    if (!isTestDatabaseUrl(process.env.DATABASE_URL)) return;
    const dump = clientMajor('pg_dump');
    const restore = clientMajor('pg_restore');
    if (!dump || !restore) return;
    try {
        usable = dump >= (await serverMajor(process.env.DATABASE_URL));
    } catch (_) {
        usable = false;
    }
});

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idv-preup-db-'));
    ENV.forEach((k) => (saved[k] = process.env[k]));
    process.env.BACKUP_KEY_MODE = 'derived';
    process.env.BACKUP_KEYRING_FILE = path.join(dir, 'keys', 'backup-keyring.json');
    process.env.APP_KEY = process.env.APP_KEY || 'pre-upgrade-db-test-app-key-0123456789';
});
afterEach(() => {
    ENV.forEach((k) =>
        saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
    );
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a real dump of the test database: encrypted, verified, restorable by backup-key.js pipe', async () => {
    if (!usable) return;
    const out = path.join(dir, 'backups');
    const stdout = execFileSync(
        process.execPath,
        [
            path.join(ROOT, 'scripts', 'pre-upgrade-dump.js'),
            '--from',
            '1.0.0',
            '--to',
            '1.1.0',
            '--out-dir',
            out,
        ],
        { env: { ...process.env }, encoding: 'utf8', cwd: ROOT }
    );
    const line = stdout.trim().split('\n').pop();
    expect(line.startsWith('PRE_UPGRADE_DUMP ')).toBe(true);
    const res = JSON.parse(line.slice('PRE_UPGRADE_DUMP '.length));
    expect(res.ok).toBe(true);
    expect(res.verify).toMatch(/^\d+ TOC entries$/);
    expect(Number(res.verify.split(' ')[0])).toBeGreaterThan(50);
    expect(path.basename(res.file)).toMatch(
        /^pre-upgrade-.+-1\.0\.0-to-1\.1\.0-\d{8}-\d{6}\.dump\.enc$/
    );
    expect(fs.existsSync(res.file + '.manifest.json')).toBe(true);
    // Nothing clear on disk, and the connection secret is not in the output.
    expect(fs.readdirSync(out).filter((f) => !/\.dump\.enc(\.manifest\.json)?$/.test(f))).toEqual(
        []
    );
    expect(stdout).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(stdout).not.toMatch(/PGPASSWORD|password/i);
    expect(fs.readFileSync(res.file).subarray(0, 8).toString('latin1')).toBe('IDVBKENC');
    // Owner-only on Linux (SYSTEM + Administrators + owner on Windows).
    if (process.platform !== 'win32') expect(fs.statSync(res.file).mode & 0o077).toBe(0);

    // The runbook's restore path: verify, then pipe into pg_restore (here --list).
    execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'backup-key.js'), 'verify', '--in', res.file],
        { env: { ...process.env }, encoding: 'utf8' }
    );
    const list = execFileSync(
        process.execPath,
        [
            path.join(ROOT, 'scripts', 'backup-key.js'),
            'pipe',
            '--in',
            res.file,
            '--run',
            'pg_restore',
            '--list',
        ],
        { env: { ...process.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    expect(list).toMatch(/TABLE public schema_meta/);
    expect(list).toMatch(/TABLE DATA public employees/);
});
