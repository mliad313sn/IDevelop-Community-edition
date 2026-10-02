'use strict';

/**
 * secretBox — symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * FORMATS
 *   enc:v2:<purpose>:<iv>:<tag>:<ct>   (written by encrypt())
 *       key = HKDF-SHA256(ikm = APP_KEY, salt = V2_SALT, info = 'secretbox:' + purpose)
 *       AAD = 'enc:v2:<purpose>': the purpose label is authenticated, so a
 *       ciphertext cannot be relabelled to be opened under another purpose.
 *   enc:v1:<iv>:<tag>:<ct>              (legacy, read-only)
 *       key = SHA-256(APP_KEY || SESSION_SECRET). Still DECRYPTED, so every
 *       value written before v2 (LMS, webhook, safety-gate, SSO, HRIS
 *       connector secrets) keeps working, and re-encrypted to v2 by its owner
 *       on the next write (AppSettingsModel does it lazily on read; the
 *       rotate-app-key script does it for every store). Both candidate keys
 *       are tried, so a v1 value written while APP_KEY was unset
 *       (SESSION_SECRET fallback) still opens after APP_KEY was added.
 *
 * KEY POLICY
 *   production (NODE_ENV=production): v2 derives from APP_KEY ONLY. Rotating
 *   SESSION_SECRET (a routine act: it only signs cookies) must never make
 *   stored secrets unreadable, so it is never a v2 key there. A missing or
 *   weak APP_KEY in production makes assertConfigured() (called at boot)
 *   throw, and encrypt() throws, instead of silently storing clear text.
 *   development: APP_KEY, else SESSION_SECRET, else no key: encrypt() returns
 *   the plaintext and decrypt() passes non-prefixed values through, so a bare
 *   development checkout still boots.
 *
 * V2_SALT is a cryptographic constant: it is frozen. Changing it makes every
 * v2 value unreadable.
 */
const crypto = require('crypto');

const V1 = 'enc:v1:';
const V2 = 'enc:v2:';
const V2_SALT = 'idevelop.secretbox.v2';
const PURPOSE_RE = /^[a-z0-9_.-]{1,40}$/;
const DEFAULT_PURPOSE = 'generic';

function isProduction(env = process.env) {
    return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

/** The input keying material for v2, or null. Production: APP_KEY only. */
function v2Ikm(env = process.env) {
    if (env.APP_KEY) return String(env.APP_KEY);
    if (isProduction(env)) return null;
    return env.SESSION_SECRET ? String(env.SESSION_SECRET) : null;
}

function v2Key(ikm, purpose) {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, V2_SALT, 'secretbox:' + purpose, 32));
}

/** Legacy v1 keys to try, in order (APP_KEY first, SESSION_SECRET fallback). */
function v1Keys(env = process.env) {
    const out = [];
    for (const s of [env.APP_KEY, env.SESSION_SECRET]) {
        if (!s) continue;
        const k = crypto.createHash('sha256').update(String(s)).digest();
        if (!out.some((x) => x.equals(k))) out.push(k);
    }
    return out;
}

function missingKeyError() {
    const e = new Error(
        'secretBox: APP_KEY is required in production to encrypt secrets at rest (SESSION_SECRET is never used as an encryption key in production). Set APP_KEY in .env (e.g. `openssl rand -hex 32`) and restart.'
    );
    e.code = 'SECRETBOX_NO_APP_KEY';
    return e;
}

/**
 * A weak APP_KEY: shorter than 32 characters, or a placeholder left from an
 * example file. Random keys (hex or base64 of 32 bytes) never match.
 */
function isWeakAppKey(value) {
    const v = String(value || '').trim();
    if (!v) return true;
    return v.length < 32 || /change|default|example|sample|placeholder|please/i.test(v);
}

function weakKeyError() {
    const e = new Error(
        'secretBox: APP_KEY is too weak for production (fewer than 32 characters, or a placeholder). Generate a random key (e.g. `openssl rand -hex 32`) and rotate to it with `NEW_APP_KEY=<key> node scripts/rotate-app-key.js --commit`, then set it in .env. Never change APP_KEY by hand once secrets are stored.'
    );
    e.code = 'SECRETBOX_WEAK_APP_KEY';
    return e;
}

/**
 * Throws in production when APP_KEY is missing or weak. Called once at boot
 * so the service fails at start-up rather than at the first secret save.
 */
function assertConfigured(env = process.env) {
    if (!isProduction(env)) return true;
    if (!env.APP_KEY) throw missingKeyError();
    if (isWeakAppKey(env.APP_KEY)) throw weakKeyError();
    return true;
}

/** Whether values written now are really encrypted (false only in keyless dev). */
function isEnabled() {
    return v2Ikm() != null;
}

function isEncrypted(value) {
    return typeof value === 'string' && (value.startsWith(V2) || value.startsWith(V1));
}

