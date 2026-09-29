const { logger, safeUrl } = require('./logger');
const { safeBackUrl } = require('../utils/safeRedirect');
const { wantsJson } = require('../utils/wantsJson');
const appConfig = require('../config/app');

/**
 * Verbosity gate — the ONE place that decides whether a client sees the raw
 * error text and stack.
 *
 * It used to read `process.env.NODE_ENV` directly. That is a second, mutable
 * source of truth: `process.env` is writable at runtime (a test harness, a
 * library, a stray `process.env.NODE_ENV = 'test'`), and anything that clears or
 * mistypes it silently flips this file into verbose mode on a production
 * appliance — leaking stack traces and SQL text to whoever triggered the error.
 * `config/app.js` reads the environment ONCE at boot and is the app's own source
 * of truth everywhere else, so the gate is decoupled onto it.
 *
 * Defence in depth: the boot-time assertion below fails fast if that value is
 * not one of the recognised environments (a typo like NODE_ENV=prod would
 * otherwise be treated as "not production" = verbose).
 */
const KNOWN_ENVS = new Set(['production', 'staging', 'test', 'development']);
if (!KNOWN_ENVS.has(appConfig.env)) {
    throw new Error(
        `NODE_ENV is "${appConfig.env}" — expected one of ${[...KNOWN_ENVS].join(', ')}. ` +
            'An unrecognised environment would be treated as non-production and leak raw ' +
            'error text and stack traces to clients. Fix NODE_ENV before starting the app.'
    );
}
if (appConfig.env === 'production' && process.env.NODE_ENV !== 'production') {
    // The two disagreeing means something mutated process.env after boot. The
    // config value wins (it is the snapshot taken before any user code ran).
    logger.warn(
        'NODE_ENV was changed after boot; error verbosity stays keyed on the boot-time value (production).'
    );
}

/** True only for a real production appliance. Evaluated from the boot snapshot. */
function isProduction() {
    return appConfig.env === 'production';
}

const errorHandler = (err, req, res, next) => {
    // Skip logging 404s for static assets
    if (
        err.status === 404 &&
        (req.path.startsWith('/css/') ||
            req.path.startsWith('/js/') ||
            req.path.startsWith('/images/') ||
            req.path === '/favicon.ico')
    ) {
        return res.status(404).end();
    }

    // Log actual errors (with the request id so this stack can be joined to the
    // audit row + perf events for the same request during reconciliation).
    logger.error(`Error: ${err.message}`, {
        requestId: req.id || null,
        stack: err.stack,
        // Redact token/code/state etc. — an error while serving /reset-password?token=…
        // or an SSO ?code=… callback must not persist the live secret to error.log.
        url: safeUrl(req),
        method: req.method,
        status: err.status || 500,
        userId: req.user ? req.user.id : null,
    });

    // SERVER errors (5xx) also land in the DB audit so the System Logs "issues"
    // view and incident reconstruction see them without shell access to the
    // winston files. Client-fault 4xx stay file-only (volume). Best-effort.
    if ((err.status || 500) >= 500) {
        try {
            require('../services/LogService')
                .log({
                    action: 'SERVER_ERROR',
                    entityType: 'system',
                    details: `${req.method} ${safeUrl(req)} -> ${err.status || 500}: ${String(err.message).slice(0, 300)}`,
                    severity: 'error',
                    category: 'system',
                    requestId: req.id || null,
                    ipAddress: req.ip,
                    userAgent: req.get && req.get('user-agent'),
                    actorRef: req.user ? `${req.user.userType}:${req.user.id}` : null,
                })
                .catch(() => {});
        } catch (_) {
            /* the error handler must never throw */
        }
    }

    const status = err.status || 500;

    // Don't leak error details in production. `expose` marks an error whose text
    // was written FOR the user (e.g. "Identifiant invalide" from a route guard),
    // so it stays readable even on a production appliance.
    // French-first: the generic mask is the one string every production user sees.
    const message =
        isProduction() && !err.expose
            ? (typeof req.t === 'function' && req.t('chrome:error_message')) ||
              'Une erreur est survenue'
            : err.message;

    // API clients always get JSON — a Power BI / HTTP connector sending `Accept: */*`
    // must never receive a 302→HTML login page instead of a machine-readable error.
    //
    // This used to test only `req.xhr`, the path prefix and Accept. The app's
    // OWN page-level fetch matches none of them: fetch sends no
    // X-Requested-With, its default Accept is the wildcard, and these routes are
    // /v2/… not /api/…. So a 500 fell through to the HTML branch below, which
    // answers a 302; fetch follows a redirect automatically, received 200 and a
    // page, and the caller read `res.ok === true`. A server error reported as a
    // success. `wantsJson` additionally recognises a JSON request BODY, which
    // is what the app's own calls actually send — same rule as the middleware,
    // one definition, in utils/wantsJson.
    if (wantsJson(req) || req.path?.startsWith('/api/')) {
        return res.status(status).json({
            error: message,
            requestId: req.id || null,
            ...(!isProduction() && { stack: err.stack }),
        });
    }

    // CLIENT-FAULT (4xx) on an HTML route: a mis-typed URL or a bad identifier is
    // not something a redirect-with-a-toast explains. Render the same styled error
    // page the 404 handler uses, so `/employees/abc` looks like a product page and
    // not a naked JSON blob. 5xx keeps the flash + same-origin bounce (the user is
    // mid-workflow and the detail belongs in the logs, not on screen).
    if (status >= 400 && status < 500 && typeof res.render === 'function') {
        // The error handler must never throw, so every step here is guarded and
        // degrades to the historical flash + same-origin bounce.
        const fallback = () => {
            if (typeof req.flash === 'function') req.flash('error', message);
            return res.status(status).redirect(safeBackUrl(req));
        };
        try {
            // The page carries its own HTML shell. `layout:false` MUST be a render
            // option — express-ejs-layouts ignores a falsy res.locals.layout and would
            // wrap this in a second <html>/<body>.
            const T = (k, o) => (typeof req.t === 'function' ? req.t(k, o) : null);
            return res.render(
                'pages/error',
                {
                    layout: false,
                    title:
                        status === 404
                            ? T('chrome:error_404_title') || '404 — Page introuvable'
                            : T('chrome:error_status_title', { status }) || `${status} — Erreur`,
                    message,
                },
                (renderErr, html) => {
                    if (renderErr || !html) return fallback();
                    return res.status(status).send(html);
                }
            );
        } catch (_) {
            return fallback();
        }
    }

    // Guard: if the error happened around session/flash init, req.flash may be
    // undefined — don't let the error handler itself throw and mask the original.
    if (typeof req.flash === 'function') req.flash('error', message);
    // Same-origin only — never bounce to a raw (attacker-influenceable) Referer.
    res.status(status).redirect(safeBackUrl(req));
};

const notFoundHandler = (req, res) => {
    // Skip 404 logging for static assets
    if (
        req.path.startsWith('/css/') ||
        req.path.startsWith('/js/') ||
        req.path.startsWith('/images/') ||
        req.path === '/favicon.ico'
    ) {
        return res.status(404).end();
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(404).json({ error: 'Not found' });
    }
    // Disable layout for the error page (it has its own HTML shell). Must be a render
    // option, not res.locals — see the note in errorHandler above.
    const T = (k) => (typeof req.t === 'function' ? req.t(k) : null);
    res.status(404).render('pages/error', {
        layout: false,
        title: T('chrome:error_404_title') || '404 — Page introuvable',
        message: T('chrome:error_404_message') || "La page que vous recherchez n'existe pas.",
    });
};

module.exports = {
    errorHandler,
    notFoundHandler,
};
