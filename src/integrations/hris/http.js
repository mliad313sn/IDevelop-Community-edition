'use strict';

/**
 * Outbound HTTP for the HRIS connectors — the SAME SSRF posture as outbound
 * webhooks (WebhookService) and the SAML metadata fetch:
 *
 *   - http(s) only, no credentials in the URL, https required for a public
 *     host (an HR export travels with names and e-mails);
 *   - loopback / private / link-local / metadata / CGNAT / ULA / IPv4-mapped
 *     literals refused through the one shared classifier
 *     (SamlMetadataService.isPrivateAddress), and so is any NAME that resolves
 *     to such an address;
 *   - the connection is PINNED to the address that was checked (no second DNS
 *     lookup between the check and the connect), redirects are never followed;
 *   - every call is bounded by a timeout and a response-size cap.
 *
 * HRIS_ALLOW_PRIVATE=1 is the operator's opt-in for an on-prem HRIS gateway on
 * the LAN (default: refused), the same switch WEBHOOK_ALLOW_PRIVATE is for
 * webhooks.
 *
 * Tests inject `transport` (and `lookup`) instead of opening sockets; the URL
 * check still runs first, so an SSRF refusal is tested on the real guard.
 */
const dns = require('dns');
const net = require('net');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 25 * 1024 * 1024;

function isPrivateAddress(ip) {
    return require('../../services/SamlMetadataService').isPrivateAddress(ip);
}

function allowPrivate() {
    return process.env.HRIS_ALLOW_PRIVATE === '1';
}

function refusal(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

/** Synchronous checks on the URL itself. Throws with a stable `.code`. */
function assertSafeHrisUrl(raw) {
    let u;
    try {
        u = new URL(String(raw || ''));
    } catch {
        throw refusal('hris_url_invalid', 'Invalid HRIS URL');
    }
    if (!['http:', 'https:'].includes(u.protocol))
        throw refusal('hris_url_scheme', 'Only http(s) HRIS URLs are allowed');
    if (u.username || u.password)
        throw refusal('hris_url_credentials', 'The HRIS URL must not carry credentials');
    if (allowPrivate()) return u;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked =
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        (net.isIP(host) !== 0 && isPrivateAddress(host));
    if (blocked)
        throw refusal(
            'hris_url_private',
            'The HRIS URL targets a private, loopback or internal address'
        );
    if (u.protocol !== 'https:')
        throw refusal('hris_url_scheme', 'A public HRIS endpoint must be reached over https');
    return u;
}

/** Resolve and refuse when ANY answer is private; returns the pinned address. */
async function resolveTarget(raw, { lookup } = {}) {
    const u = assertSafeHrisUrl(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return { url: u, address: { address: host, family: net.isIP(host) } };
    const look = lookup || ((h) => dns.promises.lookup(h, { all: true, verbatim: true }));
    let addrs;
    try {
        addrs = await look(host);
    } catch {
        throw refusal('hris_url_unresolved', 'The HRIS host does not resolve');
    }
    if (!addrs || !addrs.length)
        throw refusal('hris_url_unresolved', 'The HRIS host does not resolve');
    if (!allowPrivate() && addrs.some((a) => isPrivateAddress(a.address)))
        throw refusal(
            'hris_url_private',
            'The HRIS URL resolves to a private, loopback or internal address'
        );
    return { url: u, address: addrs[0] };
}

/** The real transport: one request to the CHECKED address, no redirect. */
function nodeTransport(url, address, { method, headers, body, timeoutMs }) {
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    return new Promise((resolve, reject) => {
        const req = lib.request(
            url,
            {
                method,
                timeout: timeoutMs,
                headers: {
                    ...headers,
                    ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
                lookup: (_h, opts, cb) =>
                    opts && opts.all
                        ? cb(null, [{ address: address.address, family: address.family }])
                        : cb(null, address.address, address.family),
            },
            (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                    size += c.length;
                    if (size > MAX_BYTES) {
                        req.destroy();
                        reject(refusal('hris_response_too_large', 'HRIS response too large'));
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString('utf8'),
                    })
                );
                res.on('error', reject);
            }
        );
        req.on('timeout', () => {
            req.destroy();
            reject(refusal('hris_timeout', 'The HRIS endpoint did not answer in time'));
        });
        req.on('error', (e) => reject(e));
        if (body != null) req.end(body);
        else req.end();
    });
}

/**
 * JSON request through the guard. `opts.transport(url, address, reqOpts)` and
 * `opts.lookup(host)` are test seams. Throws an Error with `.status` on a
 * non-2xx answer (a 3xx included: redirects are refused, not followed).
 */
async function requestJson(
    raw,
    { method = 'GET', headers = {}, json, form, timeoutMs, transport, lookup, onHeaders } = {}
) {
    const { url, address } = await resolveTarget(raw, { lookup });
    const h = { Accept: 'application/json', ...headers };
    let body = null;
    if (form) {
        h['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
        h['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    }
    const res = await (transport || nodeTransport)(url, address, {
        method,
        headers: h,
        body,
        timeoutMs: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
    });
    let parsed = null;
    try {
        parsed = res.text ? JSON.parse(res.text) : null;
    } catch {
        parsed = null;
    }
    if (!(res.status >= 200 && res.status < 300)) {
        const msg =
            parsed && (parsed.message || (parsed.error && (parsed.error.message || parsed.error)));
        const e = new Error(`HTTP ${res.status}${msg ? ': ' + String(msg).slice(0, 200) : ''}`);
        e.status = res.status;
        e.code =
            res.status >= 300 && res.status < 400 ? 'hris_redirect_refused' : 'hris_http_error';
        throw e;
    }
    if (typeof onHeaders === 'function') onHeaders(res.headers || {});
    return parsed;
}

module.exports = {
    assertSafeHrisUrl,
    resolveTarget,
    requestJson,
    DEFAULT_TIMEOUT_MS,
    MAX_BYTES,
};
