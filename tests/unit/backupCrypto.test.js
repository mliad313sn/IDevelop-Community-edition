'use strict';
/**
 * SA-39 — encrypted backups: AES-256-GCM stream, DPAPI-held or APP_KEY-derived
 * master key, a SHA-256 manifest checked before any restore, legacy plaintext
 * dumps flagged and still restorable.
 *
 * Behavioural: real crypto on real temp files. DPAPI (powershell.exe) is a
 * mocked execFile, so no machine keyring is ever touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const cp = require('child_process');

const Crypto = require('../../src/services/BackupCryptoService');

let dir;
const saved = {};
const ENV_KEYS = [
    'BACKUP_KEY_MODE',
    'BACKUP_KEYRING_FILE',
    'APP_KEY',
    'SESSION_SECRET',
    'NODE_ENV',
    'ProgramData',
];
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idv-bkc-'));
    ENV_KEYS.forEach((k) => (saved[k] = process.env[k]));
    process.env.BACKUP_KEY_MODE = 'derived';
    process.env.APP_KEY = 'unit-test-app-key-for-backups-0123456789';
    process.env.NODE_ENV = 'test';
    delete process.env.BACKUP_KEYRING_FILE;
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

const master = (seed = 'a') => {
    const key = crypto.createHash('sha256').update(seed).digest();
    return { key, keyId: Crypto.keyIdOf(key) };
};
const resolverFor =
    (...ms) =>
    async (id) =>
        (ms.find((m) => m.keyId === id) || {}).key || null;

async function encryptBuf(buf, m, chunkSize) {
    const out = path.join(dir, `f-${crypto.randomBytes(4).toString('hex')}.dump.enc`);
    if (chunkSize) {
        const enc = Crypto.createEncryptStream(m, { chunkSize });
        const parts = [];
        await new Promise((res, rej) =>
            Readable.from([buf])
                .pipe(enc)
                .on('data', (d) => parts.push(d))
                .on('end', res)
                .on('error', rej)
        );
        fs.writeFileSync(out, Buffer.concat(parts));
        const h = await Crypto.sha256File(out);
        await Crypto.writeManifest(out, { keyId: m.keyId, masterKey: m.key, kind: 't', ...h });
        return out;
    }
    await Crypto.encryptStreamToFile(Readable.from([buf]), out, { master: m, kind: 't' });
    return out;
}

async function decryptFile(file, resolveKey) {
    const parts = [];
    await new Promise((res, rej) =>
        Crypto.openPlainStream(file, resolveKey ? { resolveKey } : {})
            .on('data', (d) => parts.push(d))
            .on('end', res)
            .on('error', rej)
    );
    return Buffer.concat(parts);
}

describe('SA-39 — the format constants are IDevelop’s own and frozen', () => {
    test('magic, DPAPI entropy, derived salt and key-id label', () => {
        expect(Crypto.MAGIC.toString('ascii')).toBe('IDVBKENC');
        expect(Crypto.MAGIC.length).toBe(8);
        expect(Crypto.DPAPI_ENTROPY).toBe('IDevelop.backup-key.v1');
        expect(Crypto.DERIVED_SALT).toBe('idevelop.backup.v1');
        expect(Crypto.KEYID_LABEL).toBe('idevelop-backup-keyid|');
    });

    test('the derived key and its id are stable for a given APP_KEY (a change would orphan backups)', () => {
        const k = Crypto.derivedMasterKey({ APP_KEY: 'fixed-reference-app-key', NODE_ENV: 'test' });
        expect(k.toString('hex')).toBe(
            Buffer.from(
                crypto.hkdfSync(
                    'sha256',
                    'fixed-reference-app-key',
                    'idevelop.backup.v1',
                    'backup-master',
                    32
                )
            ).toString('hex')
        );
        expect(Crypto.keyIdOf(k)).toBe(
            crypto
                .createHash('sha256')
                .update('idevelop-backup-keyid|')
                .update(k)
                .digest('hex')
                .slice(0, 16)
        );
    });

    test('production never derives from SESSION_SECRET; development may', () => {
        expect(Crypto.derivedMasterKey({ SESSION_SECRET: 's', NODE_ENV: 'production' })).toBeNull();
        expect(
            Crypto.derivedMasterKey({ SESSION_SECRET: 's', NODE_ENV: 'development' })
        ).toHaveLength(32);
    });
});

describe('SA-39 — encryption round trip', () => {
    test('a multi-chunk dump decrypts byte for byte, and the file holds no plaintext', async () => {
        const m = master();
        const plain = Buffer.concat([
            Buffer.from('PGDMP'),
            crypto.randomBytes(300 * 1024),
            Buffer.from('PERSON-NAME-MARKER'),
        ]);
        const f = await encryptBuf(plain, m, 64 * 1024);
        const raw = fs.readFileSync(f);
        expect(raw.subarray(0, 8).toString()).toBe('IDVBKENC');
        expect(raw.includes(Buffer.from('PERSON-NAME-MARKER'))).toBe(false);
        expect(raw.includes(Buffer.from('PGDMP'))).toBe(false);
        expect((await decryptFile(f, resolverFor(m))).equals(plain)).toBe(true);
        expect(Crypto.keyIdOfFile(f)).toBe(m.keyId);
    });

    test('empty input and exact chunk multiples round-trip too', async () => {
        const m = master();
        for (const plain of [Buffer.alloc(0), crypto.randomBytes(4096 * 3)]) {
            const f = await encryptBuf(plain, m, 4096);
            expect((await decryptFile(f, resolverFor(m))).equals(plain)).toBe(true);
        }
    });

    test('the default 1 MiB chunk path writes the file and a signed manifest', async () => {
        const m = master();
        const plain = crypto.randomBytes(2.5 * 1024 * 1024);
        const f = await encryptBuf(plain, m);
        expect(fs.existsSync(f + '.manifest.json')).toBe(true);
        expect(fs.existsSync(f + '.partial')).toBe(false);
        const man = JSON.parse(fs.readFileSync(f + '.manifest.json', 'utf8'));
        expect(man).toMatchObject({
            keyId: m.keyId,
            sizeBytes: fs.statSync(f).size,
            format: 'idevelop-backup-manifest-v1',
        });
        expect(man.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(man.hmac).toMatch(/^[0-9a-f]{64}$/);
        expect(man.appVersion).toEqual(require('../../package.json').version);
        expect((await decryptFile(f, resolverFor(m))).equals(plain)).toBe(true);
    });

    test('encryptFile + verifyDecrypt + assertRestorable with the derived key', async () => {
        const src = path.join(dir, 'plain.dump');
        fs.writeFileSync(src, 'PGDMP' + 'x'.repeat(5000));
        const out = path.join(dir, 'plain.dump.enc');
        const r = await Crypto.encryptFile(src, out, { kind: 'manual' });
        const k = await Crypto.getCurrentKey();
        expect(k.protection).toBe('app-key-derived');
        expect(r.keyId).toBe(k.keyId);
        expect(await Crypto.verifyDecrypt(out)).toMatchObject({ ok: true, plainBytes: 5005 });
        expect(await Crypto.assertRestorable(out)).toEqual({ encrypted: true, warning: null });
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/DERIVED FROM APP_KEY/));
    });

    test('no key at all fails closed', async () => {
        delete process.env.APP_KEY;
        delete process.env.SESSION_SECRET;
        await expect(Crypto.getCurrentKey()).rejects.toThrow(/Backup key unavailable/);
    });
});

describe('SA-39 — tamper, truncation, wrong key', () => {
    test('one flipped byte in a chunk fails decryption and the restore gate refuses', async () => {
        const m = master();
        const f = await encryptBuf(crypto.randomBytes(20000), m, 4096);
        const raw = fs.readFileSync(f);
        raw[raw.length - 5000] ^= 0x01;
        fs.writeFileSync(f, raw);
        await expect(decryptFile(f, resolverFor(m))).rejects.toThrow(
            /authentication failed on chunk/
        );
        await expect(Crypto.assertRestorable(f, { resolveKey: resolverFor(m) })).rejects.toThrow(
            /Refusing to restore .*SHA-256 mismatch/
        );
    });

    test('a flipped byte is still caught by the decryption pass when the manifest was re-signed', async () => {
        const m = master();
        const f = await encryptBuf(crypto.randomBytes(20000), m, 4096);
        const raw = fs.readFileSync(f);
        raw[raw.length - 100] ^= 0x80;
        fs.writeFileSync(f, raw);
        const h = await Crypto.sha256File(f);
        await Crypto.writeManifest(f, { keyId: m.keyId, masterKey: m.key, kind: 't', ...h });
        expect((await Crypto.verifyDecrypt(f, { resolveKey: resolverFor(m) })).ok).toBe(false);
        await expect(Crypto.assertRestorable(f, { resolveKey: resolverFor(m) })).rejects.toThrow(
            /Refusing to restore/
        );
    });

    test('a truncated file (final chunk dropped) and an extended file are refused', async () => {
        const m = master();
        const f = await encryptBuf(crypto.randomBytes(10000), m, 4096);
        const raw = fs.readFileSync(f);
        const lastLen = 4 + (10000 - 8192) + 16;
        fs.writeFileSync(f, raw.subarray(0, raw.length - lastLen));
        await expect(decryptFile(f, resolverFor(m))).rejects.toThrow(/truncated/);
        fs.writeFileSync(f, Buffer.concat([raw, Buffer.from('extra')]));
        await expect(decryptFile(f, resolverFor(m))).rejects.toThrow(/after the final chunk/);
        fs.writeFileSync(f, raw.subarray(0, 10));
        await expect(decryptFile(f, resolverFor(m))).rejects.toThrow(/header incomplete/);
    });

    test('a bad magic, an unknown version and a corrupt header are refused', async () => {
        const m = master();
        const f = await encryptBuf(Buffer.from('hello'), m, 4096);
        const raw = fs.readFileSync(f);
        const v = Buffer.from(raw);
        v[8] = 9;
        fs.writeFileSync(f, v);
        await expect(decryptFile(f, resolverFor(m))).rejects.toThrow(/unsupported/);
        const h = Buffer.from(raw);
        h[14] = 0x7b; // inside the JSON header
        h[13] = 0x22;
        fs.writeFileSync(f, h);
        await expect(
            new Promise((res, rej) => {
                const d = Crypto.createDecryptStream({ resolveKey: resolverFor(m) });
                d.on('data', () => {})
                    .on('end', res)
                    .on('error', rej);
                d.end(h);
            })
        ).rejects.toMatchObject({ code: 'BACKUP_INTEGRITY' });
    });

    test('the wrong master key cannot unwrap the data key; an unknown key says how to recover', async () => {
        const a = master('a');
        const b = master('b');
        const f = await encryptBuf(Buffer.from('hello'), a, 4096);
        await expect(decryptFile(f, async () => b.key)).rejects.toMatchObject({
            code: 'BACKUP_WRONG_KEY',
        });
        const err = await decryptFile(f, async () => null).catch((e) => e);
        expect(err.code).toBe('BACKUP_KEY_UNKNOWN');
        expect(err.message).toMatch(/import-app-key/);
        expect(err.message).toMatch(/docs\/BACKUPS\.md/);
        const v = await Crypto.verifyManifest(f, { resolveKey: async () => null });
        expect(v).toMatchObject({ ok: false, code: 'BACKUP_KEY_UNKNOWN' });
        await expect(
            Crypto.assertRestorable(f, { resolveKey: async () => null })
        ).rejects.toMatchObject({ code: 'BACKUP_KEY_UNKNOWN' });
    });

    test('an edited manifest (valid hash, forged field) fails its HMAC', async () => {
        const m = master();
        const f = await encryptBuf(Buffer.from('x'.repeat(5000)), m, 4096);
        const mf = f + '.manifest.json';
        const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
        man.createdAt = '2020-01-01T00:00:00.000Z';
        fs.writeFileSync(mf, JSON.stringify(man));
        const v = await Crypto.verifyManifest(f, { resolveKey: resolverFor(m) });
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/signature invalid/);
    });

    test('an encrypted backup with NO manifest is refused, so is a missing file', async () => {
        const m = master();
        const f = await encryptBuf(Buffer.from('abc'), m, 4096);
        fs.unlinkSync(f + '.manifest.json');
        await expect(Crypto.assertRestorable(f, { resolveKey: resolverFor(m) })).rejects.toThrow(
            /manifest missing/
        );
        expect((await Crypto.verifyManifest(path.join(dir, 'nope.enc'))).ok).toBe(false);
    });

    test('a manifest size mismatch is refused with a clear message', async () => {
        const m = master();
        const f = await encryptBuf(Buffer.from('abc'), m, 4096);
        const mf = f + '.manifest.json';
        const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
        man.sizeBytes += 1;
        fs.writeFileSync(mf, JSON.stringify(man));
        await expect(Crypto.assertRestorable(f, { resolveKey: resolverFor(m) })).rejects.toThrow(
            /size mismatch/
        );
    });
});

describe('SA-39 — legacy plaintext backups', () => {
    test('a plaintext .dump without manifest is still restorable, WITH a warning', async () => {
        const f = path.join(dir, 'db-2026-01-01.dump');
        fs.writeFileSync(f, 'PGDMP-legacy');
        const g = await Crypto.assertRestorable(f);
        expect(g.encrypted).toBe(false);
        expect(g.warning).toMatch(/UNENCRYPTED legacy backup with no integrity manifest/);
        expect((await decryptFile(f)).toString()).toBe('PGDMP-legacy');
        expect(Crypto.isEncryptedFile(f)).toBe(false);
        expect(Crypto.keyIdOfFile(f)).toBeNull();
    });
});

describe('SA-39 — tools spawned with the plaintext on stdin, or writing through the cipher', () => {
    const node = process.execPath;
    test('spawnToEncryptedFile encrypts a child’s stdout; spawnWithPlainStdin feeds it back', async () => {
        const f = path.join(dir, 'child.dump.enc');
        const r = await Crypto.spawnToEncryptedFile(
            node,
            ['-e', "process.stdout.write('PGDMP' + 'y'.repeat(70000))"],
            f,
            { kind: 'test' }
        );
        expect(r).toMatchObject({ ok: true, plainBytes: 70005, code: 0 });
        const back = await Crypto.spawnWithPlainStdin(
            node,
            [
                '-e',
                "let n=0;process.stdin.on('data',d=>n+=d.length).on('end',()=>process.stdout.write(String(n)))",
            ],
            f
        );
        expect(back).toMatchObject({ code: 0, stdout: '70005', streamError: null });
    });

    test('a failing child leaves no file, partial or manifest behind', async () => {
        const f = path.join(dir, 'fail.dump.enc');
        const r = await Crypto.spawnToEncryptedFile(
            node,
            ['-e', "process.stdout.write('x');process.stderr.write('boom');process.exit(3)"],
            f
        );
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/exit 3: boom/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});

describe('SA-39 — DPAPI keyring (powershell.exe mocked)', () => {
    const calls = [];
    function mockDpapi({ fail = false } = {}) {
        calls.length = 0;
        return jest.spyOn(cp, 'execFile').mockImplementation((cmd, args, opts, cb) => {
            if (!/powershell/i.test(cmd)) {
                setImmediate(() => cb(null, '', ''));
                return {};
            }
            const script = Buffer.from(
                args[args.indexOf('-EncodedCommand') + 1],
                'base64'
            ).toString('utf16le');
            const call = { cmd, args, script, stdin: '' };
            calls.push(call);
            return {
                stdin: {
                    on() {},
                    end(data) {
                        call.stdin = String(data);
                        setImmediate(() => {
                            if (fail) return cb(new Error('DPAPI unavailable'), '', 'boom');
                            const b = Buffer.from(call.stdin.trim(), 'base64');
                            const x = Buffer.from(b.map((v) => v ^ 0x5a)); // reversible stand-in
                            cb(null, x.toString('base64'), '');
                        });
                    },
                },
            };
        });
    }

    beforeEach(() => {
        delete process.env.BACKUP_KEY_MODE;
        process.env.BACKUP_KEYRING_FILE = path.join(dir, 'keys', 'backup-keyring.json');
    });

    test('first use creates a key, stores ONLY the DPAPI blob, and never puts the key on a command line', async () => {
        mockDpapi();
        const k = await Crypto.getCurrentKey(process.env, 'win32');
        expect(k.protection).toBe('dpapi-localmachine');
        const ring = JSON.parse(fs.readFileSync(process.env.BACKUP_KEYRING_FILE, 'utf8'));
        expect(ring.format).toBe('idevelop-backup-keyring-v1');
        expect(ring.current).toBe(k.keyId);
        const entry = ring.keys.find((e) => e.id === k.keyId);
        expect(Buffer.from(entry.blob, 'base64').equals(k.key)).toBe(false);
        const protect = calls.find((c) => /::Protect\(/.test(c.script));
        expect(protect.script).toMatch(/DataProtectionScope\]::LocalMachine/);
        expect(protect.script).toContain("GetBytes('IDevelop.backup-key.v1')");
        const keyB64 = k.key.toString('base64');
        expect(protect.args.join(' ')).not.toContain(keyB64);
        expect(protect.stdin.trim()).toBe(keyB64);
    });

    test('a fresh process unwraps the stored key through DPAPI Unprotect and gets the same key', async () => {
        mockDpapi();
        const first = await Crypto.getCurrentKey(process.env, 'win32');
        Crypto._resetCache();
        const again = await Crypto.getCurrentKey(process.env, 'win32');
        expect(again.key.equals(first.key)).toBe(true);
        expect(calls.some((c) => /::Unprotect\(/.test(c.script))).toBe(true);
    });

    test('DPAPI failure in production fails CLOSED (no derived-key fallback)', async () => {
        mockDpapi({ fail: true });
        process.env.NODE_ENV = 'production';
        await expect(Crypto.getCurrentKey(process.env, 'win32')).rejects.toThrow(
            /Backup key unavailable \(DPAPI\)/
        );
    });

    test('DPAPI failure in development falls back to the APP_KEY-derived key with a warning', async () => {
        mockDpapi({ fail: true });
        const k = await Crypto.getCurrentKey(process.env, 'win32');
        expect(k.protection).toBe('app-key-derived');
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/DERIVED FROM APP_KEY/));
    });

    test('export gives the recovery copy ONCE; importing it on another server restores decryption', async () => {
        mockDpapi();
        const k = await Crypto.getCurrentKey(process.env, 'win32');
        const f = await encryptBuf(Buffer.from('payroll'), k, 4096);
        const r = await Crypto.exportRecovery({ env: process.env, platform: 'win32' });
        expect(r.recovery).toMatch(/^IDVBK1-[0-9a-f]{16}-/);
        await expect(
            Crypto.exportRecovery({ env: process.env, platform: 'win32' })
        ).rejects.toMatchObject({ code: 'ALREADY_EXPORTED' });
        const again = await Crypto.exportRecovery({
            env: process.env,
            platform: 'win32',
            force: true,
        });
        expect(again.recovery).toBe(r.recovery);
        expect(Crypto.keyStatus(process.env, 'win32')).toMatchObject({
            ok: true,
            keyId: k.keyId,
            protection: 'dpapi-localmachine',
        });
        // "another server": empty keyring and a different APP_KEY.
        Crypto._resetCache();
        process.env.BACKUP_KEYRING_FILE = path.join(dir, 'other', 'ring.json');
        process.env.APP_KEY = 'another-server-app-key-0123456789abcdef';
        await expect(decryptFile(f)).rejects.toMatchObject({ code: 'BACKUP_KEY_UNKNOWN' });
        await Crypto.importRecovery(r.recovery, { env: process.env, platform: 'win32' });
        Crypto._resetCache();
        expect((await decryptFile(f)).toString()).toBe('payroll');
    });

    test('a mistyped or foreign recovery key is refused', () => {
        const good = Crypto.formatRecovery(master().key);
        expect(() =>
            Crypto.parseRecovery(good.slice(0, -1) + (good.endsWith('0') ? '1' : '0'))
        ).toThrow(/checksum/);
        expect(() => Crypto.parseRecovery('XYZBK1-' + good.slice(7))).toThrow(/not an IDevelop/);
        expect(() => Crypto.parseRecovery('x'.repeat(500))).toThrow(/not an IDevelop/);
        expect(Crypto.parseRecovery(good).equals(master().key)).toBe(true);
    });

    test('keyStatus is read-only: it never creates a key', () => {
        const spy = mockDpapi();
        const s = Crypto.keyStatus(process.env, 'win32');
        expect(s).toMatchObject({ ok: true, keyId: null, pending: true });
        expect(fs.existsSync(process.env.BACKUP_KEYRING_FILE)).toBe(false);
        expect(spy).not.toHaveBeenCalled();
    });

    test('an unreadable or foreign keyring file is ignored, not trusted', () => {
        fs.mkdirSync(path.dirname(process.env.BACKUP_KEYRING_FILE), { recursive: true });
        fs.writeFileSync(process.env.BACKUP_KEYRING_FILE, '{"keys":{"a":1}}');
        expect(Crypto.readKeyring(process.env.BACKUP_KEYRING_FILE)).toBeNull();
        fs.writeFileSync(
            process.env.BACKUP_KEYRING_FILE,
            JSON.stringify({
                format: 'idevelop-backup-keyring-v1',
                current: 'zz',
                keys: [{ id: '../../x', protection: 'dpapi-localmachine', blob: 'a' }, null],
            })
        );
        expect(Crypto.readKeyring(process.env.BACKUP_KEYRING_FILE)).toEqual({
            format: 'idevelop-backup-keyring-v1',
            current: null,
            keys: [],
        });
    });
});

describe('SA-39 — derived mode keeps a recovery path', () => {
    beforeEach(() => {
        process.env.BACKUP_KEYRING_FILE = path.join(dir, 'keys', 'backup-keyring.json');
    });

    test('export in derived mode gives a recovery line and says APP_KEY recovers it too', async () => {
        const r = await Crypto.exportRecovery({ env: process.env, platform: 'linux' });
        expect(r.recovery).toMatch(/^IDVBK1-/);
        expect(r.note).toMatch(/APP_KEY/);
    });

    test('an imported recovery copy is kept wrapped under APP_KEY, never in clear', async () => {
        const other = master('other-server');
        const f = await encryptBuf(Buffer.from('records'), other, 4096);
        await expect(decryptFile(f)).rejects.toMatchObject({ code: 'BACKUP_KEY_UNKNOWN' });
        await Crypto.importRecovery(Crypto.formatRecovery(other.key), {
            env: process.env,
            platform: 'linux',
        });
        const raw = fs.readFileSync(process.env.BACKUP_KEYRING_FILE, 'utf8');
        expect(raw).not.toContain(other.key.toString('base64'));
        const ring = Crypto.readKeyring(process.env.BACKUP_KEYRING_FILE);
        expect(ring.keys[0]).toMatchObject({ id: other.keyId, protection: 'app-key-wrapped' });
        Crypto._resetCache();
        expect((await decryptFile(f)).toString()).toBe('records');
        expect(Crypto.knownKeyIds(process.env, 'linux').has(other.keyId)).toBe(true);
        expect(Crypto.keyStatus(process.env, 'linux').retiredKeys).toBe(1);
    });

    test('import refuses a ring location it does not have', async () => {
        delete process.env.BACKUP_KEYRING_FILE;
        await expect(
            Crypto.importRecovery(Crypto.formatRecovery(master().key), { env: process.env })
        ).rejects.toThrow(/no keyring location/);
    });
});
