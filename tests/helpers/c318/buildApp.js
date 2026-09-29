'use strict';
/**
 * 3.23.18 lane T — build the REAL Express app, exactly as server.js wires it,
 * without booting the server.
 *
 * server.js has no app factory: requiring it calls startServer(), which
 * connects, runs migrations, SEEDS, starts the background jobs and listens on
 * :3000. So this helper compiles server.js's own source with four textual
 * neutralisations, each of which must match EXACTLY ONCE or the helper throws
 * (a server.js refactor then fails the suite loudly instead of silently
 * testing a different middleware chain):
 *
 *   1. the trailing `startServer();` call is removed   (no listen/migrate/seed/jobs)
 *   2. process.on('unhandledRejection', …) is not registered   (jest owns the process)
 *   3. process.on('uncaughtException', …)  is not registered   (it calls process.exit)
 *   4. relative `require('./…')` and `__dirname` point at the repo root
 *      (the compiled copy lives in node_modules/.cache/c318)
 *
 * Everything else — middleware order, helmet/CSP, body parsers, static,
 * health probes, session, passport, no-store, idle timeout, i18n, origin
 * guard, CSRF, res.locals, lockout/limiters, forced password change, MFA
 * gates, audit backstop, /api/v1 and the route tree, 404 + error handlers —
 * is server.js's own code, byte for byte.
 *
 * Documented divergences (set by the CALLER, see c318-T-route-matrix.test.js):
 *   - session store: MemoryStore instead of connect-pg-simple
 *     (tests/helpers/c318/sessionStoreMock.js) — no `session` rows written;
 *   - LogService.log / PerfEventService.record are no-ops and
 *     ACTIVITY_TRAIL=0 — the audit backstop still RUNS, it just does not
 *     append to the hash-chained system_logs of the test database;
 *   - API / write-action rate limits are raised so the matrix itself is not
 *     throttled;
 *   - the DB is connected by the caller (db.connect + searchSql.init), as
 *     startServer does, but migrate()/seed()/jobs are NOT run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function replaceOnce(src, needle, replacement, label) {
    const parts = src.split(needle);
    if (parts.length !== 2) {
        throw new Error(
            `c318 buildApp: expected exactly one "${label}" in server.js, found ${parts.length - 1}. ` +
                'server.js changed shape — update tests/helpers/c318/buildApp.js.'
        );
    }
    return parts.join(replacement);
}

function compiledServerPath() {
    let src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
    src = replaceOnce(
        src,
        '\nstartServer();\n',
        '\n/* c318: startServer() not called */\n',
        'startServer();'
    );
    src = replaceOnce(
        src,
        "process.on('unhandledRejection',",
        "[].push('unhandledRejection',",
        "process.on('unhandledRejection'"
    );
    src = replaceOnce(
        src,
        "process.on('uncaughtException',",
        "[].push('uncaughtException',",
        "process.on('uncaughtException'"
    );
    const rootLit = JSON.stringify(ROOT.replace(/\\/g, '/'));
    src = src.replace(/require\('\.\//g, `require(${rootLit} + '/`);
    src = src.replace(/\b__dirname\b/g, rootLit);
    const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
    // Under node_modules/.cache so bare requires ('express', 'dotenv') resolve
    // from the repo's node_modules, and nothing lint/git/prettier sees.
    const dir = path.join(ROOT, 'node_modules', '.cache', 'c318');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `server-app-${hash}.js`);
    if (!fs.existsSync(out)) fs.writeFileSync(out, src);
    return out;
}

/** Require the compiled app (inside the caller's jest module registry, so jest.mock applies). */
function loadApp() {
    // eslint-disable-next-line security/detect-non-literal-require
    return require(compiledServerPath());
}

/** express-session cookie for a session id (cookie-signature algorithm). */
function signedCookie(sid) {
    const appConfig = require(path.join(ROOT, 'src', 'config', 'app'));
    const secret = String(appConfig.sessionSecret)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)[0];
    const mac = crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
    const name = process.env.SESSION_COOKIE_NAME || 'app.sid';
    return `${name}=${encodeURIComponent('s:' + sid + '.' + mac)}`;
}

/**
 * Put an authenticated session for `principal` ({id, userType}) into the
 * MemoryStore and return the Cookie header value. The session carries a
 * fixed CSRF token (csrf-sync reads req.session.csrfToken) so write probes
 * can pass CSRF and reach the route's own authorisation.
 */
function mintSession(store, principal, csrfToken) {
    const sid = 'c318-' + crypto.randomBytes(12).toString('hex');
    const now = Date.now();
    const sess = {
        cookie: {
            originalMaxAge: 24 * 3600 * 1000,
            expires: new Date(now + 24 * 3600 * 1000).toISOString(),
            httpOnly: true,
            path: '/',
            sameSite: 'lax',
        },
        csrfToken,
        createdAt: now,
        lastActivity: now,
        meta: { ip: '127.0.0.1', ua: 'c318', loginAt: now },
    };
    // principal null → an ANONYMOUS session that still carries the CSRF token,
    // so an anonymous write reaches the route's auth gate instead of stopping
    // at CSRF.
    if (principal) {
        sess.passport = { user: { id: principal.id, userType: principal.userType } };
        // 3.23.20 (C2): a minted session models a COMPLETED sign-in, second factor
        // included — a SuperAdmin is otherwise held on MFA enrolment (always).
        sess.mfaVerifiedInSession = true;
    }
    return new Promise((resolve, reject) =>
        store.set(sid, sess, (err) => (err ? reject(err) : resolve(signedCookie(sid))))
    );
}

// ---------------------------------------------------------------- route walk

function mountPathOf(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    let s = layer.regexp.source;
    s = s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
    let k = 0;
    s = s.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => ':' + ((layer.keys[k++] || {}).name || 'p'));
    return s.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
}

/** Every [METHOD, path] registered on the app, recursively through sub-routers. */
function listRoutes(app) {
    const out = [];
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                const paths = Array.isArray(layer.route.path)
                    ? layer.route.path
                    : [layer.route.path];
                const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all');
                for (const p of paths) {
                    if (typeof p !== 'string') continue; // regex routes: none today
                    for (const m of methods)
                        out.push({
                            method: m.toUpperCase(),
                            path: (prefix + p).replace(/\/+/g, '/'),
                        });
                }
            } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                walk(layer.handle.stack, prefix + mountPathOf(layer));
            }
        }
    };
    walk(app._router.stack, '');
    const seen = new Set();
    return out.filter((r) => {
        const key = r.method + ' ' + r.path;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

module.exports = { ROOT, loadApp, mintSession, signedCookie, listRoutes, compiledServerPath };
