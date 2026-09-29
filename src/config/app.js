'use strict';
const crypto = require('crypto');

const env = process.env.NODE_ENV || 'development';

// Secrets must never fall back to a hardcoded/guessable default. In production
// a missing secret is fatal; in dev we generate an ephemeral random value for
// this run (and warn) so nothing ships a known default.
// Reject a present-but-weak secret in production. A guessable SESSION_SECRET lets
// anyone forge/tamper with signed session cookies for any user, so warn-only is not
// enough — this is fatal at config load. Supports comma-separated key rotation
// (newest key first); EVERY key must be strong.
function assertStrong(name, val) {
    const parts = String(val)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const p of parts) {
        const weak =
            p.length < 24 ||
            /change|default|example|sample|placeholder|secret-key|password|please|test\b|dev\b|20\d\d/i.test(
                p
            );
        if (weak) {
            throw new Error(
                `${name} is set but too weak for production (guessable or <24 chars). Use a long random value, e.g. \`openssl rand -hex 32\`, and rotate old keys via comma-separated ${name}.`
            );
        }
    }
}

function secret(name, bytes) {
    const v = process.env[name];
    if (v && v.trim()) {
        if (env === 'production') assertStrong(name, v.trim());
        return v.trim();
    }
    if (env === 'production') {
        throw new Error(`${name} must be set in the environment (no insecure default is allowed).`);
    }
    const generated = crypto.randomBytes(bytes).toString('hex');
    console.warn(
        `⚠️  ${name} is not set — using an ephemeral random value for this run. Set it in .env.`
    );
    return generated;
}

/**
 * The LEGACY SHARED API key (full-org SYSTEM principal, superadmin scope) —
 * only when API_KEY is set EXPLICITLY and is not the at-rest encryption key.
 *
 * 3.23.17 (S-02): this used to be `API_KEY || APP_KEY || <ephemeral>`. The
 * installer writes only APP_KEY, so on every appliance the key that encrypts
 * MFA/SSO/LMS secrets was ALSO a superadmin bearer credential. Now:
 *   - API_KEY unset            -> no legacy key (issue per-profile keys instead);
 *   - API_KEY === APP_KEY      -> refused, with a boot warning;
 *   - API_KEY weak (production)-> refused, with a boot warning.
 * Refusal is fail-closed for the CREDENTIAL, never fatal for the boot.
 */
function legacyApiKey() {
    const apiKey = String(process.env.API_KEY || '').trim();
    if (!apiKey) return { key: null, refused: null };
    const appKey = String(process.env.APP_KEY || '').trim();
    if (appKey && apiKey === appKey) {
        const why =
            'API_KEY is identical to APP_KEY (the at-rest encryption key) - the legacy shared API key is DISABLED. Set a different random API_KEY, or better, issue a per-profile key in Admin > API keys.';
        console.warn(`⚠️  ${why}`);
        return { key: null, refused: why };
    }
    if (env === 'production') {
        try {
            assertStrong('API_KEY', apiKey);
        } catch (e) {
            const why = `API_KEY is too weak for production - the legacy shared API key is DISABLED. ${e.message}`;
            console.warn(`⚠️  ${why}`);
            return { key: null, refused: why };
        }
    }
    return { key: apiKey, refused: null };
}
const _legacy = legacyApiKey();

module.exports = {
    port: process.env.PORT || 3000,
    env,
    sessionSecret: secret('SESSION_SECRET', 32),
    databaseUrl: process.env.DATABASE_URL,
    // Legacy shared API key or null. NEVER falls back to APP_KEY (see above).
    apiKey: _legacy.key,
    // Why an explicitly-set API_KEY was refused (surfaced in the boot warnings).
    apiKeyRefused: _legacy.refused,
};
