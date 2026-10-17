'use strict';
/**
 * SA-39 — on Linux and Docker the backup key is DERIVED from APP_KEY. Rotating
 * APP_KEY must not orphan the backups made before: scripts/rotate-app-key.js
 * keeps the old derived key in the backup keyring, re-wrapped under the new
 * APP_KEY. These tests prove a backup made BEFORE a rotation restores AFTER it
 * (twice over), that a failed rotation puts the keyring back, that the loud
 * failure mode (APP_KEY changed by hand) names its way out, and that the way
 * out (import-app-key) works.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const Crypto = require('../../src/services/BackupCryptoService');

const KEY_A = 'rotation-test-app-key-A-0123456789abcdef';
const KEY_B = 'rotation-test-app-key-B-fedcba9876543210';
const KEY_C = 'rotation-test-app-key-C-00112233445566778';

let dir;
const saved = {};
const ENV_KEYS = [
    'BACKUP_KEY_MODE',
    'BACKUP_KEYRING_FILE',
    'APP_KEY',
    'SESSION_SECRET',
    'NODE_ENV',
];
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idv-bkrot-'));
    ENV_KEYS.forEach((k) => (saved[k] = process.env[k]));
    process.env.BACKUP_KEY_MODE = 'derived';
    process.env.BACKUP_KEYRING_FILE = path.join(dir, 'keys', 'backup-keyring.json');
    process.env.APP_KEY = KEY_A;
    process.env.NODE_ENV = 'test';
    delete process.env.SESSION_SECRET;
    Crypto._resetCache();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    ENV_KEYS.forEach((k) =>
        saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
    );
    jest.restoreAllMocks();
    Crypto._resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
});

async function backup(name, content) {
    const f = path.join(dir, `${name}.dump.enc`);
    Crypto._resetCache();
    await Crypto.encryptStreamToFile(Readable.from([Buffer.from(content)]), f, {
        kind: 'db-backup',
    });
    return f;
}

async function plainOf(file) {
    const parts = [];
    await new Promise((res, rej) =>
        Crypto.openPlainStream(file)
            .on('data', (d) => parts.push(d))
            .on('end', res)
            .on('error', rej)
    );
    return Buffer.concat(parts).toString();
}

/** The same three steps scripts/rotate-app-key.js runs around its transaction. */
async function rotate(oldKey, newKey, { dbFails = false } = {}) {
    const plan = await Crypto.prepareAppKeyRotation({ oldAppKey: oldKey, newAppKey: newKey });
    await Crypto.commitAppKeyRotation(plan);
    if (dbFails) {
        await Crypto.abortAppKeyRotation(plan);
        return plan;
    }
    await Crypto.finalizeAppKeyRotation(plan);
    process.env.APP_KEY = newKey; // the operator edits .env and restarts
    Crypto._resetCache();
    return plan;
}

