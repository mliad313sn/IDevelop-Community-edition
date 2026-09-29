'use strict';
/**
 * "Test sign-in" for the SSO settings (SSO facilitator, phase 1).
 *
 * A SuperAdmin starts a real round trip to the identity provider; the response
 * comes back through the normal ACS, is fully validated (signature, audience,
 * issuer, replay, destination), and — because its RelayState carries a test
 * token THIS admin was issued — nothing else happens: no session, no identity
 * link, no mapping claimed, no onboarding request, no password disabled. What
 * the IdP sent and which account it WOULD resolve to is kept for that admin
 * to read, once.
 *
 * Tokens live in process memory: the appliance is a single process, a test is
 * a one-minute interactive action, and a restart simply expires it.
 *
 * @module services/SsoTestService
 */
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const PREFIX = 'ssotest:';
const _tokens = new Map(); // nonce -> { adminId, provider, expires, result }

function _gc() {
    const now = Date.now();
    for (const [k, v] of _tokens) if (v.expires < now) _tokens.delete(k);
}

/** A new test token for this SuperAdmin; returns the RelayState to send. */
function issue(adminId, provider) {
    _gc();
    const nonce = crypto.randomBytes(18).toString('hex');
    _tokens.set(nonce, {
        adminId: Number(adminId),
        provider,
        expires: Date.now() + TTL_MS,
        result: null,
    });
    return { nonce, relayState: PREFIX + nonce };
}

/** The live test token named by a RelayState, or null. */
function fromRelayState(relayState, provider) {
    if (typeof relayState !== 'string' || !relayState.startsWith(PREFIX)) return null;
    const nonce = relayState.slice(PREFIX.length);
    const t = _tokens.get(nonce);
    if (!t || t.expires < Date.now() || t.result || (provider && t.provider !== provider))
        return null;
    return { nonce, ...t };
}

function isTestRelayState(relayState) {
    return typeof relayState === 'string' && relayState.startsWith(PREFIX);
}

function setResult(nonce, result) {
    const t = _tokens.get(nonce);
    if (t) t.result = { ...result, at: new Date().toISOString() };
}

/** The diagnostic, for the admin who started the test only. */
function readResult(nonce, adminId) {
    const t = _tokens.get(String(nonce || ''));
    if (!t || t.expires < Date.now() || Number(adminId) !== t.adminId) return null;
    return t.result
        ? { provider: t.provider, ...t.result }
        : { provider: t.provider, pending: true };
}

module.exports = { issue, fromRelayState, isTestRelayState, setResult, readResult, PREFIX };
