'use strict';

/**
 * BackupCryptoService — encryption at rest for whole-database files (SA-39):
 * the daily pg_dump, the SQL-console restore points, and any dump the
 * operator encrypts by hand (scripts/backup-key.js).
 *
 * WHY. A dump of the HR database is the easiest way to take everything at
 * once: one file, every person, every assessment. A folder ACL alone does not
 * protect a copy that leaves the folder (an off-host share, a USB stick, a
 * support ticket).
 *
 * FILE FORMAT (".enc", version 1). A chunked STREAM construction over
 * AES-256-GCM, so a multi-gigabyte dump is encrypted and decrypted in constant
 * memory:
 *
 *   magic      8 bytes   "IDVBKENC"
 *   version    1 byte    0x01
 *   hdrLen     4 bytes   big-endian length of the JSON header
 *   header     hdrLen    UTF-8 JSON { alg, keyId, chunkSize, noncePrefix,
 *                          wrapIv, wrapTag, wrappedKey, kind, createdAt }
 *   chunks     repeated  [ctLen u32 BE][ciphertext ctLen][GCM tag 16]
 *
 *   - Each file gets a fresh random 256-bit DATA key, wrapped (AES-256-GCM) by
 *     the MASTER key named by `keyId`; the wrap's AAD binds it to that key id.
 *   - Chunk i uses nonce = noncePrefix(7) || i (u32 BE) || lastFlag (1 byte)
 *     and AAD = SHA-256(magic || version || hdrLen || header). Every chunk
 *     therefore authenticates the header, chunks cannot be reordered (the
 *     counter), and the stream cannot be truncated or extended (only the final
 *     chunk carries lastFlag = 1; bytes after it, or EOF before it, are refused).
 *   - A chunk's plaintext is released only AFTER its tag verified.
 *
 * MANIFEST ("<file>.manifest.json"): SHA-256 and size of the file as written,
 * createdAt, keyId, app version and kind, HMAC-SHA256'd with a key derived from
 * the master key. Checked BEFORE ANY RESTORE (assertRestorable).
 *
 * MASTER KEY
 *   Windows: 32 random bytes created by `scripts/backup-key.js init` (or at
 *     first use), kept in a keyring file under %ProgramData%\IDevelop\keys and
 *     PROTECTED WITH DPAPI (LocalMachine scope) through powershell.exe: no
 *     native dependency. The key travels over the child's stdin/stdout, never
 *     on a command line. The keyring's ACL is SYSTEM + Administrators + OWNER,
 *     plus Read for the service account.
 *   Elsewhere (Linux, Docker), or with BACKUP_KEY_MODE=derived: HKDF-SHA256 of
 *     APP_KEY (SESSION_SECRET outside production only), with a warning: the
 *     backups are then exactly as safe as the .env file.
 *
 * KEY RING. Every key that ever encrypted a backup must stay findable, or the
 * backup is lost. The keyring holds:
 *   - DPAPI entries (Windows): the current key and any imported recovery copy;
 *   - APP_KEY-WRAPPED entries (derived mode): keys RETIRED by an APP_KEY
 *     rotation (scripts/rotate-app-key.js adds the old derived key and re-wraps
 *     every entry under the new APP_KEY), and recovery copies imported here.
 *   A DPAPI key does not leave its machine: export its recovery copy ONCE
 *   (`backup-key.js export`) and keep it offline. A derived key is recovered
 *   from the APP_KEY that produced it (`backup-key.js import-app-key`).
 *
 * FROZEN CONSTANTS. MAGIC, DPAPI_ENTROPY, DERIVED_SALT and the labels below are
 * part of the file and keyring formats. Changing any of them makes every
 * existing backup unreadable. Add a new VERSION instead.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { Transform, pipeline } = require('stream');

const MAGIC = Buffer.from('IDVBKENC', 'ascii');
const VERSION = 1;
const PREFIX_LEN = MAGIC.length + 1 + 4; // magic + version + hdrLen
const TAG_LEN = 16;
const NONCE_PREFIX_LEN = 7;
const DEFAULT_CHUNK = 1024 * 1024; // 1 MiB of plaintext per chunk
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_HEADER = 64 * 1024;
const ALG = 'AES-256-GCM-STREAM-v1';
const ENC_EXT = '.enc';
const MANIFEST_EXT = '.manifest.json';
const DPAPI_ENTROPY = 'IDevelop.backup-key.v1';
const DERIVED_SALT = 'idevelop.backup.v1';
const KEYID_LABEL = 'idevelop-backup-keyid|';
const WRAP_LABEL = 'idevelop-backup-wrap-v1|';
const RING_WRAP_LABEL = 'idevelop-backup-ring-v1|';
const MANIFEST_FORMAT = 'idevelop-backup-manifest-v1';
const KEYRING_FORMAT = 'idevelop-backup-keyring-v1';
const RECOVERY_PREFIX = 'IDVBK1';
const KEY_ID_RE = /^[0-9a-f]{16}$/;

const PROT_DPAPI = 'dpapi-localmachine';
const PROT_DERIVED = 'app-key-derived';
const PROT_WRAPPED = 'app-key-wrapped';

// ---------------------------------------------------------------------------
// Key identity
// ---------------------------------------------------------------------------

/** Public, non-secret fingerprint of a master key (16 hex). */
function keyIdOf(key) {
    return crypto.createHash('sha256').update(KEYID_LABEL).update(key).digest('hex').slice(0, 16);
}

