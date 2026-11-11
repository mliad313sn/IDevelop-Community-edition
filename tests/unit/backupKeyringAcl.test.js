'use strict';
/**
 * SA-39 — the backup keyring stays readable by the Windows service account.
 *
 * Exporting or importing a key rewrites the keyring, and restrictAcl resets its
 * DACL to SYSTEM + Administrators + OWNER RIGHTS. A virtual service account
 * (NT SERVICE\<name>, SIDs S-1-5-80-*) would lose Read and every later backup
 * would fail closed. The service principals' explicit ACEs read BEFORE the
 * rewrite are granted Read again AFTER restrictAcl, plus NT SERVICE\<SERVICE_NAME>;
 * an unknown account (icacls error) is ignored; a recovery file or a decrypted
 * dump (restrictAcl alone) never gets the service.
 *
 * child_process.execFile is mocked: no real icacls and no real DPAPI.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const Crypto = require('../../src/services/BackupCryptoService');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let calls;
let dir;
let file;
let icaclsListing;
const savedEnv = {};

function fakeExecFile(exe, args, opts, cb) {
    calls.push({ exe, args: [...args] });
    if (exe === 'powershell.exe') {
        // Identity "DPAPI": what goes in on stdin comes back.
        let input = '';
        return {
            stdin: {
                on() {},
                end(d) {
                    input += d;
                    setImmediate(() => cb(null, input.trim(), ''));
                },
            },
        };
    }
    if (exe === 'icacls.exe') {
        if (args.length === 1) setImmediate(() => cb(null, icaclsListing, ''));
        else if (args[1] === '/grant' && /Unknown/.test(args[2]))
            setImmediate(() => cb(new Error('1332: No mapping between account names'), '', ''));
        else setImmediate(() => cb(null, 'processed file', ''));
        return {};
    }
    setImmediate(() => cb(new Error(`unexpected ${exe}`)));
    return {};
}

beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterAll(() => {
    Object.defineProperty(process, 'platform', realPlatform);
});

beforeEach(() => {
    calls = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idv-bkacl-'));
    file = path.join(dir, 'backup-keyring.json');
    for (const k of ['BACKUP_KEYRING_FILE', 'BACKUP_KEY_MODE', 'SERVICE_NAME', 'NODE_ENV'])
        savedEnv[k] = process.env[k];
    process.env.BACKUP_KEYRING_FILE = file;
    delete process.env.BACKUP_KEY_MODE;
    delete process.env.SERVICE_NAME;
    icaclsListing =
        `${file} NT SERVICE\\Custom Svc:(R)\r\n` +
        '                       *S-1-5-80-111-222-333:(R)\r\n' +
        '                       NT AUTHORITY\\SYSTEM:(F)\r\n' +
        '                       BUILTIN\\Administrators:(F)\r\n' +
        'Successfully processed 1 files; Failed processing 0 files\r\n';
    jest.spyOn(cp, 'execFile').mockImplementation(fakeExecFile);
    Crypto._resetCache();
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

const grants = () =>
    calls.filter((c) => c.exe === 'icacls.exe' && c.args[1] === '/grant').map((c) => c.args[2]);
const restrictIdx = () =>
    calls.findIndex((c) => c.exe === 'icacls.exe' && c.args.includes('/inheritance:r'));

describe('SA-39 — the keyring stays readable by the service account', () => {
    test('import on an existing keyring: service ACEs preserved and the configured service re-granted', async () => {
        await Crypto.addKeyToRing(file, crypto.randomBytes(32), { makeCurrent: true });
        const first = await Crypto.importRecovery(Crypto.formatRecovery(crypto.randomBytes(32)), {
            makeCurrent: false,
            env: process.env,
        });
        expect(first.keyId).toBeTruthy();
        expect(grants()).toEqual(
            expect.arrayContaining([
                'NT SERVICE\\Custom Svc:(R)',
                '*S-1-5-80-111-222-333:(R)',
                'NT SERVICE\\IDevelop:(R)',
            ])
        );
        // Each grant comes AFTER the DACL reset (else the reset would wipe it).
        const idx = (pred) =>
            calls
                .map((c, i) => (pred(c) ? i : -1))
                .filter((i) => i >= 0)
                .pop();
        const lastRestrict = idx(
            (c) => c.exe === 'icacls.exe' && c.args.includes('/inheritance:r')
        );
        const lastGrant = idx((c) => c.exe === 'icacls.exe' && c.args[1] === '/grant');
        expect(lastGrant).toBeGreaterThan(lastRestrict);
        // The DACL reset itself: SYSTEM + Administrators + OWNER RIGHTS, by SID.
        expect(calls[restrictIdx()].args).toEqual([
            file,
            '/inheritance:r',
            '/grant:r',
            '*S-1-5-18:F',
            '*S-1-5-32-544:F',
            '*S-1-3-4:F',
        ]);
        // execFile only, never a shell.
        expect(calls.every((c) => c.exe === 'icacls.exe' || c.exe === 'powershell.exe')).toBe(true);
    });

    test('export (stamps exportedAt) keeps the service on the keyring; SERVICE_NAME is honoured', async () => {
        process.env.SERVICE_NAME = 'HR-Prod';
        await Crypto.addKeyToRing(file, crypto.randomBytes(32), { makeCurrent: true });
        calls = [];
        const r = await Crypto.exportRecovery({ env: process.env, platform: 'win32' });
        expect(r.recovery).toBeTruthy();
        const g = grants();
        expect(g).toEqual(
            expect.arrayContaining([
                'NT SERVICE\\Custom Svc:(R)',
                '*S-1-5-80-111-222-333:(R)',
                'NT SERVICE\\HR-Prod:(R)',
            ])
        );
        expect(g).not.toContain('NT SERVICE\\IDevelop:(R)');
        const ring = Crypto.readKeyring(file);
        expect(ring.keys.find((e) => e.id === r.keyId).exportedAt).toBeTruthy();
    });

    test('an account icacls cannot resolve is ignored (the write still succeeds)', async () => {
        process.env.SERVICE_NAME = 'UnknownSvc';
        icaclsListing = `${file} NT AUTHORITY\\SYSTEM:(F)\r\n`;
        await expect(
            Crypto.addKeyToRing(file, crypto.randomBytes(32), { makeCurrent: true })
        ).resolves.toBeTruthy();
        expect(grants()).toEqual(['NT SERVICE\\UnknownSvc:(R)']);
    });

    test('a SERVICE_NAME icacls must not see is never passed to it', async () => {
        process.env.SERVICE_NAME = 'bad name; & calc';
        icaclsListing = `${file} NT AUTHORITY\\SYSTEM:(F)\r\n`;
        await Crypto.addKeyToRing(file, crypto.randomBytes(32), { makeCurrent: true });
        expect(grants()).toEqual([]);
    });

    test('restrictAcl alone (recovery file, decrypted dump) never grants the service', async () => {
        const out = path.join(dir, 'backup-recovery-x.txt');
        fs.writeFileSync(out, 'x');
        await Crypto.restrictAcl(out);
        expect(grants()).toEqual([]);
    });
});
