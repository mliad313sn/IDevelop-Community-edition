'use strict';

/**
 * Minimal RS256 JWT signer/verifier for LTI 1.3 — uses Node's built-in crypto,
 * no extra dependency. Sufficient for issuing signed id_token launches and for
 * round-trip verification in tests.
 */
const crypto = require('crypto');

function b64url(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}
function b64urlJson(obj) {
    return b64url(JSON.stringify(obj));
}

function signRS256(payload, privateKeyPem, { kid } = {}) {
    if (!privateKeyPem) throw new Error('private key (PEM) required to sign LTI launch');
    const header = { alg: 'RS256', typ: 'JWT' };
    if (kid) header.kid = kid;
    const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
    return `${signingInput}.${b64url(signature)}`;
}

function verifyRS256(token, publicKeyPem) {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return null;
    const signingInput = `${h}.${p}`;
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const ok = crypto.createVerify('RSA-SHA256').update(signingInput).verify(publicKeyPem, sig);
    if (!ok) return null;
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

module.exports = { signRS256, verifyRS256, b64url };
