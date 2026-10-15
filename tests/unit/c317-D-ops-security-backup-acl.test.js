'use strict';
/**
 * 3.23.17 lane D — S-01 (app side): a daily pg_dump landed in
 * %ProgramData%\IDevelop\backups with the folder's inherited ACL, i.e.
 * BUILTIN\Users:(RX) — any local account could read the whole HR database.
 *
 * tick() is driven for real: pg_dump is faked (it streams a non-empty dump on
 * stdout, which the job encrypts, SA-39), everything else in child_process -
 * icacls.exe included - is the REAL one, so on Windows the resulting ACL is
 * read back with icacls and checked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const realCp = jest.requireActual('child_process');
const mockIcaclsCalls = [];
const mockState = { icaclsMode: 'real' }; // 'real' | 'fail'
jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    return {
        ...actual,
        // SA-39: pg_dump writes to STDOUT (encrypted on the fly), so it is
        // spawned, not execFile'd. The fake streams a non-empty "dump", exits 0.
        spawn: jest.fn((cmd, args, opts) => {
            if (/pg_dump/i.test(String(cmd))) {
                const { EventEmitter } = require('events');
                const { PassThrough } = require('stream');
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.stdin = new PassThrough();
                child.kill = () => {};
                child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
                setImmediate(() => {
                    child.stdout.end('PGDMP-fake-dump-content');
                    child.stderr.end();
                });
                return child;
            }
            return actual.spawn(cmd, args, opts);
        }),
        execFile: jest.fn((cmd, args, opts, cb) => {
            if (/pg_dump/i.test(cmd)) {
                const f = args[args.indexOf('-f') + 1];
                require('fs').writeFileSync(f, 'PGDMP-fake-dump-content');
                return cb(null, '', '');
            }
            if (/icacls/i.test(cmd)) {
                mockIcaclsCalls.push(args);
                if (mockState.icaclsMode === 'fail')
                    return cb(new Error('icacls failed (simulated)'));
            }
            return actual.execFile(cmd, args, opts, cb);
        }),
    };
});
const mockSettings = {};
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) => d),
    setValue: jest.fn(async (k, v) => {
        mockSettings[k] = v;
    }),
}));
jest.mock('../../src/services/JobRunService', () => ({ alert: jest.fn(async () => {}) }));

let dir;
const saved = {};
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-bkacl-'));
    ['BACKUP_DIR', 'DATABASE_URL', 'APP_KEY', 'BACKUP_KEY_MODE'].forEach((k) => {
        saved[k] = process.env[k];
    });
    process.env.BACKUP_DIR = dir;
    // SA-39: backups are encrypted; the test key is derived from APP_KEY.
    process.env.APP_KEY = 'acl-test-app-key-0123456789abcdef';
    process.env.BACKUP_KEY_MODE = 'derived';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/acltestdb';
    mockIcaclsCalls.length = 0;
    mockState.icaclsMode = 'real';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    // Give ourselves full control back before deleting (we stay OWNER, so WRITE_DAC holds).
    if (process.platform === 'win32') {
        try {
            realCp.execFileSync('icacls.exe', [
                dir,
                '/grant',
                `${process.env.USERNAME}:(OI)(CI)F`,
                '/T',
                '/C',
                '/Q',
            ]);
        } catch {
            /* best effort */
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    ['BACKUP_DIR', 'DATABASE_URL', 'APP_KEY', 'BACKUP_KEY_MODE'].forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    });
    jest.restoreAllMocks();
});

function freshBackup() {
    let mod;
    jest.isolateModules(() => {
        mod = require('../../src/jobs/db-backup');
    });
    return mod;
}

test('a successful dump has its ACL restricted (SIDs, inheritance removed) and the backup stays ok', async () => {
    const r = await freshBackup().tick({ force: true });
    expect(r.done).toBe(true);
    expect(r.status).toBe('ok');
    if (process.platform === 'win32') {
        // The encrypted dump, then its manifest.
        expect(mockIcaclsCalls).toHaveLength(2);
        expect(mockIcaclsCalls[1][0]).toBe(r.file + '.manifest.json');
        expect(mockIcaclsCalls[0]).toEqual([
            r.file,
            '/inheritance:r',
            '/grant:r',
            '*S-1-5-18:F',
            '*S-1-5-32-544:F',
            '*S-1-3-4:F',
        ]);
        // Read the REAL resulting ACL back (as SIDs, locale-independent).
        const out = realCp
            .execFileSync('powershell.exe', [
                '-NoProfile',
                '-Command',
                `$a=Get-Acl -LiteralPath '${r.file}'; "PROTECTED=$($a.AreAccessRulesProtected)"; $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | % { $_.IdentityReference.Value }`,
            ])
            .toString();
        expect(out).toMatch(/PROTECTED=True/);
        expect(out).toMatch(/S-1-5-18/);
        expect(out).toMatch(/S-1-5-32-544/);
        expect(out).not.toMatch(/S-1-5-32-545/); // BUILTIN\Users
        expect(out).not.toMatch(/S-1-5-11\b/); // Authenticated Users
        expect(out).not.toMatch(/S-1-1-0\b/); // Everyone
    } else {
        expect((fs.statSync(r.file).mode & 0o777).toString(8)).toBe('600');
        expect((fs.statSync(r.file + '.manifest.json').mode & 0o777).toString(8)).toBe('600');
    }
});

test('restrictFileAcl resolves (never rejects) when icacls fails', async () => {
    mockState.icaclsMode = 'fail';
    const r = await freshBackup().restrictFileAcl(path.join(dir, 'x.dump'), 'win32');
    expect(r.ok).toBe(false);
});

(process.platform === 'win32' ? test : test.skip)(
    'an ACL step that fails never fails the backup (logged instead)',
    async () => {
        mockState.icaclsMode = 'fail';
        const t = await freshBackup().tick({ force: true });
        expect(t.status).toBe('ok');
        expect(mockSettings.backupLastStatus).toMatch(/^ok/);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringMatching(/could not restrict the ACL/)
        );
    }
);
