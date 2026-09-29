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

const dns = require('dns');
const net = require('net');

const DELIVERY_TIMEOUT_MS = 5000;

/** Private/loopback/link-local/CGNAT/ULA/mapped… — the one classifier the SAML
 *  metadata fetch and the safety-gate webhook already use. */
function isPrivateAddress(ip) {
    return require('./SamlMetadataService').isPrivateAddress(ip);
}

/** Operator opt-in for an on-prem receiver on the LAN (default: refused). */
function allowPrivate() {
    return process.env.WEBHOOK_ALLOW_PRIVATE === '1';
}

// Reject SSRF targets: a superadmin (or a compromised one) must not be able to
// point a webhook at the server's own loopback/metadata/internal network.
//
// SECURITY (audit 2026-09-29, SA-04): the string checks alone were bypassable —
//   - an IPv4-mapped IPv6 literal (http://[::ffff:127.0.0.1]/ serialises to
//     [::ffff:7f00:1], which no prefix test matched), CGNAT 100.64/10, 0/8…;
//   - any DNS name that RESOLVES to a private address (127.0.0.1.nip.io);
//   - a public receiver answering 302 → http://169.254.169.254/… (fetch follows).
// IP literals now go through the shared classifier here; names are resolved and
// the connection is PINNED to the checked address at delivery (resolveTarget /
// deliver), and redirects are never followed.
function assertSafeWebhookUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        throw new Error('Invalid webhook URL');
    }
    if (!['http:', 'https:'].includes(u.protocol))
        throw new Error('Only http(s) webhook URLs are allowed');
    if (u.username || u.password) throw new Error('Webhook URL must not carry credentials');
    if (allowPrivate()) return;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked =
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        (net.isIP(host) !== 0 && isPrivateAddress(host));
    if (blocked) throw new Error('Webhook URL targets a private/loopback/internal address');
}

/**
 * Validate the URL, resolve its host and refuse when ANY answer is private.
 * Returns the address the delivery must connect to (pinned: no second lookup,
 * so a DNS answer cannot change between the check and the connection).
 */
async function resolveTarget(raw) {
    assertSafeWebhookUrl(raw);
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!addrs || !addrs.length) throw new Error('Webhook host does not resolve');
    if (!allowPrivate() && addrs.some((a) => isPrivateAddress(a.address)))
        throw new Error('Webhook URL resolves to a private/loopback/internal address');
    return { url: u, address: addrs[0] };
}

/**
 * POST once to the CHECKED address. A 3xx is an answer (not followed), so a
 * receiver cannot bounce the request to an internal host.
 * @returns {Promise<{ok:boolean, status:number|null}>}
 */
async function deliver(raw, body, headers) {
    const { url, address } = await resolveTarget(raw);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    return new Promise((resolve) => {
        const req = lib.request(
            url,
            {
                method: 'POST',
                timeout: DELIVERY_TIMEOUT_MS,
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
                lookup: (_h, opts, cb) =>
                    opts && opts.all
                        ? cb(null, [{ address: address.address, family: address.family }])
                        : cb(null, address.address, address.family),
            },
            (res) => {
                res.resume();
                const status = res.statusCode;
                resolve({ ok: status >= 200 && status < 300, status });
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, status: null });
        });
        req.on('error', () => resolve({ ok: false, status: null }));
        req.end(body);
    });
}

const FORMATS = ['json', 'slack', 'teams'];

// Chat channels are wide audiences: a chat message carries the event name, a
// link and a few harmless facts, never personal assessments. Keys that could
// reveal a rating, a talent label, a risk or contact details are dropped.
const SENSITIVE_KEY =
    /(email|phone|mobile|address|birth|salary|pay|comp|risk|nine|box|potential|performance|rating|score|level|note|comment|reason|password|secret|token)/i;

function chatFacts(data) {
    const out = [];
    for (const [k, v] of Object.entries(data || {})) {
        if (out.length >= 6) break;
        if (SENSITIVE_KEY.test(k)) continue;
        if (v === null || v === undefined || typeof v === 'object') continue;
        out.push({ title: k, value: String(v).slice(0, 120) });
    }
    return out;
}

/**
 * Body for one delivery. `json` is the signed event envelope; `slack` and
 * `teams` are chat messages built for incoming webhooks. Pure, for tests.
 */
function renderPayload(format, event, data, ts, baseUrl) {
    if (format === 'slack' || format === 'teams') {
        const title = `IDevelop · ${event}`;
        const facts = chatFacts(data);
        const link = baseUrl ? String(baseUrl).replace(/\/$/, '') : '';
        if (format === 'slack') {
            const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } }];
            if (facts.length) {
                blocks.push({
                    type: 'section',
                    fields: facts.map((f) => ({
                        type: 'mrkdwn',
                        text: `*${f.title}*\n${f.value}`,
                    })),
                });
            }
            if (link) {
                blocks.push({
                    type: 'context',
                    elements: [{ type: 'mrkdwn', text: `<${link}|Open IDevelop> · ${ts}` }],
                });
            }
            return { text: title, blocks };
        }
        const body = [{ type: 'TextBlock', text: title, weight: 'Bolder', wrap: true }];
        if (facts.length) body.push({ type: 'FactSet', facts });
        body.push({ type: 'TextBlock', text: ts, isSubtle: true, size: 'Small' });
        const content = {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body,
        };
        if (link) content.actions = [{ type: 'Action.OpenUrl', title: 'Open IDevelop', url: link }];
        return {
            type: 'message',
            attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }],
        };
    }
    return { event, data, ts };
}

class WebhookService {
    async subscribe({
        label,
        url,
        secret = null,
        events = ['*'],
        format = 'json',
        createdByAdminId = null,
    }) {
        if (!label || !url) throw new Error('label and url required');
        if (!FORMATS.includes(format)) throw new Error('format must be json, slack or teams');
        assertSafeWebhookUrl(url);
        // Encrypt the signing secret at rest (decrypted only to sign on emit).
        const storedSecret = secret ? secretBox.encrypt(String(secret)) : null;
        return db.get(
            `INSERT INTO webhook_subscriptions (label, url, secret, events, format, created_by_admin_id)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING id, label, url, events, format, enabled`,
            [
                label,
                url,
                storedSecret,
                JSON.stringify(events && events.length ? events : ['*']),
                format,
                createdByAdminId,
            ]
        );
    }
    async list() {
        return db.all(
            `SELECT id, label, url, events, format, enabled, last_status, last_delivery_at, created_at,
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

    /** Delivery seam (pinned, no redirects) — overridable in tests. */
    _deliver(url, body, headers) {
        return deliver(url, body, headers);
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
            let delivered = 0;
            for (const s of targets) {
                const body = JSON.stringify(
                    renderPayload(
                        s.format || 'json',
                        event,
                        data,
                        new Date().toISOString(),
                        process.env.APP_BASE_URL
                    )
                );
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
                    const r = await this._deliver(s.url, body, headers);
                    code = r.status;
                    ok = r.ok;
                } catch (e) {
                    // resolveTarget refused the address at delivery time (a name
                    // that now resolves privately): same outcome as the check above.
                    db.run('UPDATE webhook_subscriptions SET last_status = ? WHERE id = ?', [
                        'blocked-url',
                        s.id,
                    ]).catch(() => {});
                    continue;
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
module.exports.renderPayload = renderPayload;
module.exports.FORMATS = FORMATS;
module.exports.assertSafeWebhookUrl = assertSafeWebhookUrl;
module.exports.resolveTarget = resolveTarget;
module.exports.deliver = deliver;
