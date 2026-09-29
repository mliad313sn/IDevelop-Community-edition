'use strict';

/**
 * secretBox — symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * Key derives from APP_KEY (preferred) or SESSION_SECRET. When no key is set
 * (dev), values pass through in clear so nothing breaks — encrypt returns the
 * plaintext and decrypt returns whatever it is handed. Ciphertext is tagged
 * with the 'enc:v1:' prefix so decrypt can tell encrypted from legacy-clear.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function key() {
    const secret = process.env.APP_KEY || process.env.SESSION_SECRET || '';
    if (!secret) return null;
    return crypto.createHash('sha256').update(String(secret)).digest(); // 32 bytes
}

function isEnabled() {
    return key() != null;
}

function encrypt(plaintext) {
    const k = key();
    if (k == null) return String(plaintext); // dev: store clear
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return (
        PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
    );
}

function decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // legacy clear
    const k = key();
    if (k == null) throw new Error('secretBox: APP_KEY/SESSION_SECRET required to decrypt');
    // Format after the prefix: <iv>:<tag>:<ct> (base64; ct rejoined defensively).
    const [ivB, tagB, ...ctRest] = value.slice(PREFIX.length).split(':');
    const ctB = ctRest.join(':');
    // authTagLength is pinned to the full 16 bytes: without it Node accepts a
    // SHORTER tag in setAuthTag (4/8/12/… bytes are legal GCM), which would cut
    // forgery resistance from 2^128 to as little as 2^32 for anyone able to
    // rewrite a stored ciphertext.
    const tag = Buffer.from(tagB, 'base64');
    if (tag.length !== 16) throw new Error('secretBox: bad auth tag length');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64'), {
        authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString(
        'utf8'
    );
}

module.exports = { encrypt, decrypt, isEnabled };
