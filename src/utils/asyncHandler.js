'use strict';

/**
 *   asyncHandler(fn) — wraps an async Express route handler so its
 *   rejected promises are forwarded to next(err) instead of becoming
 *   unhandledRejection (which crashes Node 24+).
 *
 *   Usage:
 *     router.get('/x', asyncHandler(async (req, res) => { ... }));
 */

/**
 * A DOMAIN refusal: the service wrote the error FOR the caller. IDPService,
 * MaintenanceService and DisputeServiceV2 all throw the same shape — a 4xx
 * `status` plus `expose` / `userMessage` / `code`. Anything else (a driver
 * error, a TypeError, an unclassified throw) is a genuine 500 and keeps the
 * historical path below untouched.
 */
function domainRefusal(err) {
    if (!err) return false;
    const status = Number(err.status);
    if (!Number.isInteger(status) || status < 400 || status > 499) return false;
    return Boolean(err.expose || err.userMessage || err.code);
}

module.exports = function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        Promise.resolve(fn(req, res, next)).catch((err) => {
            // If the response was a render that already errored, fall through
            // to the global errorHandler; for AJAX clients, return JSON.
            if (res.headersSent) return next(err);

            // A clean 4xx the service meant the user to see (409 IDP_NOT_DRAFT,
            // 403 IDP_SIGNER_MISMATCH, …). Before this branch existed the
            // status was ignored and an HTML form POST — /v2/idp/:id/sign on a
            // plan already active — rendered a 500 error page for a refusal
            // the user could act on. JSON/XHR callers get the status with a
            // machine-readable code; HTML callers get the message as a flash
            // and land back where they were (same-origin only), mirroring the
            // global errorHandler's 4xx fallback.
            if (domainRefusal(err)) {
                const status = Number(err.status);
                const message = err.userMessage || err.message || 'Request refused';
                const { wantsJson } = require('../middleware/auth');
                if (wantsJson(req)) {
                    return res
                        .status(status)
                        .json({ ok: false, error: message, code: err.code || null });
                }
                const { safeBackUrl } = require('./safeRedirect');
                if (typeof req.flash === 'function') req.flash('error', message);
                return res.redirect(safeBackUrl(req));
            }

            console.error(`[v2-route-error] ${req.method} ${req.path}:`, err && err.message);
            // PG SQLSTATE classes 22 (invalid input, e.g. bad enum value) and
            // 23 (constraint violation) are caused by the client's payload —
            // report them as 400, not 500.
            const code = String((err && err.code) || '');
            const clientFault = code.startsWith('22') || code.startsWith('23');
            const status = clientFault ? 400 : 500;
            if (
                req.xhr ||
                (req.headers.accept || '').indexOf('json') > -1 ||
                (req.headers['content-type'] || '').indexOf('json') > -1
            ) {
                return res.status(status).json({ error: err.message || 'internal error' });
            }
            // V1 templates live under views/pages/. Use 'pages/error' (the
            // path the V1 notFoundHandler uses) — plain 'error' resolves
            // to views/error.ejs which doesn't exist.
            res.status(status).render('pages/error', {
                message: err.message || 'Internal error',
                title: 'Error',
            });
        });
    };
};
