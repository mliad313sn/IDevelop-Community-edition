'use strict';

/**
 * AuditRetentionService — the audit log's life cycle.
 *
 * fingerprint() is what an audit line writes for an identifier that names no
 * known account (a failed sign-in): never the identifier as typed.
 */

const crypto = require('crypto');

/**
 * A typed identifier that names NO known account (a failed login) is never
 * written as typed: a short keyed fingerprint still shows the same identifier
 * being tried again and again. Keyed (HMAC with the session secret) so that
 * the database alone cannot be turned back into the addresses that were typed
 * by hashing a list of candidates.
 */
function fingerprint(identifier) {
    const s = String(identifier == null ? '' : identifier)
        .trim()
        .toLowerCase();
    if (!s) return 'fp:none';
    // SESSION_SECRET may list several secrets (rotation); the first one keys it.
    const secret =
        String(process.env.SESSION_SECRET || '')
            .split(',')[0]
            .trim() || 'dev-only';
    const key = `audit-fingerprint:${secret}`;
    return 'fp:' + crypto.createHmac('sha256', key).update(s).digest('hex').slice(0, 10);
}

class AuditRetentionService {
    constructor() {
        this.fingerprint = fingerprint;
    }
}

module.exports = new AuditRetentionService();
