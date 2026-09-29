'use strict';

/**
 * Does this caller want JSON rather than a page?
 *
 * ONE definition, because the answer decides whether a failure is reported or
 * silently swallowed, and two spellings of it drift. It lives in a util with no
 * dependencies so `middleware/errorHandler` — which must never throw and must
 * not drag passport and every model in behind it — can use the same rule as
 * `middleware/auth`.
 *
 * The three signals, and why each is needed:
 *
 *   req.xhr                 jQuery-era XHR sets X-Requested-With. `fetch` does
 *                           NOT, which is exactly why this cannot be the only
 *                           test.
 *   Accept: …json           an explicit ask. `fetch`'s default Accept is
 *                           `*\/*`, so plenty of the app's own calls never
 *                           set it.
 *   Content-Type: …json     the app's own fetch calls POST a JSON body. This
 *                           is what catches them, and it is the signal the
 *                           error handler was missing: a page-level
 *                           `fetch('/v2/…', { method:'POST', headers:{
 *                           'Content-Type':'application/json' } })` hitting a
 *                           500 fell through to the HTML branch, got a 302,
 *                           followed it automatically, received 200 + a page,
 *                           and reported `res.ok === true`. A server error read
 *                           as a success.
 */
function wantsJson(req) {
    if (!req) return false;
    return (
        Boolean(req.xhr) ||
        String((req.headers && req.headers.accept) || '').indexOf('json') > -1 ||
        String((req.headers && req.headers['content-type']) || '').includes('application/json')
    );
}

module.exports = { wantsJson };
