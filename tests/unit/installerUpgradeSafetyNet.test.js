'use strict';
/**
 * The upgrade safety net of the Windows installer (SA-57):
 *
 *  - an encrypted, verified database dump before an upgrade's migrations
 *    (scripts/pre-upgrade-dump.js); a failed dump stops the run before any
 *    migration, -SkipPreMigrationDump is the logged way past it;
 *
 * Static contracts on the PowerShell source (it is not executed here) and the
 * pure helpers and fail-closed paths of the new scripts (pg_dump and pg_restore
 * are faked; the real round trip is preUpgradeDump-db.test.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

jest.setTimeout(30000);

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const INST = read('installer', 'Install-IDevelop.ps1');
const BUILD = read('installer', 'Build-Package.ps1');

describe('pre-migration dump: the script', () => {
    const D = require('../../scripts/pre-upgrade-dump');

    test('file name: pre-upgrade-<db>-<from>-to-<to>-<stamp>.dump.enc, outside the daily retention', () => {
        const n = D.dumpFileName('hr_db', '1.4.2', '1.5.0', new Date('2026-10-16T08:56:16Z'));
        expect(n).toBe('pre-upgrade-hr_db-1.4.2-to-1.5.0-20261016-085616.dump.enc');
        // The daily job prunes "<db>-..." only: never this file.
        const { isBackupName } = require('../../src/jobs/db-backup');
        expect(isBackupName(n, 'hr_db')).toBe(false);
        expect(D.safeLabel('../evil name', 'x')).toBe('..evilname');
        expect(D.safeLabel('a\\b/c', 'x')).toBe('abc');
        expect(D.safeLabel('', 'prev')).toBe('prev');
        expect(D.dumpFileName('', '', '', new Date('2026-01-02T03:04:05Z'))).toBe(
            'pre-upgrade-db-prev-to-new-20260102-030405.dump.enc'
        );
    });

    test('pg_dump in custom format on stdout (encrypted as produced): no -f, no password in argv', () => {
        const a = D.pgDumpArgs(new URL('postgres://u%40x:s3cret@db.local:5433/my_db'));
        expect(a).toEqual(['-h', 'db.local', '-p', '5433', '-U', 'u@x', '-d', 'my_db', '-F', 'c']);
        expect(a).not.toContain('-f');
        expect(a.join(' ')).not.toMatch(/s3cret/);
    });

    test('space check: table data + margin; unknown sizes are not a refusal', () => {
        const MB = 1048576;
        expect(D.spaceCheck(10 * 1024 * MB, 100 * MB).ok).toBe(true);
        const r = D.spaceCheck(200 * MB, 100 * MB);
        expect(r.ok).toBe(false);
        expect(r.detail).toMatch(/^not enough free space: 200 MB free, 356 MB needed/);
        expect(D.spaceCheck(NaN, 100 * MB).ok).toBe(true);
        expect(D.spaceCheck(10 * MB, NaN).ok).toBe(true);
        expect(D.SPACE_MARGIN).toBe(256 * MB);
    });
});

describe('pre-migration dump: run() fails closed and leaves nothing behind', () => {
    const ENV = [
        'DATABASE_URL',
        'BACKUP_KEY_MODE',
        'BACKUP_KEYRING_FILE',
        'APP_KEY',
        'SESSION_SECRET',
        'NODE_ENV',
    ];
    const saved = {};
    let dir;
    let mode; // dump: 'ok' | 'fail' | 'empty'; restore: 'ok' | 'fail'
    let seen;

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
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idv-preup-'));
        ENV.forEach((k) => (saved[k] = process.env[k]));
        process.env.DATABASE_URL = 'postgres://app:pw-not-in-argv@localhost:5432/hr_db';
        process.env.BACKUP_KEY_MODE = 'derived';
        process.env.BACKUP_KEYRING_FILE = path.join(dir, 'keys', 'backup-keyring.json');
        process.env.APP_KEY = 'pre-upgrade-test-app-key-0123456789';
        process.env.NODE_ENV = 'test';
        delete process.env.SESSION_SECRET;
        mode = { dump: 'ok', restore: 'ok' };
        seen = [];
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(cp, 'spawn').mockImplementation((bin, args, opts) =>
            fakeChild((ch) => {
                seen.push({ bin, args, env: opts && opts.env });
                if (/pg_dump/i.test(bin)) {
                    if (mode.dump === 'fail') {
                        ch.stdout.end();
                        ch.stderr.end('pg_dump: error: connection refused');
                        return setImmediate(() => ch.emit('close', 1));
                    }
                    ch.stdout.end(
                        mode.dump === 'empty'
                            ? Buffer.alloc(0)
                            : Buffer.concat([Buffer.from('PGDMP'), crypto.randomBytes(200000)])
                    );
                    ch.stderr.end();
                    setImmediate(() => ch.emit('close', 0));
                } else {
                    ch.stdin.resume();
                    ch.stdin.on('end', () => {
                        if (mode.restore === 'fail') {
                            ch.stdout.end();
                            ch.stderr.end('pg_restore: error: not a valid archive');
                            return setImmediate(() => ch.emit('close', 1));
                        }
                        ch.stdout.end(';\n;     TOC Entries: 17\n');
                        ch.stderr.end();
                        setImmediate(() => ch.emit('close', 0));
                    });
                }
            })
        );
    });
    afterEach(() => {
        ENV.forEach((k) =>
            saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
        );
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function fresh() {
        let mod;
        jest.isolateModules(() => {
            mod = require('../../scripts/pre-upgrade-dump');
        });
        return mod;
    }
    const out = () => path.join(dir, 'backups');
    const files = () => (fs.existsSync(out()) ? fs.readdirSync(out()) : []);

    test('success: one encrypted dump + manifest, verified, password only in the child env', async () => {
        const r = await fresh().run({
            from: '1.4.2',
            to: '1.5.0',
            outDir: out(),
            pgDumpBin: 'pg_dump',
            dataBytes: 0,
        });
        expect(r).toMatchObject({ ok: true, verify: '17 TOC entries' });
        expect(path.basename(r.file)).toMatch(
            /^pre-upgrade-hr_db-1\.4\.2-to-1\.5\.0-\d{8}-\d{6}\.dump\.enc$/
        );
        expect(files().sort()).toEqual(
            [path.basename(r.file), path.basename(r.file) + '.manifest.json'].sort()
        );
        const head = fs.readFileSync(r.file).subarray(0, 8).toString('latin1');
        expect(head).toBe('IDVBKENC');
        const dump = seen.find((s) => /pg_dump/.test(s.bin));
        expect(dump.args.join(' ')).not.toMatch(/pw-not-in-argv/);
        expect(dump.env.PGPASSWORD).toBe('pw-not-in-argv');
        expect(JSON.stringify(r)).not.toMatch(/pw-not-in-argv/);
    });

    test.each([
        ['pg_dump error', { dump: 'fail' }, /pg_dump exit 1/],
        ['empty dump', { dump: 'empty' }, /^empty dump/],
        [
            'verification refused',
            { restore: 'fail' },
            /^verification failed: pg_restore --list exit 1/,
        ],
    ])('%s: exit 1, no file left', async (_label, m, err) => {
        Object.assign(mode, m);
        const r = await fresh().run({ outDir: out(), pgDumpBin: 'pg_dump', dataBytes: 0 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(err);
        expect(files()).toEqual([]);
    });

    test('not enough space: refused before pg_dump starts', async () => {
        const r = await fresh().run({
            outDir: out(),
            pgDumpBin: 'pg_dump',
            dataBytes: Number.MAX_SAFE_INTEGER / 2,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^not enough free space/);
        expect(seen).toEqual([]);
        expect(files()).toEqual([]);
    });

    test('no DATABASE_URL, or no key: refused, nothing written', async () => {
        delete process.env.DATABASE_URL;
        expect(await fresh().run({ outDir: out() })).toEqual({
            ok: false,
            error: 'DATABASE_URL is not set',
        });
        process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/hr_db';
        delete process.env.APP_KEY;
        const r = await fresh().run({ outDir: out(), pgDumpBin: 'pg_dump', dataBytes: 0 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/encryption key/);
        expect(seen).toEqual([]);
        expect(files()).toEqual([]);
    });
});

describe('pre-migration dump: the installer', () => {
    test('taken after the pre-flight and BEFORE "Applying database migrations", fail closed', () => {
        const dump = INST.indexOf(
            "@('scripts\\pre-upgrade-dump.js', '--from', $fromV, '--to', $toV"
        );
        const apply = INST.indexOf("Log 'Applying database migrations...'");
        const preflight = INST.indexOf("'db:migrate:preflight'");
        expect(preflight).toBeGreaterThan(0);
        expect(dump).toBeGreaterThan(preflight);
        expect(dump).toBeLessThan(apply);
        const block = INST.slice(INST.indexOf('$script:PreUpgradeDump = $null'), apply);
        expect(block).toMatch(/if \(\$dcode -ne 0\) \{ Fail "Pre-migration database dump FAILED/);
        // A package without the script is refused too (never "no dump, carry on").
        expect(block).toMatch(
            /elseif \(-not \(Test-Path[^\n]*pre-upgrade-dump\.js'\)\)\) \{\n\s+Fail /
        );
        // only on an existing install, never on -Reinstall (the database is recreated)
        expect(block).toMatch(/if \(\$priorInstallDir -and -not \$Reinstall\) \{/);
        // the switch is logged, and visible in the summary
        expect(block).toMatch(
            /if \(\$SkipPreMigrationDump\) \{\n\s+Log '[^']*SKIPPED[^']*' 'WARN'/
        );
        expect(INST).toMatch(/\[switch\]\$SkipPreMigrationDump\n\)/);
        expect(INST).toMatch(/\.PARAMETER SkipPreMigrationDump/);
        expect(INST).toMatch(/DB dump \(pre\) : \$\(\$script:PreUpgradeDump\)/);
    });

    test('the dump runs inside the migration branch, so an app-only patch takes none', () => {
        const skip = INST.indexOf(
            "if ($SkipMigrations -and $Patch) {\n    Log 'Migrations SKIPPED"
        );
        const dump = INST.indexOf('$script:PreUpgradeDump = $null');
        const elseAt = INST.indexOf('} else {', skip);
        expect(skip).toBeGreaterThan(0);
        expect(dump).toBeGreaterThan(elseAt);
    });

    test('credentials: the child env carries DATABASE_URL, the argv only versions and a folder', () => {
        const line = INST.split('\n').find((l) =>
            l.includes("'scripts\\pre-upgrade-dump.js', '--from'")
        );
        expect(line).toMatch(/-EnvVars \$dumpEnv$/);
        expect(line).not.toMatch(/Password|DATABASE_URL|\$dbUrl/);
        expect(INST).toMatch(/\$dumpEnv = \$childEnv\.Clone\(\)/);
        expect(INST).toMatch(/\$dumpEnv\['PG_DUMP_PATH'\] = \$pgDumpExe/);
    });

    test('the script ships with the product', () => {
        expect(BUILD).toMatch(/^\s+'pre-upgrade-dump\.js',/m);
    });

    test('new installer lines are ASCII', () => {
        const block = INST.slice(
            INST.indexOf('# PRE-MIGRATION DUMP (SA-57)'),
            INST.indexOf("Log 'Applying database migrations...'")
        );
        expect([...block].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
    });
});