describe('SA-39 — a backup made before an APP_KEY rotation restores after it', () => {
    test('one rotation: the old backup passes the restore gate and decrypts under the new APP_KEY', async () => {
        const before = await backup('db-2026-01-01', 'PGDMP-before-rotation');
        const plan = await rotate(KEY_A, KEY_B);
        expect(plan).toMatchObject({ retired: 1, carried: 0, unreadable: 0 });

        expect(await Crypto.assertRestorable(before)).toEqual({ encrypted: true, warning: null });
        expect(await plainOf(before)).toBe('PGDMP-before-rotation');
        // New backups use the new derived key.
        const after = await backup('db-2026-01-02', 'PGDMP-after-rotation');
        expect(Crypto.keyIdOfFile(after)).not.toBe(Crypto.keyIdOfFile(before));
        expect(await plainOf(after)).toBe('PGDMP-after-rotation');
        expect(Crypto.keyStatus().retiredKeys).toBe(1);
    });

    test('two rotations: every older key is carried forward and re-wrapped', async () => {
        const a = await backup('a', 'made-under-A');
        await rotate(KEY_A, KEY_B);
        const b = await backup('b', 'made-under-B');
        const plan = await rotate(KEY_B, KEY_C);
        expect(plan).toMatchObject({ retired: 1, carried: 1, unreadable: 0 });
        expect(await plainOf(a)).toBe('made-under-A');
        expect(await plainOf(b)).toBe('made-under-B');
        // After finalize, only the CURRENT APP_KEY's wraps remain in the ring.
        const ring = Crypto.readKeyring(process.env.BACKUP_KEYRING_FILE);
        const currentId = Crypto.keyIdOf(Crypto.derivedMasterKey(process.env));
        for (const e of ring.keys) expect(e.wraps.map((w) => w.by)).toEqual([currentId]);
        // No raw key material in the file.
        const raw = fs.readFileSync(process.env.BACKUP_KEYRING_FILE, 'utf8');
        for (const k of [KEY_A, KEY_B])
            expect(raw).not.toContain(
                Crypto.derivedMasterKey({ APP_KEY: k, NODE_ENV: 'test' }).toString('base64')
            );
    });

    test('a crash between the keyring write and the finalize loses nothing: both APP_KEYs open the ring', async () => {
        const a = await backup('a', 'made-under-A');
        await rotate(KEY_A, KEY_B);
        const b = await backup('b', 'made-under-B');
        const plan = await Crypto.prepareAppKeyRotation({ oldAppKey: KEY_B, newAppKey: KEY_C });
        await Crypto.commitAppKeyRotation(plan); // ...then the process dies
        Crypto._resetCache();
        expect(await plainOf(a)).toBe('made-under-A'); // still under KEY_B
        process.env.APP_KEY = KEY_C;
        Crypto._resetCache();
        expect(await plainOf(a)).toBe('made-under-A');
        expect(await plainOf(b)).toBe('made-under-B');
    });

    test('the dev SESSION_SECRET fallback rotates to a real APP_KEY without losing backups', async () => {
        delete process.env.APP_KEY;
        process.env.SESSION_SECRET = 'dev-session-secret-0123456789';
        const f = await backup('dev', 'dev-backup');
        const plan = await Crypto.prepareAppKeyRotation({
            oldAppKey: '',
            sessionSecret: process.env.SESSION_SECRET,
            newAppKey: KEY_B,
        });
        await Crypto.commitAppKeyRotation(plan);
        await Crypto.finalizeAppKeyRotation(plan);
        process.env.APP_KEY = KEY_B;
        Crypto._resetCache();
        expect(await plainOf(f)).toBe('dev-backup');
    });
});

describe('SA-39 — rotation failure modes are loud and reversible', () => {
    test('a failed database transaction puts the keyring back exactly as it was', async () => {
        await rotate(KEY_A, KEY_B);
        const before = fs.readFileSync(process.env.BACKUP_KEYRING_FILE, 'utf8');
        await rotate(KEY_B, KEY_C, { dbFails: true });
        expect(fs.readFileSync(process.env.BACKUP_KEYRING_FILE, 'utf8')).toBe(before);
    });

    test('a first rotation that fails removes the keyring it created', async () => {
        await rotate(KEY_A, KEY_B, { dbFails: true });
        expect(fs.existsSync(process.env.BACKUP_KEYRING_FILE)).toBe(false);
    });

    test('a corrupt keyring REFUSES the rotation before anything is written', async () => {
        fs.mkdirSync(path.dirname(process.env.BACKUP_KEYRING_FILE), { recursive: true });
        fs.writeFileSync(process.env.BACKUP_KEYRING_FILE, 'not json');
        await expect(
            Crypto.prepareAppKeyRotation({ oldAppKey: KEY_A, newAppKey: KEY_B })
        ).rejects.toThrow(/unreadable; fix or move it before rotating APP_KEY/);
        expect(fs.readFileSync(process.env.BACKUP_KEYRING_FILE, 'utf8')).toBe('not json');
    });

    test('an unwritable keyring location makes the commit throw (the script then stops)', async () => {
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'x');
        process.env.BACKUP_KEYRING_FILE = path.join(blocker, 'keys', 'ring.json');
        const plan = await Crypto.prepareAppKeyRotation({ oldAppKey: KEY_A, newAppKey: KEY_B });
        await expect(Crypto.commitAppKeyRotation(plan)).rejects.toThrow();
    });

    test('an entry no APP_KEY opens is counted and kept, never dropped', async () => {
        await rotate(KEY_A, KEY_B);
        const ring = Crypto.readKeyring(process.env.BACKUP_KEYRING_FILE);
        ring.keys[0].wraps[0].by = 'ffffffffffffffff';
        fs.writeFileSync(process.env.BACKUP_KEYRING_FILE, JSON.stringify(ring));
        const plan = await rotate(KEY_B, KEY_C);
        expect(plan.unreadable).toBe(1);
        const after = Crypto.readKeyring(process.env.BACKUP_KEYRING_FILE);
        expect(after.keys.some((e) => e.wraps.some((w) => w.by === 'ffffffffffffffff'))).toBe(true);
    });

    test('nothing to retire (no previous key, or no keyring location) is reported, not an error', async () => {
        expect(
            (await Crypto.prepareAppKeyRotation({ oldAppKey: '', newAppKey: KEY_B })).skipped
        ).toMatch(/no previous APP_KEY/);
        delete process.env.BACKUP_KEYRING_FILE;
        const p = await Crypto.prepareAppKeyRotation({ oldAppKey: KEY_A, newAppKey: KEY_B });
        expect(p.skipped).toMatch(/no keyring location/);
        expect(await Crypto.commitAppKeyRotation(p)).toBe(false);
        expect(await Crypto.finalizeAppKeyRotation(p)).toBe(false);
        expect(await Crypto.abortAppKeyRotation(p)).toBe(false);
    });
});