/** A stored value that should be re-encrypted to the current format on next write. */
function needsUpgrade(value) {
    if (value == null || value === '') return false;
    if (typeof value !== 'string') return true;
    return !value.startsWith(V2);
}

function gcmOpen(key, ivB, tagB, ctB, aad) {
    const tag = Buffer.from(String(tagB || ''), 'base64');
    // authTagLength pinned to the full 16 bytes: without it Node accepts a
    // SHORTER tag in setAuthTag (4/8/12 … bytes are legal GCM), which would cut
    // forgery resistance to as little as 2^32 for anyone able to rewrite a
    // stored ciphertext.
    if (tag.length !== 16) throw new Error('secretBox: bad auth tag length');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(ivB), 'base64'), {
        authTagLength: 16,
    });
    if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(String(ctB || ''), 'base64')), d.final()]).toString(
        'utf8'
    );
}

/** Encrypt with an explicit keying material (rotation tooling). Always v2. */
function encryptWithKey(ikm, plaintext, purpose = DEFAULT_PURPOSE) {
    if (!ikm) throw missingKeyError();
    const p = String(purpose || DEFAULT_PURPOSE);
    if (!PURPOSE_RE.test(p)) throw new Error('secretBox: invalid purpose label');
    const iv = crypto.randomBytes(12);
    const aad = V2 + p;
    const cipher = crypto.createCipheriv('aes-256-gcm', v2Key(ikm, p), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return (
        aad +
        ':' +
        [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(
            ':'
        )
    );
}

/**
 * Encrypt a secret. `purpose` is a short label ([a-z0-9_.-]) that derives a
 * distinct key per use (e.g. 'app_settings', 'webhook'); callers that do not
 * name one get 'generic'. Keyless development returns the plaintext.
 */
function encrypt(plaintext, purpose = DEFAULT_PURPOSE) {
    const ikm = v2Ikm();
    if (ikm == null) {
        if (isProduction()) throw missingKeyError();
        return String(plaintext); // development without any key: stored clear
    }
    return encryptWithKey(ikm, plaintext, purpose);
}

/**
 * Decrypt with explicit key material (rotation tooling).
 * `keys` = { appKey, sessionSecret, production }.
 */
function decryptWithKeys(value, keys = {}, opts = {}) {
    const env = {
        APP_KEY: keys.appKey || '',
        SESSION_SECRET: keys.sessionSecret || '',
        NODE_ENV: keys.production ? 'production' : 'development',
    };
    return _decrypt(value, env, opts);
}

function _decrypt(value, env, { purpose = null } = {}) {
    if (typeof value !== 'string') return value;
    if (value.startsWith(V2)) {
        const rest = value.slice(V2.length).split(':');
        const p = rest[0];
        if (!PURPOSE_RE.test(p || '')) throw new Error('secretBox: malformed v2 value');
        if (purpose && purpose !== p) throw new Error('secretBox: purpose mismatch');
        const ikm = v2Ikm(env);
        if (ikm == null) {
            if (isProduction(env)) throw missingKeyError();
            throw new Error('secretBox: APP_KEY/SESSION_SECRET required to decrypt');
        }
        const [, ivB, tagB, ...ctRest] = rest;
        return gcmOpen(v2Key(ikm, p), ivB, tagB, ctRest.join(':'), V2 + p);
    }
    if (value.startsWith(V1)) {
        const keys = v1Keys(env);
        if (!keys.length) throw new Error('secretBox: APP_KEY/SESSION_SECRET required to decrypt');
        const [ivB, tagB, ...ctRest] = value.slice(V1.length).split(':');
        let lastErr = null;
        for (const k of keys) {
            try {
                return gcmOpen(k, ivB, tagB, ctRest.join(':'), null);
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }
    return value; // legacy clear text
}

/** Decrypt a stored value (v2, v1, or legacy clear text which passes through). */
function decrypt(value, opts) {
    return _decrypt(value, process.env, opts || {});
}

/**
 * Re-encrypt one stored value from an OLD key set to a NEW APP_KEY (v2).
 * Clear text / empty values are returned unchanged unless `encryptClear`.
 * Used by scripts/rotate-app-key.js.
 */
function rotateValue(value, { from = {}, toAppKey, purpose = null, encryptClear = false } = {}) {
    if (value == null || value === '') return value;
    if (!isEncrypted(value) && !encryptClear) return value;
    const plain = isEncrypted(value) ? decryptWithKeys(value, from) : String(value);
    let p = purpose;
    if (!p && typeof value === 'string' && value.startsWith(V2))
        p = value.slice(V2.length).split(':')[0];
    return encryptWithKey(toAppKey, plain, p || DEFAULT_PURPOSE);
}

module.exports = {
    encrypt,
    decrypt,
    isEnabled,
    isEncrypted,
    needsUpgrade,
    assertConfigured,
    isWeakAppKey,
    encryptWithKey,
    decryptWithKeys,
    rotateValue,
    PREFIX_V1: V1,
    PREFIX_V2: V2,
    V2_SALT,
};
