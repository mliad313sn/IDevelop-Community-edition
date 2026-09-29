'use strict';
/**
 * SAML response hardening that the library leaves to the application
 * (SSO facilitator, phase 1 — migration 145).
 *
 * node-saml validates signatures, audience and timestamps, but:
 *   - its InResponseTo cache is in process memory (lost on every restart), and
 *     `validateInResponseTo` was never switched on here, so ANY signed response
 *     was accepted, solicited or not;
 *   - it keeps no record of assertions already used, so a captured response
 *     could be replayed until its NotOnOrAfter;
 *   - it never checks the response's Destination against our ACS URL.
 * This module closes those three, plus the post-login redirect (RelayState),
 * which must only ever be one of OUR pages.
 *
 * @module services/SamlSecurityService
 */
const db = require('../config/database');

const REQUEST_TTL_MS = 10 * 60 * 1000; // an AuthnRequest is answerable for 10 minutes
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_SEEN_TTL_MS = 60 * 60 * 1000;
const MAX_SEEN_TTL_MS = 24 * 60 * 60 * 1000;

let _lastSweep = 0;
async function _sweep() {
    const now = Date.now();
    if (now - _lastSweep < 60 * 1000) return;
    _lastSweep = now;
    await db
        .run(`DELETE FROM saml_request_cache WHERE created_at < now() - make_interval(secs => ?)`, [
            REQUEST_TTL_MS / 1000,
        ])
        .catch(() => {});
    await db.run('DELETE FROM saml_assertion_seen WHERE expires_at < now()').catch(() => {});
}

/**
 * node-saml CacheProvider backed by `saml_request_cache` — the ids of the
 * AuthnRequests we issued, so `validateInResponseTo` survives a restart.
 */
const requestCache = {
    async saveAsync(key, value) {
        await _sweep();
        await db.run(
            'INSERT INTO saml_request_cache (request_id, value) VALUES (?, ?) ON CONFLICT (request_id) DO NOTHING',
            [String(key), String(value)]
        );
        return { value: String(value), createdAt: Date.now() };
    },
    async getAsync(key) {
        if (!key) return null;
        const r = await db.get(
            `SELECT value FROM saml_request_cache
              WHERE request_id = ? AND created_at >= now() - make_interval(secs => ?)`,
            [String(key), REQUEST_TTL_MS / 1000]
        );
        return r ? r.value : null;
    },
    async removeAsync(key) {
        if (!key) return null;
        const r = await db.get(
            'DELETE FROM saml_request_cache WHERE request_id = ? RETURNING value',
            [String(key)]
        );
        return r ? r.value : null;
    },
};

/**
 * Read the few routing facts we need from a (base64) SAMLResponse WITHOUT
 * trusting it: the signature is verified by node-saml afterwards. DTDs and
 * entities are refused outright (no XXE / billion-laughs surface).
 * @returns {{destination:string|null, assertionId:string|null, responseId:string|null, notOnOrAfter:string|null}|null}
 */
function inspectResponse(samlResponseB64) {
    if (typeof samlResponseB64 !== 'string' || !samlResponseB64) return null;
    if (samlResponseB64.length > MAX_RESPONSE_BYTES * 1.4) return null;
    let xml;
    try {
        xml = Buffer.from(samlResponseB64, 'base64').toString('utf8');
    } catch (_) {
        return null;
    }
    if (xml.length > MAX_RESPONSE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
    const { XMLParser } = require('fast-xml-parser');
    let doc;
    try {
        doc = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            removeNSPrefix: true,
            processEntities: false,
            parseTagValue: false,
            parseAttributeValue: false,
        }).parse(xml);
    } catch (_) {
        return null;
    }
    const resp = doc && doc.Response;
    if (!resp || typeof resp !== 'object') return null;
    const first = (x) => (Array.isArray(x) ? x[0] : x);
    const assertion = first(resp.Assertion);
    const conditions = assertion && first(assertion.Conditions);
    const scd =
        assertion && assertion.Subject && first(first(assertion.Subject).SubjectConfirmation);
    const scdData = scd && first(scd.SubjectConfirmationData);
    return {
        destination: resp['@_Destination'] || null,
        responseId: resp['@_ID'] || null,
        // An encrypted assertion hides its ID: the (signed) Response ID stands in.
        assertionId: (assertion && assertion['@_ID']) || null,
        notOnOrAfter:
            (scdData && scdData['@_NotOnOrAfter']) ||
            (conditions && conditions['@_NotOnOrAfter']) ||
            null,
    };
}

/** The Destination a response names must be OUR ACS URL (when it names one). */
function destinationOk(destination, callbackUrl) {
    if (!destination) return true; // optional in the spec; audience + signature still hold
    try {
        const a = new URL(String(destination));
        const b = new URL(String(callbackUrl));
        return (
            a.protocol === b.protocol &&
            a.host.toLowerCase() === b.host.toLowerCase() &&
            a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '')
        );
    } catch (_) {
        return false;
    }
}

/**
 * Record an accepted assertion; false when the same (issuer, id) was already
 * used — a replay. Kept until the assertion's own NotOnOrAfter (bounded).
 */
async function recordAssertion({ issuer, assertionId, notOnOrAfter }) {
    // No id to key on = no replay protection = refuse (fail closed). Every real
    // IdP (Entra, ADFS, Okta) issues one; a response without is not accepted.
    if (!assertionId) return false;
    await _sweep();
    let ttl = DEFAULT_SEEN_TTL_MS;
    const t = Date.parse(notOnOrAfter || '');
    if (Number.isFinite(t))
        ttl = Math.min(MAX_SEEN_TTL_MS, Math.max(5 * 60 * 1000, t - Date.now() + 5 * 60 * 1000));
    const r = await db.run(
        `INSERT INTO saml_assertion_seen (issuer, assertion_id, expires_at)
         VALUES (?, ?, now() + make_interval(secs => ?))
         ON CONFLICT (issuer, assertion_id) DO NOTHING`,
        [String(issuer || ''), String(assertionId), Math.round(ttl / 1000)]
    );
    return !!(r && r.changes);
}

/**
 * The only post-login destinations accepted from a RelayState: one of our own
 * pages, as a relative path. Anything else (absolute URL, protocol-relative
 * `//host`, backslash tricks, control characters, our auth endpoints) → null,
 * and the caller falls back to the user's home page.
 */
function safeRelayPath(relayState) {
    if (typeof relayState !== 'string') return null;
    const s = relayState.trim();
    if (!s || s.length > 512) return null;
    if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return null;
    // No control characters and no backslash anywhere.
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f || c === 0x5c) return null;
    }
    if (/^\/(auth|login|logout)(\/|$|\?)/i.test(s)) return null;
    return s;
}

/**
 * The ID of the assertion node-saml VERIFIED (profile.getAssertionXml) — the
 * replay key must come from what the signature covers, never from a separate
 * parse of the raw response that an attacker can make read something else.
 */
function verifiedAssertionId(assertionXml) {
    if (typeof assertionXml !== 'string' || !assertionXml) return null;
    const m =
        /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:[A-Za-z_][\w.-]*:)?Assertion\b[^>]*?\sID="([^"]+)"/.exec(
            assertionXml
        );
    return m ? m[1] : null;
}

module.exports = {
    requestCache,
    inspectResponse,
    destinationOk,
    recordAssertion,
    safeRelayPath,
    verifiedAssertionId,
};