describe('SA-39 — APP_KEY changed by hand: the failure names its way out, and the way out works', () => {
    test('BACKUP_KEY_UNKNOWN, then import-app-key with the previous APP_KEY restores access', async () => {
        const f = await backup('old', 'made-under-A');
        process.env.APP_KEY = KEY_B; // edited in .env without the rotation script
        Crypto._resetCache();
        const err = await Crypto.assertRestorable(f).catch((e) => e);
        expect(err.code).toBe('BACKUP_KEY_UNKNOWN');
        expect(err.message).toMatch(/import-app-key/);

        const r = await Crypto.importPreviousAppKey(`${KEY_A}\n`);
        expect(r.keyId).toBe(Crypto.keyIdOfFile(f));
        Crypto._resetCache();
        expect(await plainOf(f)).toBe('made-under-A');
        expect(await Crypto.importPreviousAppKey(KEY_B)).toMatchObject({ alreadyCurrent: true });
        await expect(Crypto.importPreviousAppKey('  ')).rejects.toThrow(/no previous APP_KEY/);
    });
});

describe('SA-39 — rotate-app-key.js wiring', () => {
    const rot = require('../../scripts/rotate-app-key');
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/rotate-app-key.js'), 'utf8');

    test('the keyring is prepared and written BEFORE the database transaction, finalized after, aborted on failure', () => {
        const prep = src.indexOf('BackupCrypto.prepareAppKeyRotation(');
        const commit = src.indexOf('BackupCrypto.commitAppKeyRotation(ring)');
        const tx = src.indexOf('await db.runTransaction(');
        const fin = src.indexOf('BackupCrypto.finalizeAppKeyRotation(ring)');
        const abort = src.indexOf('BackupCrypto.abortAppKeyRotation(ring)');
        expect(prep).toBeGreaterThan(0);
        expect(commit).toBeGreaterThan(prep);
        expect(tx).toBeGreaterThan(commit);
        expect(fin).toBeGreaterThan(tx);
        expect(abort).toBeGreaterThan(tx);
        expect(src).toMatch(/ROTATION REFUSED \(nothing changed\)/);
    });

    test('the keyring summary holds counts only (no key, id or path)', () => {
        const line = rot.backupKeyringSummary({
            ring: {},
            retired: 1,
            carried: '2',
            unreadable: -3,
            file: '/secret/path',
            newKeyId: 'abcdef0123456789',
        });
        expect(line).toBe(
            'backup keyring: 1 key(s) retired now, 2 older key(s) re-wrapped under the new APP_KEY'
        );
        expect(rot.backupKeyringSummary({ ring: null, skipped: 'x' })).toMatch(/unchanged/);
        expect(rot.backupKeyringSummary(null)).toMatch(/not prepared/);
        expect(
            rot.backupKeyringSummary({ ring: {}, retired: 0, carried: 0, unreadable: 2 })
        ).toMatch(/2 entr\(y\/ies\) no APP_KEY opens/);
    });

    test('the plan never carries the raw key into the summary', () => {
        const fakeKey = crypto.randomBytes(32);
        const line = rot.backupKeyringSummary({ ring: {}, retired: 1, _newKey: fakeKey });
        expect(line).not.toContain(fakeKey.toString('hex'));
        expect(line).not.toContain(fakeKey.toString('base64'));
    });
});
