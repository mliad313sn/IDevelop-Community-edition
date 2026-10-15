'use strict';
/**
 * « Would this person get through that route's gate? »
 *
 * The « À traiter » list, the bell and the dashboards link to queues. A link
 * must never open on a refusal (a compliance admin's bell pointing at
 * /cycles/9, whose gate wants `manage_cycles`, answered 403). Rather than
 * re-spell each gate as a second, drifting predicate, a task carries the SAME
 * guard middleware its route is mounted with (`requirePermission(...)`,
 * `requireManagerOrAdmin`, …) and this helper runs it against the user with a
 * stub request: the guard either calls next() (the page opens) or answers a
 * refusal (the task is dropped).
 *
 * The stub announces a JSON caller, so every refusal path of middleware/auth.js
 * is synchronous and side-effect free (a JSON 403/401 written to the stub; no
 * flash, no render, no database read). A guard that throws, or never decides
 * synchronously, counts as a refusal: this check fails CLOSED.
 */

function stubResponse() {
    const res = {
        statusCode: 200,
        headers: {},
        status(code) {
            res.statusCode = code;
            return res;
        },
        json() {
            return res;
        },
        send() {
            return res;
        },
        end() {
            return res;
        },
        set() {
            return res;
        },
        setHeader() {
            return res;
        },
        redirect() {
            return res;
        },
        render() {
            return res;
        },
        cookie() {
            return res;
        },
        clearCookie() {
            return res;
        },
        locals: {},
    };
    return res;
}

/**
 * @param {Function|Function[]} guards  one middleware or a chain (all must pass)
 * @param {object} user                 the deserialized req.user
 * @returns {boolean}
 */
function passesGuard(guards, user) {
    if (!user) return false;
    const chain = Array.isArray(guards) ? guards : [guards];
    for (const guard of chain) {
        if (typeof guard !== 'function') return false;
        let passed = false;
        const headers = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' };
        const req = {
            user,
            isAuthenticated: () => true,
            headers,
            get: (h) => headers[String(h).toLowerCase()],
            xhr: true,
            method: 'GET',
            originalUrl: '/',
            url: '/',
            path: '/',
            query: {},
            body: {},
            session: {},
            flash() {},
        };
        try {
            const out = guard(req, stubResponse(), () => {
                passed = true;
            });
            // A refusal path may be async: swallow its promise.
            if (out && typeof out.catch === 'function') out.catch(() => {});
        } catch (_) {
            return false;
        }
        if (!passed) return false;
    }
    return true;
}

module.exports = { passesGuard };