function isProduction(env = process.env) {
    return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * The key-derivation input: APP_KEY, or SESSION_SECRET outside production only
 * (the same policy as secretBox v2). null when neither.
 */
function _derivationInput(env = process.env) {
    if (env.APP_KEY) return String(env.APP_KEY);
    if (isProduction(env)) return null;
    return env.SESSION_SECRET ? String(env.SESSION_SECRET) : null;
}

/** HKDF master key from APP_KEY (see _derivationInput). null when no input. */
function derivedMasterKey(env = process.env) {
    const ikm = _derivationInput(env);
    if (!ikm) return null;
    return Buffer.from(crypto.hkdfSync('sha256', ikm, DERIVED_SALT, 'backup-master', 32));
}

// ---------------------------------------------------------------------------
// DPAPI through powershell.exe (LocalMachine scope). Input on stdin, output on
// stdout, base64 both ways; the script itself is an -EncodedCommand.
// ---------------------------------------------------------------------------
function _psScript(op) {
    return [
        "$ErrorActionPreference='Stop'",
        'Add-Type -AssemblyName System.Security',
        '$in=[Console]::In.ReadToEnd().Trim()',
        `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
        '$b=[Convert]::FromBase64String($in)',
        `$o=[Security.Cryptography.ProtectedData]::${op}($b,$e,[Security.Cryptography.DataProtectionScope]::LocalMachine)`,
        '[Console]::Out.Write([Convert]::ToBase64String($o))',
    ].join('; ');
}

function _dpapi(op, inputB64) {
    const encoded = Buffer.from(_psScript(op), 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = cp.execFile(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-EncodedCommand',
                    encoded,
                ],
                { windowsHide: true, timeout: 60 * 1000, maxBuffer: 1024 * 1024 },
                (err, stdout, stderr) => {
                    if (err) {
                        const why = (stderr && String(stderr).trim()) || err.message;
                        return reject(
                            new Error(`DPAPI ${op} failed: ${String(why).slice(0, 300)}`)
                        );
                    }
                    const out = String(stdout || '').trim();
                    if (!out || !/^[A-Za-z0-9+/=]+$/.test(out))
                        return reject(new Error(`DPAPI ${op} returned no data`));
                    resolve(out);
                }
            );
        } catch (e) {
            return reject(new Error(`DPAPI ${op} failed: ${e.message}`));
        }
        if (child && child.stdin) {
            child.stdin.on('error', () => {});
            child.stdin.end(inputB64 + '\n');
        }
    });
}

async function dpapiProtect(buf) {
    return Buffer.from(await _dpapi('Protect', Buffer.from(buf).toString('base64')), 'base64');
}

async function dpapiUnprotect(buf) {
    return Buffer.from(await _dpapi('Unprotect', Buffer.from(buf).toString('base64')), 'base64');
}

// ---------------------------------------------------------------------------
// Keyring file
// ---------------------------------------------------------------------------

/**
 * Where the keyring lives: BACKUP_KEYRING_FILE, else %ProgramData%\IDevelop\keys
 * (Windows), else <app>/data/keys (Linux and Docker: /app/data is the
 * persistent volume). A test run never touches a real keyring: null unless the
 * test names its own file.
 */
function keyringPath(env = process.env) {
    if (env.BACKUP_KEYRING_FILE) return env.BACKUP_KEYRING_FILE;
    if (String(env.NODE_ENV || '').toLowerCase() === 'test' || env.JEST_WORKER_ID) return null;
    if (env.ProgramData)
        return path.join(env.ProgramData, 'IDevelop', 'keys', 'backup-keyring.json');
    return path.join(path.resolve(__dirname, '..', '..'), 'data', 'keys', 'backup-keyring.json');
}

/** Which store makes NEW keys: 'dpapi' (Windows) or 'derived' (elsewhere, or forced). */
function keyMode(env = process.env, platform = process.platform) {
    if (String(env.BACKUP_KEY_MODE || '').toLowerCase() === 'derived') return 'derived';
    return platform === 'win32' ? 'dpapi' : 'derived';
}

function _emptyRing() {
    return { format: KEYRING_FORMAT, current: null, keys: [] };
}

/** Only well-formed entries survive a read; anything else is dropped. */
function _cleanEntry(e) {
    if (!e || typeof e !== 'object' || !KEY_ID_RE.test(String(e.id || ''))) return null;
    if (e.protection === PROT_DPAPI && typeof e.blob === 'string') return e;
    if (e.protection === PROT_WRAPPED && Array.isArray(e.wraps)) {
        e.wraps = e.wraps.filter(
            (w) =>
                w &&
                KEY_ID_RE.test(String(w.by || '')) &&
                typeof w.iv === 'string' &&
                typeof w.tag === 'string' &&
                typeof w.ct === 'string'
        );
        return e;
    }
    return null;
}

/** The parsed keyring, or null when absent / unreadable / not ours. */
function readKeyring(file) {
    if (!file) return null;
    let j;
    try {
        j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
    if (!j || j.format !== KEYRING_FORMAT || !Array.isArray(j.keys)) return null;
    const keys = j.keys.map(_cleanEntry).filter(Boolean);
    const current = KEY_ID_RE.test(String(j.current || '')) ? j.current : null;
    return { format: KEYRING_FORMAT, current, keys };
}

function _entry(ring, id) {
    return (ring && ring.keys.find((e) => e.id === id)) || null;
}

function restrictAcl(file) {
    // Same SIDs as db-backup.restrictFileAcl: SYSTEM, Administrators, OWNER RIGHTS.
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(file, 0o600);
            } catch (_) {
                /* best-effort */
            }
            return resolve(true);
        }
        try {
            cp.execFile(
                'icacls.exe',
                [
                    file,
                    '/inheritance:r',
                    '/grant:r',
                    '*S-1-5-18:F',
                    '*S-1-5-32-544:F',
                    '*S-1-3-4:F',
                ],
                { windowsHide: true, timeout: 60 * 1000 },
                (err) => resolve(!err)
            );
        } catch (_) {
            resolve(false);
        }
    });
}

// ---------------------------------------------------------------------------
// The keyring must stay readable by the Windows service account. Rewriting it
// (export stamps exportedAt, import adds a key, a rotation re-wraps) replaces
// the file, and restrictAcl resets its DACL to SYSTEM + Administrators + OWNER:
// a virtual service account (NT SERVICE\<name>, SIDs S-1-5-80-*) would lose Read
// and every later backup would fail closed. So the service principals' explicit
// ACEs are read BEFORE the rewrite and granted Read again after it, plus
// NT SERVICE\<SERVICE_NAME> (default IDevelop) when that account resolves
// (icacls refuses an unknown name: ignored). execFile only, never a shell.
// Only the keyring gets this, never a recovery file or a decrypted dump.
// ---------------------------------------------------------------------------
function _icacls(args) {
    return new Promise((resolve) => {
        try {
            cp.execFile(
                'icacls.exe',
                args,
                { windowsHide: true, timeout: 60 * 1000 },
                (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') })
            );
        } catch (_) {
            resolve({ ok: false, stdout: '' });
        }
    });
}

/** Service principals (NT SERVICE\x or S-1-5-80-… SIDs) holding an explicit ACE on `file`. */
async function _serviceAcesOf(file) {
    if (process.platform !== 'win32' || !file || !fs.existsSync(file)) return [];
    const r = await _icacls([file]);
    if (!r.ok) return [];
    const found = new Set();
    for (const m of r.stdout.matchAll(/NT SERVICE\\([^:\\\r\n]+):\(/gi))
        found.add(`NT SERVICE\\${m[1].trim()}`);
    for (const m of r.stdout.matchAll(/\*?(S-1-5-80(?:-\d+)+):\(/g)) found.add(m[1]);
    return [...found];
}

/** NT SERVICE\<SERVICE_NAME> (default IDevelop); null for a name icacls must not see. */
function _configuredServicePrincipal(env = process.env) {
    const n = String(env.SERVICE_NAME || 'IDevelop').trim();
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(n) ? `NT SERVICE\\${n}` : null;
}

/** restrictAcl + Read back to the service principals. Resolves restrictAcl's verdict. */
async function _secureKeyring(file, preserved = [], env = process.env) {
    const ok = await restrictAcl(file);
    if (process.platform !== 'win32') return ok;
    const principals = new Set(preserved);
    const configured = _configuredServicePrincipal(env);
    if (configured) principals.add(configured);
    const seen = new Set();
    for (const p of principals) {
        const low = p.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        const who = /^S-1-5-80-/.test(p) ? `*${p}` : p;
        // Unknown account (service not installed) → icacls error → ignored.
        await _icacls([file, '/grant', `${who}:(R)`]);
    }
    return ok;
}

/** Atomic write (temp file + rename), then ACL. Throws when the file cannot be written. */
async function writeKeyring(file, ring, env = process.env) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const keep = await _serviceAcesOf(file);
    const tmp = `${file}.tmp-${process.pid}`;
    const body = JSON.stringify(
        { format: KEYRING_FORMAT, current: ring.current || null, keys: ring.keys },
        null,
        2
    );
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    await _secureKeyring(file, keep, env);
}

// ---------------------------------------------------------------------------
// APP_KEY-wrapped ring entries (derived mode)
// ---------------------------------------------------------------------------
function _ringAad(id, by) {
    return Buffer.from(`${RING_WRAP_LABEL}${id}|${by}`, 'utf8');
}

function _wrapUnder(wrappingKey, key) {
    const id = keyIdOf(key);
    const by = keyIdOf(wrappingKey);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv, { authTagLength: TAG_LEN });
    c.setAAD(_ringAad(id, by));
    const ct = Buffer.concat([c.update(key), c.final()]);
    return {
        by,
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
    };
}

/** The key inside a wrapped entry, using `wrappingKey`; null when no wrap opens. */
function _unwrapWith(entry, wrappingKey) {
    if (!wrappingKey || entry.protection !== PROT_WRAPPED) return null;
    const by = keyIdOf(wrappingKey);
    const w = entry.wraps.find((x) => x.by === by);
    if (!w) return null;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(w.iv, 'base64'), {
            authTagLength: TAG_LEN,
        });
        d.setAAD(_ringAad(entry.id, by));
        d.setAuthTag(Buffer.from(w.tag, 'base64'));
        const key = Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]);
        return key.length === 32 && keyIdOf(key) === entry.id ? key : null;
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Key cache, current key, lookup
// ---------------------------------------------------------------------------
const _cache = { keys: new Map(), current: null, warned: false };

function _resetCache() {
    _cache.keys.clear();
    _cache.current = null;
    _cache.warned = false;
}

function _warnDerived(reason) {
    if (_cache.warned) return;
    _cache.warned = true;
    console.warn(
        `[backup-crypto] WARNING: backups are encrypted with a key DERIVED FROM APP_KEY (${reason}). ` +
            'Anyone holding the .env file can decrypt them, and rotating APP_KEY must go through ' +
            'scripts/rotate-app-key.js so older backups stay readable.'
    );
}

/**
 * Add a raw key to the keyring (creates the ring if needed) and return its id.
 * protection: 'dpapi' (Windows) or 'wrapped' (under the current APP_KEY-derived key).
 */
async function addKeyToRing(
    file,
    key,
    { makeCurrent = false, source = 'generated', protection = 'dpapi', env = process.env } = {}
) {
    const ring = readKeyring(file) || _emptyRing();
    const id = keyIdOf(key);
    const existing = _entry(ring, id);
    const now = new Date().toISOString();
    if (protection === 'wrapped') {
        const wrapping = derivedMasterKey(env);
        if (!wrapping)
            throw new Error('no APP_KEY to protect the key with (set APP_KEY, then retry)');
        const wrap = _wrapUnder(wrapping, key);
        if (existing && existing.protection === PROT_WRAPPED) {
            existing.wraps = existing.wraps.filter((w) => w.by !== wrap.by).concat([wrap]);
        } else if (!existing) {
            ring.keys.push({ id, protection: PROT_WRAPPED, wraps: [wrap], createdAt: now, source });
        }
    } else if (!existing) {
        const blob = await dpapiProtect(key);
        ring.keys.push({
            id,
            protection: PROT_DPAPI,
            blob: blob.toString('base64'),
            createdAt: now,
            source,
            exportedAt: null,
            exportCount: 0,
        });
    }
    if (protection !== 'wrapped' && (makeCurrent || !ring.current)) ring.current = id;
    await writeKeyring(file, ring, env);
    _cache.keys.set(id, Buffer.from(key));
    return id;
}

/**
 * The key NEW files are encrypted with: { key, keyId, protection, keyring }.
 * Windows: the DPAPI keyring's current key (created when absent). Elsewhere:
 * the APP_KEY-derived key, with a warning. Throws (fail closed) when no key can
 * be had: a backup is then NOT written at all, never written in clear.
 */
async function getCurrentKey(env = process.env, platform = process.platform) {
    if (_cache.current) return _cache.current;
    const mode = keyMode(env, platform);
    if (mode === 'dpapi') {
        const file = keyringPath(env);
        try {
            if (!file) throw new Error('no keyring location (ProgramData unset)');
            let ring = readKeyring(file);
            const cur = ring && ring.current ? _entry(ring, ring.current) : null;
            if (!cur || cur.protection !== PROT_DPAPI) {
                await addKeyToRing(file, crypto.randomBytes(32), {
                    makeCurrent: true,
                    source: 'generated-at-first-use',
                    env,
                });
                ring = readKeyring(file);
            }
            const id = ring.current;
            const key =
                _cache.keys.get(id) ||
                (await dpapiUnprotect(Buffer.from(_entry(ring, id).blob, 'base64')));
            if (key.length !== 32 || keyIdOf(key) !== id)
                throw new Error('keyring entry does not match its key id');
            _cache.keys.set(id, key);
            _cache.current = { key, keyId: id, protection: PROT_DPAPI, keyring: file };
            return _cache.current;
        } catch (e) {
            // Production on Windows: the DPAPI store is the contract. Fail closed.
            if (isProduction(env)) throw new Error(`Backup key unavailable (DPAPI): ${e.message}`);
            _warnDerived(`DPAPI keyring unavailable in development: ${e.message}`);
        }
    } else {
        _warnDerived(platform === 'win32' ? 'BACKUP_KEY_MODE=derived' : `platform ${platform}`);
    }
    const key = derivedMasterKey(env);
    if (!key)
        throw new Error(
            'Backup key unavailable: no DPAPI keyring and no APP_KEY to derive one from.'
        );
    const keyId = keyIdOf(key);
    _cache.keys.set(keyId, key);
    _cache.current = { key, keyId, protection: PROT_DERIVED, keyring: keyringPath(env) };
    return _cache.current;
}

/**
 * The master key for `keyId`: the derived key, or any keyring entry (DPAPI, or
 * APP_KEY-wrapped under the CURRENT APP_KEY). null when unknown here.
 */
async function findKey(keyId, env = process.env) {
    if (!KEY_ID_RE.test(String(keyId || ''))) return null;
    if (_cache.keys.has(keyId)) return _cache.keys.get(keyId);
    const derived = derivedMasterKey(env);
    if (derived && keyIdOf(derived) === keyId) {
        _cache.keys.set(keyId, derived);
        return derived;
    }
    const ring = readKeyring(keyringPath(env));
    const entry = _entry(ring, keyId);
    if (!entry) return null;
    let key = null;
    if (entry.protection === PROT_DPAPI) {
        key = await dpapiUnprotect(Buffer.from(entry.blob, 'base64'));
        if (key.length !== 32 || keyIdOf(key) !== keyId) key = null;
    } else {
        key = _unwrapWith(entry, derived);
    }
    if (key) _cache.keys.set(keyId, key);
    return key;
}

/** Ids this machine can name without unwrapping anything (status pages). */
function knownKeyIds(env = process.env, platform = process.platform) {
    const ids = new Set();
    const derived = derivedMasterKey(env);
    if (derived) ids.add(keyIdOf(derived));
    const ring = readKeyring(keyringPath(env));
    const derivedId = derived ? keyIdOf(derived) : null;
    for (const e of (ring && ring.keys) || []) {
        if (e.protection === PROT_DPAPI && platform === 'win32') ids.add(e.id);
        // A wrapped entry counts only when the CURRENT APP_KEY can open it.
        if (e.protection === PROT_WRAPPED && derivedId && e.wraps.some((w) => w.by === derivedId))
            ids.add(e.id);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// Stream encryption
// ---------------------------------------------------------------------------
function _nonce(prefix, index, last) {
    const n = Buffer.alloc(12);
    prefix.copy(n, 0);
    n.writeUInt32BE(index >>> 0, NONCE_PREFIX_LEN);
    n[11] = last ? 1 : 0;
    return n;
}

function _wrapAad(keyId) {
    return Buffer.from(WRAP_LABEL + keyId, 'utf8');
}

function _buildHeader(masterKey, keyId, meta = {}) {
    const dataKey = crypto.randomBytes(32);
    const noncePrefix = crypto.randomBytes(NONCE_PREFIX_LEN);
    const wrapIv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', masterKey, wrapIv, { authTagLength: TAG_LEN });
    c.setAAD(_wrapAad(keyId));
    const wrapped = Buffer.concat([c.update(dataKey), c.final()]);
    const header = {
        alg: ALG,
        keyId,
        chunkSize: meta.chunkSize || DEFAULT_CHUNK,
        noncePrefix: noncePrefix.toString('base64'),
        wrapIv: wrapIv.toString('base64'),
        wrapTag: c.getAuthTag().toString('base64'),
        wrappedKey: wrapped.toString('base64'),
        kind: meta.kind || 'backup',
        createdAt: new Date().toISOString(),
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const lenB = Buffer.alloc(4);
    lenB.writeUInt32BE(json.length);
    const prefix = Buffer.concat([MAGIC, Buffer.from([VERSION]), lenB, json]);
    const aad = crypto.createHash('sha256').update(prefix).digest();
    return { prefix, header, dataKey, noncePrefix, aad };
}

/**
 * Transform: plaintext in → encrypted file bytes out.
 * @param {{key:Buffer,keyId:string}} master
 */
function createEncryptStream(master, meta = {}) {
    const h = _buildHeader(master.key, master.keyId, meta);
    const chunkSize = h.header.chunkSize;
    let pieces = [];
    let held = 0;
    let index = 0;
    let headerOut = false;
    const sealChunk = (pt, last) => {
        if (index > 0xffffffff) throw new Error('backup too large for this format');
        const c = crypto.createCipheriv(
            'aes-256-gcm',
            h.dataKey,
            _nonce(h.noncePrefix, index, last),
            { authTagLength: TAG_LEN }
        );
        c.setAAD(h.aad);
        const ct = Buffer.concat([c.update(pt), c.final()]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(ct.length);
        index++;
        return Buffer.concat([len, ct, c.getAuthTag()]);
    };
    const t = new Transform({
        transform(chunk, _enc, cb) {
            try {
                if (!headerOut) {
                    this.push(h.prefix);
                    headerOut = true;
                }
                pieces.push(chunk);
                held += chunk.length;
                // Keep at least one byte back: the LAST chunk is sealed with lastFlag=1.
                if (held > chunkSize) {
                    let buf = Buffer.concat(pieces, held);
                    while (buf.length > chunkSize) {
                        this.push(sealChunk(buf.subarray(0, chunkSize), false));
                        buf = buf.subarray(chunkSize);
                    }
                    pieces = [buf];
                    held = buf.length;
                }
                cb();
            } catch (e) {
                cb(e);
            }
        },
        flush(cb) {
            try {
                if (!headerOut) this.push(h.prefix);
                this.push(sealChunk(Buffer.concat(pieces, held), true));
                cb();
            } catch (e) {
                cb(e);
            }
        },
    });
    t.keyId = master.keyId;
    return t;
}

function integrityError(msg) {
    const e = new Error(msg);
    e.code = 'BACKUP_INTEGRITY';
    return e;
}

/** The loud, actionable message for a backup whose key this machine does not hold. */
function unknownKeyMessage(keyId) {
    return (
        `backup was encrypted with key ${keyId}, which this server does not hold. ` +
        'If it came from another Windows server, import that server’s recovery copy ' +
        '(node scripts/backup-key.js import --in <file>). If APP_KEY was changed by hand ' +
        '(not through scripts/rotate-app-key.js), add the previous APP_KEY ' +
        '(node scripts/backup-key.js import-app-key --in -). See docs/BACKUPS.md.'
    );
}

/**
 * Transform: encrypted file bytes in → plaintext out. Each chunk is released only
 * after its GCM tag verified. `resolveKey(keyId)` → Buffer|null (default findKey).
 */
function createDecryptStream({ resolveKey = (id) => findKey(id) } = {}) {
    let buf = Buffer.alloc(0);
    let state = null; // after the header: { dataKey, noncePrefix, aad, chunkSize, header }
    let index = 0;
    let done = false;
    let pending = null;

    const parseHeader = async () => {
        if (buf.length < PREFIX_LEN) return false;
        if (!buf.subarray(0, MAGIC.length).equals(MAGIC))
            throw integrityError('not an encrypted backup (bad magic)');
        const ver = buf[MAGIC.length];
        if (ver !== VERSION) throw integrityError(`unsupported encrypted backup version ${ver}`);
        const hLen = buf.readUInt32BE(MAGIC.length + 1);
        if (hLen <= 0 || hLen > MAX_HEADER) throw integrityError('corrupt encrypted backup header');
        if (buf.length < PREFIX_LEN + hLen) return false;
        const prefix = buf.subarray(0, PREFIX_LEN + hLen);
        let header;
        try {
            header = JSON.parse(prefix.subarray(PREFIX_LEN).toString('utf8'));
        } catch (_) {
            throw integrityError('corrupt encrypted backup header');
        }
        if (!header || header.alg !== ALG || !KEY_ID_RE.test(String(header.keyId || '')))
            throw integrityError('corrupt encrypted backup header');
        const master = await resolveKey(header.keyId);
        if (!master) {
            const e = new Error(unknownKeyMessage(header.keyId));
            e.code = 'BACKUP_KEY_UNKNOWN';
            throw e;
        }
        let dataKey;
        try {
            const d = crypto.createDecipheriv(
                'aes-256-gcm',
                master,
                Buffer.from(header.wrapIv, 'base64'),
                { authTagLength: TAG_LEN }
            );
            d.setAAD(_wrapAad(header.keyId));
            d.setAuthTag(Buffer.from(header.wrapTag, 'base64'));
            dataKey = Buffer.concat([
                d.update(Buffer.from(header.wrappedKey, 'base64')),
                d.final(),
            ]);
        } catch (_) {
            const e = new Error(
                `wrong key for this backup (key ${header.keyId} could not unwrap its data key)`
            );
            e.code = 'BACKUP_WRONG_KEY';
            throw e;
        }
        const chunkSize = Number(header.chunkSize);
        if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK)
            throw integrityError('corrupt encrypted backup header');
        state = {
            dataKey,
            noncePrefix: Buffer.from(header.noncePrefix, 'base64'),
            aad: crypto.createHash('sha256').update(prefix).digest(),
            chunkSize,
            header,
        };
        buf = buf.subarray(PREFIX_LEN + hLen);
        return true;
    };

    const openChunks = (push) => {
        for (;;) {
            if (done) {
                if (buf.length)
                    throw integrityError('data after the final chunk (file was extended)');
                return;
            }
            if (buf.length < 4) return;
            const ctLen = buf.readUInt32BE(0);
            if (ctLen > state.chunkSize) throw integrityError('corrupt chunk length');
            const need = 4 + ctLen + TAG_LEN;
            if (buf.length < need) return;
            const ct = buf.subarray(4, 4 + ctLen);
            const tag = buf.subarray(4 + ctLen, need);
            // Try "not last" first, then "last": at most one can verify.
            let pt = null;
            for (const last of [false, true]) {
                try {
                    const d = crypto.createDecipheriv(
                        'aes-256-gcm',
                        state.dataKey,
                        _nonce(state.noncePrefix, index, last),
                        { authTagLength: TAG_LEN }
                    );
                    d.setAAD(state.aad);
                    d.setAuthTag(tag);
                    pt = Buffer.concat([d.update(ct), d.final()]);
                    if (last) done = true;
                    break;
                } catch (_) {
                    /* try the other flag */
                }
            }
            if (!pt)
                throw integrityError(
                    `authentication failed on chunk ${index} (file altered or corrupt)`
                );
            index++;
            buf = buf.subarray(need);
            if (pt.length) push(pt);
        }
    };

    // Incoming pieces are concatenated only once enough bytes are held for the
    // next unit (header or whole chunk): no quadratic re-copying of 1 MiB buffers.
    let pieces = [];
    let held = 0;
    let need = PREFIX_LEN;
    const nextNeed = () => {
        if (!state)
            return buf.length >= PREFIX_LEN
                ? PREFIX_LEN + buf.readUInt32BE(MAGIC.length + 1)
                : PREFIX_LEN;
        if (done) return 1;
        return buf.length >= 4 ? 4 + buf.readUInt32BE(0) + TAG_LEN : 4;
    };

    const t = new Transform({
        transform(chunk, _enc, cb) {
            pieces.push(chunk);
            held += chunk.length;
            if (held < need) return cb();
            buf = Buffer.concat(pieces, held);
            pieces = [];
            const run = async () => {
                if (!state && !(await parseHeader())) return;
                openChunks((pt) => this.push(pt));
            };
            pending = run()
                .then(() => {
                    pieces = buf.length ? [buf] : [];
                    held = buf.length;
                    need = nextNeed();
                })
                .then(() => cb(), cb);
        },
        flush(cb) {
            Promise.resolve(pending)
                .then(async () => {
                    buf = Buffer.concat(pieces, held);
                    if (!state)
                        throw integrityError('truncated encrypted backup (header incomplete)');
                    if (!done)
                        throw integrityError('truncated encrypted backup (final chunk missing)');
                    if (buf.length)
                        throw integrityError('data after the final chunk (file was extended)');
                })
                .then(() => cb(), cb);
        },
    });
    t.headerInfo = () => (state ? { ...state.header } : null);
    return t;
}

// ---------------------------------------------------------------------------
// Files and manifest
// ---------------------------------------------------------------------------
function manifestPath(file) {
    return file + MANIFEST_EXT;
}

function _readHead(file, n) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const b = Buffer.alloc(n);
        const got = fs.readSync(fd, b, 0, n, 0);
        return b.subarray(0, got);
    } catch (_) {
        return Buffer.alloc(0);
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch (_) {
                /* ignore */
            }
        }
    }
}

/** true when the file starts with the encrypted-backup magic. */
function isEncryptedFile(file) {
    const b = _readHead(file, MAGIC.length);
    return b.length === MAGIC.length && b.equals(MAGIC);
}

/** The key id an encrypted file names in its header (no key needed); null otherwise. */
function keyIdOfFile(file) {
    const head = _readHead(file, PREFIX_LEN);
    if (head.length < PREFIX_LEN || !head.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const hLen = head.readUInt32BE(MAGIC.length + 1);
    if (hLen <= 0 || hLen > MAX_HEADER) return null;
    const all = _readHead(file, PREFIX_LEN + hLen);
    try {
        const h = JSON.parse(all.subarray(PREFIX_LEN).toString('utf8'));
        return KEY_ID_RE.test(String(h.keyId || '')) ? h.keyId : null;
    } catch (_) {
        return null;
    }
}

function _appVersion() {
    try {
        return require('../../package.json').version;
    } catch (_) {
        return null;
    }
}

function _manifestHmacKey(masterKey) {
    return Buffer.from(crypto.hkdfSync('sha256', masterKey, DERIVED_SALT, 'manifest-hmac', 32));
}

function _manifestBody(m) {
    // Canonical field order: the HMAC input.
    return JSON.stringify({
        format: m.format,
        file: m.file,
        sha256: m.sha256,
        sizeBytes: m.sizeBytes,
        createdAt: m.createdAt,
        keyId: m.keyId,
        appVersion: m.appVersion,
        kind: m.kind,
    });
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        let size = 0;
        fs.createReadStream(file)
            .on('data', (d) => {
                size += d.length;
                h.update(d);
            })
            .on('error', reject)
            .on('end', () => resolve({ sha256: h.digest('hex'), sizeBytes: size }));
    });
}

async function writeManifest(file, { keyId, masterKey, kind, sha256, sizeBytes }) {
    const m = {
        format: MANIFEST_FORMAT,
        file: path.basename(file),
        sha256,
        sizeBytes,
        createdAt: new Date().toISOString(),
        keyId,
        appVersion: _appVersion(),
        kind: kind || 'backup',
    };
    m.hmac = crypto
        .createHmac('sha256', _manifestHmacKey(masterKey))
        .update(_manifestBody(m))
        .digest('hex');
    // No secret in a manifest (hashes and a key id); it gets the dump's ACL.
    fs.writeFileSync(manifestPath(file), JSON.stringify(m, null, 2), { encoding: 'utf8' });
    return m;
}

/**
 * Encrypt a readable stream into `outFile` (+ manifest). Writes `<outFile>.partial`
 * first and renames on success, so a half-written backup never carries the
 * final name. Returns { file, sizeBytes, sha256, keyId, manifest }.
 */
async function encryptStreamToFile(readable, outFile, { kind = 'backup', master } = {}) {
    const mk = master || (await getCurrentKey());
    const partial = outFile + '.partial';
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
        transform(chunk, _e, cb) {
            hash.update(chunk);
            size += chunk.length;
            cb(null, chunk);
        },
    });
    try {
        await new Promise((resolve, reject) =>
            pipeline(
                readable,
                createEncryptStream(mk, { kind }),
                tap,
                fs.createWriteStream(partial, { mode: 0o600 }),
                (e) => (e ? reject(e) : resolve())
            )
        );
        fs.renameSync(partial, outFile);
    } catch (e) {
        try {
            fs.unlinkSync(partial);
        } catch (_) {
            /* ignore */
        }
        throw e;
    }
    const sha256 = hash.digest('hex');
    const manifest = await writeManifest(outFile, {
        keyId: mk.keyId,
        masterKey: mk.key,
        kind,
        sha256,
        sizeBytes: size,
    });
    return { file: outFile, sizeBytes: size, sha256, keyId: mk.keyId, manifest };
}

/** Encrypt an existing plaintext file (CLI). The plaintext is left for the caller to remove. */
function encryptFile(inFile, outFile, opts = {}) {
    return encryptStreamToFile(fs.createReadStream(inFile), outFile, opts);
}

/**
 * Check a backup against its manifest BEFORE it is used.
 * Returns { ok, encrypted, legacyPlaintext, reason, manifest, code }.
 *  - encrypted file: manifest REQUIRED; SHA-256, size, key and HMAC must match.
 *  - plaintext file with no manifest: ok, legacyPlaintext (the caller warns).
 *  - plaintext file WITH a manifest: its hash must still match.
 */
async function verifyManifest(file, { resolveKey = (id) => findKey(id) } = {}) {
    if (!fs.existsSync(file))
        return { ok: false, reason: `file not found: ${path.basename(file)}` };
    const encrypted = isEncryptedFile(file);
    let m = null;
    try {
        m = JSON.parse(fs.readFileSync(manifestPath(file), 'utf8'));
    } catch (_) {
        m = null;
    }
    if (!m || typeof m !== 'object') {
        if (encrypted)
            return {
                ok: false,
                encrypted,
                reason: `manifest missing or unreadable for ${path.basename(file)}, so its integrity cannot be proven`,
            };
        return {
            ok: true,
            encrypted: false,
            legacyPlaintext: true,
            reason: 'unencrypted legacy backup (no manifest)',
        };
    }
    const actual = await sha256File(file);
    if (actual.sizeBytes !== Number(m.sizeBytes))
        return {
            ok: false,
            encrypted,
            manifest: m,
            reason: `size mismatch (manifest ${m.sizeBytes}, file ${actual.sizeBytes} bytes)`,
        };
    if (actual.sha256 !== String(m.sha256))
        return {
            ok: false,
            encrypted,
            manifest: m,
            reason: 'SHA-256 mismatch: the file was altered or corrupted after it was written',
        };
    if (encrypted) {
        const keyId = String(m.keyId || '');
        const key = await resolveKey(keyId);
        if (!key)
            return {
                ok: false,
                encrypted,
                manifest: m,
                code: 'BACKUP_KEY_UNKNOWN',
                reason: unknownKeyMessage(keyId),
            };
        const expect = crypto
            .createHmac('sha256', _manifestHmacKey(key))
            .update(_manifestBody(m))
            .digest();
        const got = Buffer.from(String(m.hmac || ''), 'hex');
        if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect))
            return {
                ok: false,
                encrypted,
                manifest: m,
                reason: 'manifest signature invalid: the manifest was edited',
            };
    }
    return { ok: true, encrypted, legacyPlaintext: !encrypted, manifest: m };
}

/**
 * A readable of the backup's PLAINTEXT (decrypting when needed). Destroying the
 * returned stream also closes the file (no lingering handle on Windows).
 */
function openPlainStream(file, opts = {}) {
    const src = fs.createReadStream(file);
    if (!isEncryptedFile(file)) return src;
    const dec = createDecryptStream(opts);
    pipeline(src, dec, () => {});
    return dec;
}

/**
 * Spawn `bin args` and encrypt its STDOUT into `file` (+ manifest): the plaintext
 * never touches the disk. Resolves { ok, error, plainBytes, code, stderr }.
 */
async function spawnToEncryptedFile(
    bin,
    args,
    file,
    { env = process.env, kind = 'backup', timeoutMs = 10 * 60 * 1000, master } = {}
) {
    // The key BEFORE the child starts: stdout must be consumed by the encryption
    // pipeline from its first byte (a late consumer on a flowing stream loses data).
    let mk = master;
    if (!mk) {
        try {
            mk = await getCurrentKey();
        } catch (e) {
            return {
                ok: false,
                error: 'encryption key: ' + e.message,
                plainBytes: 0,
                code: null,
                stderr: '',
            };
        }
    }
    return new Promise((resolve) => {
        let child;
        try {
            child = cp.spawn(bin, args, { env, windowsHide: true });
        } catch (e) {
            return resolve({ ok: false, error: e.message, plainBytes: 0, code: null, stderr: '' });
        }
        let stderr = '';
        let plainBytes = 0;
        let exit = null;
        let spawnErr = null;
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch (_) {
                /* ignore */
            }
        }, timeoutMs);
        child.stderr.on('data', (d) => {
            if (stderr.length < 8000) stderr += String(d);
        });
        const counter = new Transform({
            transform(d, _e, cb) {
                plainBytes += d.length;
                cb(null, d);
            },
        });
        const exited = new Promise((r) => {
            child.on('error', (e) => {
                spawnErr = e;
                r();
            });
            child.on('close', (code) => {
                exit = code;
                r();
            });
        });
        child.stdout.on('error', (e) => counter.destroy(e));
        const written = encryptStreamToFile(child.stdout.pipe(counter), file, {
            kind,
            master: mk,
        }).then(
            () => null,
            (e) => e
        );
        Promise.all([exited, written]).then(([, encErr]) => {
            clearTimeout(timer);
            let error = null;
            if (spawnErr) error = spawnErr.message;
            else if (exit !== 0)
                error = `${path.basename(String(bin))} exit ${exit}: ${stderr.trim().slice(0, 300)}`;
            else if (encErr) error = 'encryption: ' + encErr.message;
            if (error) {
                for (const p of [file, file + '.partial', manifestPath(file)]) {
                    try {
                        if (fs.existsSync(p)) fs.unlinkSync(p);
                    } catch (_) {
                        /* ignore */
                    }
                }
            }
            resolve({ ok: !error, error, plainBytes, code: exit, stderr });
        });
    });
}

/** Full authenticated decryption pass, output discarded. Resolves { ok, reason }. */
async function verifyDecrypt(file, opts = {}) {
    if (!isEncryptedFile(file)) return { ok: true, encrypted: false };
    return new Promise((resolve) => {
        const src = fs.createReadStream(file);
        const dec = createDecryptStream(opts);
        let bytes = 0;
        dec.on('data', (d) => {
            bytes += d.length;
        });
        pipeline(src, dec, (e) =>
            resolve(
                e
                    ? { ok: false, encrypted: true, reason: e.message, code: e.code }
                    : { ok: true, encrypted: true, plainBytes: bytes }
            )
        );
    });
}

/**
 * The gate every restore goes through: manifest, then a full authenticated
 * decryption pass. Throws a clear error when the backup must not be used.
 * Returns { encrypted, warning }: warning set for a legacy plaintext file.
 */
async function assertRestorable(file, opts = {}) {
    const m = await verifyManifest(file, opts);
    if (!m.ok) {
        const e = new Error(`Refusing to restore "${path.basename(file)}": ${m.reason}`);
        e.code = m.code || 'BACKUP_INTEGRITY';
        throw e;
    }
    if (m.encrypted) {
        const d = await verifyDecrypt(file, opts);
        if (!d.ok) {
            const e = new Error(`Refusing to restore "${path.basename(file)}": ${d.reason}`);
            e.code = d.code || 'BACKUP_INTEGRITY';
            throw e;
        }
        return { encrypted: true, warning: null };
    }
    return {
        encrypted: false,
        warning: `"${path.basename(file)}" is an UNENCRYPTED legacy backup${m.manifest ? '' : ' with no integrity manifest'}; restored as-is.`,
    };
}

/**
 * Spawn `bin args` with the backup's plaintext on its stdin (no plaintext file
 * on disk). Resolves { code, stdout, stderr, streamError }.
 */
function spawnWithPlainStdin(bin, args, file, { env = {}, decryptOpts = {} } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = cp.spawn(bin, args, { env: { ...process.env, ...env }, windowsHide: true });
        } catch (e) {
            return resolve({ code: 1, stdout: '', stderr: String(e.message), streamError: null });
        }
        let stdout = '';
        let stderr = '';
        let streamError = null;
        const cap = (s, d) => (s.length < 32 * 1024 * 1024 ? s + d : s);
        child.stdout.on('data', (d) => (stdout = cap(stdout, String(d))));
        child.stderr.on('data', (d) => (stderr = cap(stderr, String(d))));
        child.stdin.on('error', () => {}); // EPIPE when the tool stops reading early (e.g. -l)
        let closed = false;
        const plain = openPlainStream(file, decryptOpts);
        plain.on('error', (e) => {
            if (closed) return; // our own destroy() after the tool exited
            streamError = e;
            try {
                child.stdin.destroy();
            } catch (_) {
                /* ignore */
            }
        });
        plain.pipe(child.stdin);
        child.on('error', (e) => {
            stderr += String(e.message);
        });
        child.on('close', (code) => {
            closed = true;
            try {
                plain.destroy();
            } catch (_) {
                /* ignore */
            }
            resolve({ code: code == null ? 1 : code, stdout, stderr, streamError });
        });
    });
}

// ---------------------------------------------------------------------------
// Recovery copy (export / import)
// ---------------------------------------------------------------------------
function _b64url(b) {
    return Buffer.from(b)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
function _unb64url(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** "IDVBK1-<keyId>-<key b64url>-<check8hex>": one line an operator can keep in a vault. */
function formatRecovery(key) {
    const id = keyIdOf(key);
    const body = `${RECOVERY_PREFIX}-${id}-${_b64url(key)}`;
    const check = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
    return `${body}-${check}`;
}

function parseRecovery(text) {
    const s = String(text || '').trim();
    if (s.length > 200) throw new Error('not an IDevelop backup recovery key');
    const m = /^IDVBK1-([0-9a-f]{16})-([A-Za-z0-9_-]{43})-([0-9a-f]{8})$/.exec(s);
    if (!m) throw new Error('not an IDevelop backup recovery key');
    const body = s.slice(0, s.lastIndexOf('-'));
    if (crypto.createHash('sha256').update(body).digest('hex').slice(0, 8) !== m[3])
        throw new Error('recovery key checksum mismatch (typo?)');
    const key = _unb64url(m[2]);
    if (key.length !== 32 || keyIdOf(key) !== m[1])
        throw new Error('recovery key does not match its key id');
    return key;
}

/**
 * The recovery copy of the CURRENT key. DPAPI: once (a second call throws
 * unless { force: true }), and the ring entry is stamped. Derived: the line is
 * given every time (the APP_KEY recovers it anyway), with a note.
 */
async function exportRecovery({
    force = false,
    env = process.env,
    platform = process.platform,
} = {}) {
    const cur = await getCurrentKey(env, platform);
    if (cur.protection !== PROT_DPAPI) {
        return {
            keyId: cur.keyId,
            recovery: formatRecovery(cur.key),
            exportedAt: null,
            note:
                'This key is derived from APP_KEY: a safe offline copy of APP_KEY recovers it too. ' +
                'Keep both offline, apart from the backups.',
        };
    }
    const ring = readKeyring(cur.keyring);
    const entry = _entry(ring, cur.keyId);
    if (entry.exportedAt && !force) {
        const e = new Error(
            `The recovery copy of key ${cur.keyId} was already exported on ${entry.exportedAt}. ` +
                'Use --force to export it again (the event is recorded).'
        );
        e.code = 'ALREADY_EXPORTED';
        throw e;
    }
    entry.exportedAt = new Date().toISOString();
    entry.exportCount = (Number(entry.exportCount) || 0) + 1;
    await writeKeyring(cur.keyring, ring, env);
    return { keyId: cur.keyId, recovery: formatRecovery(cur.key), exportedAt: entry.exportedAt };
}

/** Add a recovery copy to this machine's keyring (DPAPI on Windows, APP_KEY-wrapped elsewhere). */
async function importRecovery(
    text,
    { makeCurrent = false, env = process.env, platform = process.platform } = {}
) {
    const key = parseRecovery(text);
    return _importKey(key, { makeCurrent, env, platform, source: 'imported' });
}

/**
 * Add the backup key derived from a PREVIOUS APP_KEY: the recovery path when
 * APP_KEY was changed without scripts/rotate-app-key.js, or the keyring was lost.
 */
async function importPreviousAppKey(
    previousAppKey,
    { env = process.env, platform = process.platform } = {}
) {
    const old = String(previousAppKey || '').trim();
    if (!old) throw new Error('no previous APP_KEY given');
    const key = derivedMasterKey({ APP_KEY: old, NODE_ENV: env.NODE_ENV });
    const cur = derivedMasterKey(env);
    if (cur && keyIdOf(cur) === keyIdOf(key))
        return { keyId: keyIdOf(key), current: false, alreadyCurrent: true };
    return _importKey(key, { makeCurrent: false, env, platform, source: 'previous-app-key' });
}

async function _importKey(key, { makeCurrent, env, platform, source }) {
    const file = keyringPath(env);
    if (!file) throw new Error('no keyring location (set BACKUP_KEYRING_FILE)');
    const dpapi = keyMode(env, platform) === 'dpapi';
    const id = await addKeyToRing(file, key, {
        makeCurrent: dpapi && makeCurrent,
        source,
        protection: dpapi ? 'dpapi' : 'wrapped',
        env,
    });
    _cache.current = null;
    return { keyId: id, current: dpapi && !!makeCurrent };
}

// ---------------------------------------------------------------------------
// APP_KEY rotation (scripts/rotate-app-key.js)
//
// In derived mode the current backup key IS a function of APP_KEY: a new
// APP_KEY means a new backup key, and every backup made before it would be
// unreadable. So the rotation:
//   1. prepare  — computes the new ring in memory: the old derived key becomes a
//                 RETIRED entry, and every APP_KEY-wrapped entry gains a wrap
//                 under the NEW key (its wrap under the old key is kept for now);
//                 every new wrap is verified. Nothing is written. Throws when the
//                 ring cannot be prepared: the rotation then stops before the
//                 database is touched.
//   2. commit   — writes that ring BEFORE the database transaction. Both APP_KEYs
//                 open it, so a crash anywhere after this point loses nothing.
//   3. finalize — after the database committed: drops the wraps under the old key.
//      abort    — the database transaction failed: puts the previous file back.
// ---------------------------------------------------------------------------
async function prepareAppKeyRotation({
    oldAppKey,
    newAppKey,
    sessionSecret = '',
    env = process.env,
    platform = process.platform,
} = {}) {
    const nodeEnv = env.NODE_ENV;
    const oldKey = derivedMasterKey({
        APP_KEY: oldAppKey || '',
        SESSION_SECRET: sessionSecret || '',
        NODE_ENV: nodeEnv,
    });
    const newKey = derivedMasterKey({ APP_KEY: newAppKey || '', NODE_ENV: nodeEnv });
    if (!newKey) throw new Error('no new APP_KEY');
    const file = keyringPath(env);
    const plan = {
        file,
        before: null,
        ring: null,
        newKeyId: keyIdOf(newKey),
        retired: 0,
        carried: 0,
        unreadable: 0,
        skipped: null,
        _newKey: newKey,
    };
    if (!oldKey) {
        plan.skipped = 'no previous APP_KEY: no backup key to retire';
        return plan;
    }
    if (!file) {
        plan.skipped = 'no keyring location in this environment';
        return plan;
    }
    if (fs.existsSync(file)) {
        plan.before = fs.readFileSync(file, 'utf8');
        if (!readKeyring(file))
            throw new Error(
                `the backup keyring ${file} is unreadable; fix or move it before rotating APP_KEY`
            );
    }
    const ring = readKeyring(file) || _emptyRing();
    const oldId = keyIdOf(oldKey);
    const now = new Date().toISOString();
    for (const e of ring.keys) {
        if (e.protection !== PROT_WRAPPED) continue;
        const k = _unwrapWith(e, oldKey) || _unwrapWith(e, newKey);
        if (!k) {
            plan.unreadable++;
            continue;
        }
        if (!e.wraps.some((w) => w.by === plan.newKeyId)) e.wraps.push(_wrapUnder(newKey, k));
        plan.carried++;
    }
    if (oldId !== plan.newKeyId && !_entry(ring, oldId)) {
        if (keyMode(env, platform) === 'dpapi') {
            const blob = await dpapiProtect(oldKey);
            ring.keys.push({
                id: oldId,
                protection: PROT_DPAPI,
                blob: blob.toString('base64'),
                createdAt: now,
                source: 'retired-app-key',
                exportedAt: null,
                exportCount: 0,
            });
        } else {
            ring.keys.push({
                id: oldId,
                protection: PROT_WRAPPED,
                wraps: [_wrapUnder(newKey, oldKey)],
                createdAt: now,
                retiredAt: now,
                source: 'retired-app-key',
            });
        }
        plan.retired = 1;
    }
    // Verify: every wrapped entry that was readable opens under the NEW key.
    for (const e of ring.keys) {
        if (e.protection !== PROT_WRAPPED) continue;
        if (!e.wraps.some((w) => w.by === plan.newKeyId)) continue;
        if (!_unwrapWith(e, newKey))
            throw new Error('backup keyring verification failed under the new APP_KEY');
    }
    plan.ring = ring;
    return plan;
}

/** Step 2: write the prepared ring (both APP_KEYs open it). Throws when it cannot. */
async function commitAppKeyRotation(plan, env = process.env) {
    if (!plan || !plan.ring) return false;
    await writeKeyring(plan.file, plan.ring, env);
    const back = readKeyring(plan.file);
    if (!back || back.keys.length !== plan.ring.keys.length)
        throw new Error('backup keyring did not read back after writing');
    _resetCache();
    return true;
}

/** Step 3: keep only the wraps under the new APP_KEY. */
async function finalizeAppKeyRotation(plan, env = process.env) {
    if (!plan || !plan.ring) return false;
    const ring = readKeyring(plan.file);
    if (!ring) throw new Error('backup keyring vanished after the rotation');
    for (const e of ring.keys) {
        if (e.protection !== PROT_WRAPPED) continue;
        // An entry no key opens is left untouched (it may still be recovered).
        if (e.wraps.some((w) => w.by === plan.newKeyId))
            e.wraps = e.wraps.filter((w) => w.by === plan.newKeyId);
    }
    await writeKeyring(plan.file, ring, env);
    _resetCache();
    return true;
}

/** The database rotation failed: put the keyring back as it was. */
async function abortAppKeyRotation(plan, env = process.env) {
    if (!plan || !plan.ring || !plan.file) return false;
    if (plan.before == null) {
        try {
            fs.unlinkSync(plan.file);
        } catch (_) {
            /* already gone */
        }
    } else {
        const tmp = `${plan.file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, plan.before, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, plan.file);
        await _secureKeyring(plan.file, [], env);
    }
    _resetCache();
    return true;
}

// ---------------------------------------------------------------------------
// Status (health page). READ-ONLY: never creates a key, never calls DPAPI,
// never throws.
// ---------------------------------------------------------------------------
function keyStatus(env = process.env, platform = process.platform) {
    const base = { ok: false, keyId: null, protection: null, exportedAt: null, retiredKeys: 0 };
    try {
        const file = keyringPath(env);
        const ring = readKeyring(file);
        base.keyring = file;
        // Older keys this server still holds for older backups (never the current one).
        const derived = derivedMasterKey(env);
        const derivedId = derived ? keyIdOf(derived) : null;
        base.retiredKeys = ring
            ? ring.keys.filter((e) => e.id !== ring.current && e.id !== derivedId).length
            : 0;
        if (keyMode(env, platform) === 'dpapi') {
            const cur = ring && ring.current ? _entry(ring, ring.current) : null;
            if (cur && cur.protection === PROT_DPAPI)
                return {
                    ...base,
                    ok: true,
                    keyId: cur.id,
                    protection: PROT_DPAPI,
                    exportedAt: cur.exportedAt || null,
                };
            // No key yet: the next backup (or `backup-key.js init`) creates it.
            if (file) return { ...base, ok: true, pending: true };
            if (isProduction(env)) return { ...base, error: 'no keyring location' };
        }
        const k = derivedMasterKey(env);
        if (!k) return { ...base, error: 'no APP_KEY' };
        return { ...base, ok: true, keyId: keyIdOf(k), protection: PROT_DERIVED };
    } catch (e) {
        return { ...base, error: String(e.message).slice(0, 300) };
    }
}

module.exports = {
    ENC_EXT,
    MANIFEST_EXT,
    MAGIC,
    ALG,
    DPAPI_ENTROPY,
    DERIVED_SALT,
    KEYID_LABEL,
    PROT_DPAPI,
    PROT_DERIVED,
    PROT_WRAPPED,
    keyIdOf,
    keyMode,
    keyringPath,
    readKeyring,
    derivedMasterKey,
    dpapiProtect,
    dpapiUnprotect,
    getCurrentKey,
    findKey,
    knownKeyIds,
    addKeyToRing,
    createEncryptStream,
    createDecryptStream,
    encryptStreamToFile,
    encryptFile,
    isEncryptedFile,
    keyIdOfFile,
    manifestPath,
    writeManifest,
    sha256File,
    verifyManifest,
    verifyDecrypt,
    assertRestorable,
    openPlainStream,
    spawnWithPlainStdin,
    spawnToEncryptedFile,
    formatRecovery,
    parseRecovery,
    exportRecovery,
    importRecovery,
    importPreviousAppKey,
    prepareAppKeyRotation,
    commitAppKeyRotation,
    finalizeAppKeyRotation,
    abortAppKeyRotation,
    keyStatus,
    unknownKeyMessage,
    restrictAcl,
    _resetCache,
};
