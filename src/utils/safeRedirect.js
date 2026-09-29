'use strict';

// Open-redirect guard (CWE-601). "Bounce the user back where they came from" is a
// common pattern (post-action redirects, denied writes, the error handler, the lang
// switcher) — but the Referer header is attacker-influenceable: a hostile page that
// links to / auto-submits a form on our app makes the victim's browser send its own
// URL as the Referer, and a naive `res.redirect(req.get('Referer'))` then bounces the
// victim to the attacker's site. Defence: only ever redirect to a SAME-ORIGIN target,
// and reduce it to a RELATIVE path so the host can never be attacker-controlled.

/**
 * Resolve a safe "go back" URL from the request's Referer.
 * Returns a relative path (`/foo?bar`) only when the Referer is same-origin as the
 * current host; otherwise the fallback. Never returns an absolute/cross-origin URL.
 * @param {import('express').Request} req
 * @param {string} [fallback='/dashboard']
 * @returns {string}
 */
function safeBackUrl(req, fallback = '/dashboard') {
    const ref = req.get('Referer');
    if (!ref) return fallback;
    try {
        const u = new URL(ref);
        if (u.host !== req.get('host')) return fallback;
        // SECURITY (audit 2026-09-29, SA-08): a same-origin Referer can still
        // carry a path that STARTS with `//` or `/\` (https://app//evil.example/x
        // is a page of this host — a 404 — whose pathname is //evil.example/x).
        // Handed to res.redirect, that path is a protocol-relative URL and the
        // browser leaves for evil.example. Only a single leading slash is relative.
        const rel = u.pathname + u.search;
        if (!/^\/(?![/\\])/.test(rel)) return fallback;
        return rel; // relative only
    } catch (_) {
        /* malformed Referer → fallback */
    }
    return fallback;
}

module.exports = { safeBackUrl };
