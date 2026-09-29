'use strict';

/**
 * WebhookService — OUTBOUND event webhooks. External systems subscribe to events
 * (employee.created, ninebox.approved, pip.opened, readiness.changed, …) and
 * receive signed JSON POSTs. This makes IDevelop event-driven for integration,
 * not just pull-only. Dispatch is best-effort + recorded for observability.
 */
const crypto = require('crypto');
const db = require('../config/database');
const secretBox = require('../utils/secretBox');

// Reject SSRF targets: a superadmin (or a compromised one) must not be able to
// point a webhook at the server's own loopback/metadata/internal network.
function assertSafeWebhookUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        throw new Error('Invalid webhook URL');
    }
    if (!['http:', 'https:'].includes(u.protocol))
        throw new Error('Only http(s) webhook URLs are allowed');
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked =
        host === 'localhost' ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host === '::' ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^(fc|fd)[0-9a-f]{2}:/i.test(host) ||
        /^fe80:/i.test(host);
    if (blocked) throw new Error('Webhook URL targets a private/loopback/internal address');
}

class WebhookService {
    async subscribe({ label, url, secret = null, events = ['*'], createdByAdminId = null }) {
        if (!label || !url) throw new Error('label and url required');
        assertSafeWebhookUrl(url);
        // Encrypt the signing secret at rest (decrypted only to sign on emit).
        const storedSecret = secret ? secretBox.encrypt(String(secret)) : null;
        return db.get(
            `INSERT INTO webhook_subscriptions (label, url, secret, events, created_by_admin_id)
             VALUES (?, ?, ?, ?, ?) RETURNING id, label, url, events, enabled`,
            [
                label,
                url,
                storedSecret,
                JSON.stringify(events && events.length ? events : ['*']),
                createdByAdminId,
            ]
        );
    }
    async list() {
        return db.all(
            `SELECT id, label, url, events, enabled, last_status, last_delivery_at, created_at,
                    (secret IS NOT NULL) AS has_secret
             FROM webhook_subscriptions ORDER BY id DESC`
        );
    }
    async setEnabled(id, enabled) {
        await db.run('UPDATE webhook_subscriptions SET enabled = ? WHERE id = ?', [!!enabled, id]);
    }
    async remove(id) {
        await db.run('DELETE FROM webhook_subscriptions WHERE id = ?', [id]);
    }

    _matches(events, event) {
        const arr = Array.isArray(events) ? events : [];
        return arr.includes('*') || arr.includes(event);
    }

    /**
     * Emit an event to all matching, enabled subscriptions. Best-effort, bounded
     * (5s timeout per call), signed with HMAC-SHA256 in x-idevelop-signature. Never
     * throws to callers — emitting must not break the originating action.
     */
    async emit(event, data = {}) {
        try {
            const subs = await db.all('SELECT * FROM webhook_subscriptions WHERE enabled = true');
            const targets = subs.filter((s) => this._matches(s.events, event));
            if (!targets.length) return { delivered: 0 };
            const fetchImpl = globalThis.fetch;
            if (!fetchImpl) {
                console.error(
                    '[webhooks] global fetch unavailable (Node 18+ required) — delivery skipped'
                );
                return { delivered: 0, error: 'no-fetch' };
            }
            let delivered = 0;
            for (const s of targets) {
                const body = JSON.stringify({ event, data, ts: new Date().toISOString() });
                const headers = { 'Content-Type': 'application/json', 'x-idevelop-event': event };
                if (s.secret) {
                    const signingSecret = secretBox.decrypt(s.secret); // handles legacy clear too
                    headers['x-idevelop-signature'] =
                        'sha256=' +
                        crypto.createHmac('sha256', signingSecret).update(body).digest('hex');
                }
                // Re-validate at emit (defends against a row edited directly in the DB).
                try {
                    assertSafeWebhookUrl(s.url);
                } catch (e) {
                    db.run('UPDATE webhook_subscriptions SET last_status = ? WHERE id = ?', [
                        'blocked-url',
                        s.id,
                    ]).catch(() => {});
                    continue;
                }
                let code = null;
                let ok = false;
                try {
                    const ctrl = new AbortController();
                    const t = setTimeout(() => ctrl.abort(), 5000);
                    const res = await fetchImpl(s.url, {
                        method: 'POST',
                        headers,
                        body,
                        signal: ctrl.signal,
                    });
                    clearTimeout(t);
                    code = res.status;
                    ok = res.ok;
                } catch (e) {
                    code = null;
                    ok = false;
                }
                if (ok) delivered++;
                db.run(
                    'UPDATE webhook_subscriptions SET last_status = ?, last_delivery_at = now() WHERE id = ?',
                    [String(code || 'error'), s.id]
                ).catch(() => {});
                db.run(
                    'INSERT INTO webhook_deliveries (subscription_id, event, payload, status_code, ok) VALUES (?, ?, ?, ?, ?)',
                    [s.id, event, body, code, ok]
                ).catch(() => {});
            }
            return { delivered, targets: targets.length };
        } catch (_) {
            return { delivered: 0, error: true };
        }
    }
}

module.exports = new WebhookService();
