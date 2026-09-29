'use strict';

/**
 * HTTPS listener for the appliance (3.23.18, S-05).
 *
 * WHY: the product listened in clear HTTP on :3000 — session cookies, passwords
 * and every HR screen crossed the LAN unencrypted. The installer can now issue
 * (or reuse) a certificate, export it as a PFX under %ProgramData%\IDevelop\tls
 * and write TLS_PFX_PATH / TLS_PFX_PASSPHRASE / HTTPS_PORT into .env. When
 * TLS_PFX_PATH is set this module:
 *   - serves the app over HTTPS on HTTPS_PORT (default 3443, TLS >= 1.2);
 *   - keeps the historic HTTP port open ONLY to redirect to HTTPS (301 for
 *     GET/HEAD, 308 otherwise so a POSTed form is not silently turned into a GET);
 *   - lets server.js send HSTS on HTTPS responses (hstsMiddleware).
 * It FAILS CLOSED: a TLS_PFX_PATH that cannot be read or parsed throws at boot
 * instead of silently falling back to clear HTTP.
 *
 * server.js and tests/unit/c317-O-ops2-https.test.js use this same code path.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');

const HSTS_MAX_AGE = 15552000; // 180 days
const DEFAULT_HTTPS_PORT = 3443;

/** True when the process terminates TLS itself (TLS_PFX_PATH configured). */
function isTlsConfigured(env = process.env) {
    return !!String(env.TLS_PFX_PATH || '').trim();
}

function httpsPortOf(env = process.env) {
    const raw = String(env.HTTPS_PORT == null ? '' : env.HTTPS_PORT).trim();
    const n = Number(raw);
    // 0 = ephemeral (tests only); blank / junk = the default.
    return raw !== '' && Number.isInteger(n) && n >= 0 && n < 65536 ? n : DEFAULT_HTTPS_PORT;
}

/**
 * TLS options from the environment, or null when TLS_PFX_PATH is not set.
 * Throws (fail closed) when it is set but unusable.
 */
function resolveTlsOptions(env = process.env, fsImpl = fs) {
    if (!isTlsConfigured(env)) return null;
    const pfxPath = String(env.TLS_PFX_PATH).trim();
    let pfx;
    try {
        pfx = fsImpl.readFileSync(pfxPath);
    } catch (e) {
        throw new Error(
            `TLS_PFX_PATH is set but the certificate cannot be read (${pfxPath}): ${e.message}`
        );
    }
    const opts = { pfx, passphrase: env.TLS_PFX_PASSPHRASE || '', minVersion: 'TLSv1.2' };
    try {
        // Parse now so a wrong passphrase stops the boot here, not on the first handshake.
        require('tls').createSecureContext(opts);
    } catch (e) {
        throw new Error(
            `TLS_PFX_PATH certificate could not be loaded (wrong TLS_PFX_PASSPHRASE?): ${e.message}`
        );
    }
    return opts;
}

/** Strict-Transport-Security on HTTPS responses only (browsers ignore it on HTTP anyway). */
function hstsMiddleware(maxAge = HSTS_MAX_AGE) {
    return (req, res, next) => {
        if (req.secure) res.setHeader('Strict-Transport-Security', `max-age=${maxAge}`);
        next();
    };
}

/**
 * Where the plain-HTTP listener sends people. The target host comes from
 * APP_BASE_URL when it is an https:// URL (the installer writes one); otherwise
 * from the request's Host header, reduced to a bare hostname — never a path, a
 * user-info part or a second port.
 */
function redirectTarget(req, { httpsPort, baseUrl }) {
    let origin = null;
    if (baseUrl && /^https:\/\//i.test(baseUrl)) {
        try {
            origin = new URL(baseUrl).origin;
        } catch (_) {
            origin = null;
        }
    }
    if (!origin) {
        const rawHost = String(req.headers.host || '').trim();
        const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.exec(rawHost);
        const hostname = m ? m[1] : 'localhost';
        origin = `https://${hostname}${httpsPort === 443 ? '' : ':' + httpsPort}`;
    }
    const url = String(req.url || '/');
    return origin + (url.startsWith('/') ? url : '/' + url);
}

function redirectApp({ httpsPort, baseUrl }) {
    return (req, res) => {
        const code = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
        res.writeHead(code, {
            Location: redirectTarget(req, { httpsPort, baseUrl }),
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end('HTTPS required\n');
    };
}

/**
 * Start the listeners. With TLS configured: HTTPS on HTTPS_PORT + an HTTP
 * redirector on `port`. Without: the plain app on `port` (unchanged behaviour).
 * `host` is optional (tests bind 127.0.0.1).
 * Resolves { mode, server, redirectServer, httpsPort }.
 */
function startListeners(app, { port, env = process.env, host, tlsOptions } = {}) {
    const opts = tlsOptions !== undefined ? tlsOptions : resolveTlsOptions(env);
    const listen = (srv, p) =>
        new Promise((resolve, reject) => {
            srv.once('error', reject);
            const cb = () => {
                srv.removeListener('error', reject);
                resolve(srv);
            };
            if (host) srv.listen(p, host, cb);
            else srv.listen(p, cb);
        });
    if (!opts) {
        return listen(http.createServer(app), port).then((server) => ({
            mode: 'http',
            server,
            redirectServer: null,
            httpsPort: null,
        }));
    }
    const httpsPort = httpsPortOf(env);
    return listen(https.createServer(opts, app), httpsPort).then((server) => {
        const actualHttps = server.address().port;
        const redirector = http.createServer(
            redirectApp({ httpsPort: actualHttps, baseUrl: env.APP_BASE_URL })
        );
        return listen(redirector, port).then((redirectServer) => ({
            mode: 'https',
            server,
            redirectServer,
            httpsPort: actualHttps,
        }));
    });
}

module.exports = {
    HSTS_MAX_AGE,
    DEFAULT_HTTPS_PORT,
    isTlsConfigured,
    httpsPortOf,
    resolveTlsOptions,
    hstsMiddleware,
    redirectTarget,
    redirectApp,
    startListeners,
};
