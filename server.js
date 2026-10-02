// Load .env from this directory regardless of the launching process's cwd.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Don't let unhandled rejections from async handlers crash the process —
// the rejection must surface as a 500 to the client, not crash node.
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    // After an uncaught exception the process may hold corrupted state (half-released
    // DB clients, leaked locks). Log, then exit so the service supervisor restarts a
    // clean process. (unhandledRejection above is logged-only by design.)
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
    setTimeout(() => process.exit(1), 100);
});

const PRODUCT = require('./src/config/product');
const express = require('express');
const session = require('express-session');
const { buildSessionStore } = require('./src/config/sessionStore');
const { csrfSync } = require('csrf-sync');
const helmet = require('helmet');
const flash = require('express-flash');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const db = require('./src/config/database');
const { passport, requireAuth } = require('./src/middleware/auth');
const { requestLogger } = require('./src/middleware/logger');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const {
    loginRateLimiter,
    apiRateLimiter,
    checkAccountLockout,
} = require('./src/middleware/rateLimiter');
const routes = require('./src/routes/index');
const appConfig = require('./src/config/app');

const compression = require('compression');
const app = express();

// gzip/deflate every compressible response (HTML, CSS, JS, JSON). The app serves
// plain HTTP internally with no proxy doing this, so style.css (~75 KB) and
// dashboard.js (~82 KB) were going over the wire uncompressed — gzip cuts those
// ~75%, the single biggest reduction in page-open transfer time. Mounted first so
// it wraps both static assets and rendered pages.
app.use(compression());

// Cache-busting token for static assets: appended as ?v=<assetVersion> on every
// local <link>/<script> in the views (see layouts/main.ejs). Derived from the app
// version + a CONTENT hash of the main assets — stable across restarts AND across
// load-balanced instances of the same deploy (so a CDN/browser cache is shared and
// not invalidated by a restart), yet changes the moment an asset's content changes.
app.locals.assetVersion = (() => {
    try {
        const h = require('crypto').createHash('sha1').update(require('./package.json').version);
        for (const f of ['public/js/dashboard.js', 'public/css/style.css', 'public/js/help.js']) {
            try {
                h.update(fs.readFileSync(path.join(__dirname, f)));
            } catch (_) {
                /* file optional */
            }
        }
        return h.digest('hex').slice(0, 10);
    } catch (_) {
        return require('./package.json').version;
    }
})();

// Trust proxy: default OFF so a direct-exposed app can't be tricked by a spoofed
// X-Forwarded-For (which would defeat the IP rate-limiter). Enable it explicitly
// via TRUST_PROXY when behind a known reverse proxy (handled below).
app.set('trust proxy', false);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Middleware
// Per-request CSP nonce. Set BEFORE helmet so the script-src directive (a
// function) can read it. Every EJS-rendered inline <script> carries
// nonce="<%= cspNonce %>", which lets us drop 'unsafe-inline' from script-src —
// so an injected inline <script> (the main stored-XSS vector) will NOT execute.
const crypto = require('crypto');
app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

// Content-Security-Policy. script-src is nonce-based (no 'unsafe-inline') and
// script-src-attr is 'none': no inline event handler (onclick= …) may run. The
// views declare their controls as data-on-<event> attributes, dispatched by the
// delegated listeners in public/js/csp-actions.js (SA-14;
// tests/unit/noInlineHandlers.test.js keeps it that way). style-src still allows
// 'unsafe-inline' for inline style= attributes, a separate, lower-risk migration. Plugins/objects blocked, base-uri locked,
// anti-clickjacking frame-ancestors, restricted form-action. upgrade-insecure-
// requests is removed because the app is commonly served over plain HTTP internally.
// Data sovereignty (3.23.17): Font Awesome is self-hosted under /vendor, and
// Google Fonts are OPT-IN (ENABLE_EXTERNAL_FONTS=1). By default no user's browser
// calls a third party and offline sites render every icon; views fall back to the
// system font stack. DISABLE_EXTERNAL_FONTS=1 still wins as a kill switch.
const EXTERNAL_FONTS =
    process.env.ENABLE_EXTERNAL_FONTS === '1' && process.env.DISABLE_EXTERNAL_FONTS !== '1';
app.locals.externalFonts = EXTERNAL_FONTS;
// one order for a person's name, decided in src/utils/personName.js,
// available to every view so the EJS layer cannot re-invent its own spelling.
app.locals.personName = require('./src/utils/personName').personNameOf;
// 3.23.21: one resolver for « what a skill and its levels mean », shared by
// views/partials/skill-help.ejs and the browser (public/js/sa-skill-help.js).
app.locals.skillHelpCore = require('./src/utils/skillHelp');
const CDN_STYLE = EXTERNAL_FONTS ? ['https://fonts.googleapis.com'] : [];
const CDN_FONT = EXTERNAL_FONTS ? ['https://fonts.gstatic.com'] : [];
app.use(
    helmet({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                defaultSrc: ["'self'"],
                // Chart.js and Font Awesome are self-hosted under /vendor; Google
                // Fonts are allowed only when ENABLE_EXTERNAL_FONTS=1.
                scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
                // No inline event handler attribute runs (SA-14): see public/js/csp-actions.js.
                scriptSrcAttr: ["'none'"],
                styleSrc: ["'self'", "'unsafe-inline'", ...CDN_STYLE],
                fontSrc: ["'self'", ...CDN_FONT, 'data:'],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                frameAncestors: ["'self'"],
                formAction: ["'self'"],
                upgradeInsecureRequests: null,
            },
        },
        // HSTS is sent by tlsServer.hstsMiddleware below, on HTTPS responses only
        // (180 days) — helmet's default put a 1-year header on clear-HTTP answers too.
        strictTransportSecurity: false,
        // ASVS 14.4 — pinned explicitly rather than left to helmet's defaults, so a
        // library upgrade cannot silently relax them (tests/unit/asvsHeaders.test.js).
        crossOriginOpenerPolicy: { policy: 'same-origin' },
        crossOriginResourcePolicy: { policy: 'same-origin' },
        // `same-origin`, not `no-referrer`: nothing leaves for another site, but
        // under `no-referrer` the browser sends `Origin: null` on our OWN form
        // posts (Fetch standard), which kept the origin guard from refusing a
        // real `null`. /api and /scim keep `no-referrer` (securityHeaders below).
        referrerPolicy: { policy: 'same-origin' },
        xContentTypeOptions: true,
        hidePoweredBy: true,
    })
);
// No framework fingerprint (ASVS 14.3.3), even if helmet is ever removed.
app.disable('x-powered-by');
// Browser features the product never uses are denied to every page
// (Permissions-Policy), and the machine surfaces (/api, /scim) send no Referer.
// The list and the rules live in src/middleware/httpHardening.js (testable).
const httpHardening = require('./src/middleware/httpHardening');
app.use(httpHardening.securityHeaders);
// 3.23.18 (S-05): Strict-Transport-Security on every HTTPS response (the built-in
// TLS listener, or a TLS-terminating proxy when TRUST_PROXY makes req.secure true).
const tlsServer = require('./src/utils/tlsServer');
app.use(tlsServer.hstsMiddleware());

// Static standalone HTML docs (e.g. /user-guide.html) inline their own scripts
// and cannot carry a per-request nonce, so relax script-src to 'unsafe-inline'
// for those static files only. They are static documents, not app surfaces.
app.use((req, res, next) => {
    if (/\.html$/i.test(req.path)) {
        res.setHeader(
            'Content-Security-Policy',
            [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline'",
                "style-src 'self' 'unsafe-inline'",
                "font-src 'self' data:",
                "img-src 'self' data:",
                "object-src 'none'",
                "base-uri 'self'",
                "frame-ancestors 'self'",
            ].join('; ')
        );
    }
    next();
});
// Explicit body-size caps: bound memory per request so a large/hostile payload
// can't spike heap under concurrency. File imports go through multer (own 10MB cap),
// not these parsers. Tunable via env for the rare large JSON API client.
// The SSO-migration dry run carries a whole directory export: the global parser
// skips that one path and the route parses it itself (10 MB) AFTER
// requireSuperAdmin — so an anonymous caller can never make the server parse it.
// JSON media types: application/json AND the RFC 6839 structured suffix
// (application/scim+json is what Entra / Okta send to /scim/v2 — RFC 7644).
// The body parser, the origin guard and the CSRF skip must all agree on this,
// or a SCIM deprovisioning request is refused (403) or parsed as an empty body.
// The parser takes httpHardening.JSON_TYPES; the origin guard and the CSRF skip
// use httpHardening.isJsonType, anchored on the MIME essence, so
// `text/plain; x=application/json` is not JSON (the old unanchored regex said
// it was, and skipped the CSRF check).
const _JSON_TYPES = [...httpHardening.JSON_TYPES];
const _jsonParser = express.json({
    limit: process.env.JSON_BODY_LIMIT || '1mb',
    type: _JSON_TYPES,
});
app.use((req, res, next) =>
    req.path === '/admin/sso-migration/preview' ? next() : _jsonParser(req, res, next)
);
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb' }));
// JSON-only APIs answer 415 to a body that is not JSON (ASVS 13.1.5), before
// any session, CSRF or route logic runs on an empty req.body.
app.use(['/api/v1', '/scim/v2'], require('./src/middleware/jsonContentType').requireJsonBody);
// Static assets: in production cache for 7 days (cache-busted via ?v=assetVersion,
// so a deploy serves fresh files immediately and within-session navigations skip
// the per-asset revalidation round-trip). In dev, no cache so edits show live.
app.use(
    express.static(path.join(__dirname, 'public'), {
        maxAge: appConfig.env === 'production' ? '7d' : 0,
        etag: true,
        lastModified: true,
        setHeaders: (res, filePath) => {
            // HTML documents (user-guide.html…) are navigated to directly, so they
            // can't carry a ?v= cache-buster: always revalidate (etag → cheap 304s)
            // instead of serving a week-stale guide after a deploy.
            // service-worker.js likewise: browsers gate SW updates on its HTTP
            // freshness, so a 7d cache would pin clients to an old worker.
            if (/\.html$/i.test(filePath) || /[\\/]service-worker\.js$/.test(filePath)) {
                res.setHeader('Cache-Control', 'no-cache');
            }
        },
    })
);

// ---------------------------------------------------------------------------
// Health & readiness probes — mounted BEFORE session/CSRF so they never depend
// on the session store and always return clean JSON (no redirect). For load
// balancers, container orchestrators (k8s liveness/readiness), and the
// installer's post-deploy health check.
//   GET /health  | /healthz      -> liveness: the process is serving
//   GET /health/ready | /readyz  -> readiness: liveness + database reachable
// ---------------------------------------------------------------------------
const APP_START = Date.now();

// Lightweight request counters feeding the /metrics endpoint (dependency-free).
const _metrics = { httpTotal: 0, byStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } };
app.use((req, res, next) => {
    res.on('finish', () => {
        _metrics.httpTotal++;
        const c = Math.floor(res.statusCode / 100) + 'xx';
        if (_metrics.byStatusClass[c] !== undefined) _metrics.byStatusClass[c]++;
    });
    next();
});

// Prometheus-format metrics (no session). 3.23.17 (S-11): loopback-only, unless
// METRICS_TOKEN is set and presented as `Authorization: Bearer <token>`.
app.get('/metrics', require('./src/middleware/apiAuth').requireMetricsAccess, (req, res) => {
    const mu = process.memoryUsage();
    const out = [
        '# HELP app_process_uptime_seconds Process uptime in seconds',
        '# TYPE app_process_uptime_seconds gauge',
        `app_process_uptime_seconds ${Math.round((Date.now() - APP_START) / 1000)}`,
        '# HELP app_process_resident_memory_bytes Resident memory size',
        '# TYPE app_process_resident_memory_bytes gauge',
        `app_process_resident_memory_bytes ${mu.rss}`,
        '# HELP app_nodejs_heap_used_bytes V8 heap used',
        '# TYPE app_nodejs_heap_used_bytes gauge',
        `app_nodejs_heap_used_bytes ${mu.heapUsed}`,
        '# HELP app_http_requests_total Total HTTP requests served',
        '# TYPE app_http_requests_total counter',
        `app_http_requests_total ${_metrics.httpTotal}`,
        '# HELP app_http_responses_total HTTP responses by status class',
        '# TYPE app_http_responses_total counter',
    ];
    for (const [k, v] of Object.entries(_metrics.byStatusClass)) {
        out.push(`app_http_responses_total{status_class="${k}"} ${v}`);
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(out.join('\n') + '\n');
});

// Public probes answer the status only. Service name, uptime, timestamps and
// the database state go to the callers /metrics admits (loopback,
// METRICS_ALLOW_IPS, METRICS_TOKEN). The installer's post-deploy checks only
// read the HTTP status, so they are unaffected.
const _probeDetails = require('./src/middleware/apiAuth').metricsAccessAllowed;
app.get(
    ['/health', '/healthz'],
    httpHardening.healthHandler({
        startedAt: APP_START,
        detailsAllowed: _probeDetails,
        serviceName: PRODUCT.name,
    })
);
app.get(
    ['/health/ready', '/readyz'],
    httpHardening.readyHandler({ db, startedAt: APP_START, detailsAllowed: _probeDetails })
);

// Session configuration (driver-aware)
const { store: sessionStore, label: sessionStoreLabel } = buildSessionStore(session, appConfig);
console.log(`✓ Session store: ${sessionStoreLabel}`);

// Session cookie `secure` flag. Tying this to NODE_ENV=production breaks login
// when a production build is served over plain HTTP: the browser drops a Secure
// cookie on http://, so the user authenticates but is immediately bounced back
// to the login page. Decouple it:
//   COOKIE_SECURE=1/true  -> always Secure (use when this process terminates TLS)
//   COOKIE_SECURE=0/false -> never Secure  (plain-HTTP / internal LAN install)
//   unset (default)       -> 'auto': Secure only when the request is actually HTTPS
// 'auto' keeps the cookie hardened under HTTPS (incl. behind a TLS-terminating
// proxy when TRUST_PROXY is set) yet lets a plain-HTTP deployment log in.
if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp === '1' ? 1 : /^\d+$/.test(tp) ? parseInt(tp, 10) : tp);
}
const _cs = String(process.env.COOKIE_SECURE || '').toLowerCase();
const cookieSecure =
    _cs === '1' || _cs === 'true' ? true : _cs === '0' || _cs === 'false' ? false : 'auto';

// Boot guard: behind a TLS-terminating reverse proxy (the real prod topology),
// Express only sees req.secure===true if it trusts X-Forwarded-Proto, which needs
// `trust proxy` != false. If secure cookies are forced ON while trust proxy is OFF,
// req.secure is false for every request → express-session refuses to emit the
// cookie → EVERY user authenticates then bounces back to /login (site-wide loop).
// Fail loudly (fatal in production) rather than ship a silent login loop.
// Not applicable when this process terminates TLS itself (TLS_PFX_PATH): req.secure
// is then true on every app request, so a forced Secure cookie is always emitted.
if (
    cookieSecure === true &&
    app.get('trust proxy') === false &&
    !tlsServer.isTlsConfigured(process.env)
) {
    const msg =
        'COOKIE_SECURE is ON but TRUST_PROXY is not set. Behind a TLS-terminating proxy this drops the session cookie and causes a site-wide login loop. Set TRUST_PROXY=1 (or leave COOKIE_SECURE unset to use auto).';
    if ((process.env.NODE_ENV || 'development') === 'production') {
        throw new Error(msg);
    }
    console.warn('⚠️  ' + msg);
}

// Session signing key(s). A comma-separated SESSION_SECRET enables graceful key
// rotation: express-session signs with the FIRST key and still verifies cookies
// signed with any later key, so rotating a key doesn't log everyone out at once.
const _secretList = String(appConfig.sessionSecret)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const sessionSecret = _secretList.length > 1 ? _secretList : appConfig.sessionSecret;

// Neutral session cookie name — the express-session default ('connect.sid')
// fingerprints the stack to anyone enumerating the login page. Overridable.
// `__Host-app.sid` whenever the cookie is always Secure (COOKIE_SECURE on, or
// TLS terminated here); plain HTTP keeps `app.sid`. The bridge below carries an
// existing `app.sid` session over the rename once, so nobody is logged out by
// the upgrade.
const SESSION_COOKIE_NAME = httpHardening.sessionCookieName({
    env: process.env,
    cookieSecure,
    tlsConfigured: tlsServer.isTlsConfigured(process.env),
});
app.set('sessionCookieName', SESSION_COOKIE_NAME);
app.use(httpHardening.legacyCookieBridge(SESSION_COOKIE_NAME));
// The other readers of the name (AuthController logout, sessionActivity idle
// sign-out) compute this; their clearCookie is mapped onto the real cookie.
const READER_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'app.sid';
app.use(httpHardening.sessionCookieAlias(READER_COOKIE_NAME, SESSION_COOKIE_NAME));

app.use(
    session({
        store: sessionStore,
        name: SESSION_COOKIE_NAME,
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        // rolling: refresh the cookie's maxAge on each response so an ACTIVE user's
        // session slides forward, while the idle-timeout middleware (below) still
        // expires INACTIVE sessions. The ABSOLUTE ceiling is enforced separately in
        // sessionActivity (createdAt + SESSION_MAX_HOURS), since rolling alone would
        // let a continuously-used session live forever.
        rolling: true,
        cookie: {
            secure: cookieSecure,
            httpOnly: true,
            sameSite: 'lax', // CSRF hardening for cookie-based session
            // Absolute ceiling: 12 h by default (ASVS 3.3.2); the sessionTimeout App
            // Setting is enforced per request by sessionActivity.
            maxAge: Number(process.env.SESSION_MAX_HOURS || 12) * 60 * 60 * 1000,
        },
    })
);

// Flash messages
app.use(flash());

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

// SECURITY — never let a cache store a per-user, authenticated response. Every
// dynamic response here also carries the rolling `Set-Cookie` session id (session
// id). Without an explicit directive a shared cache (corporate/reverse proxy, CDN)
// or the browser's back/forward cache can STORE such a page and later REPLAY it — with
// its session cookie — to a DIFFERENT admin, which presents as "one admin's session
// mixing into another's". `no-store` forbids any cache from keeping the response.
// Static assets are served by express.static ABOVE this line, so their long-lived
// caching (with ?v= cache-busting) is unaffected.
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Idle-timeout: sign out a session that has been INACTIVE beyond the threshold
// (sensitive HR data). Absolute cap stays on the cookie maxAge above; this adds a
// sliding inactivity window. Configurable via SESSION_IDLE_MINUTES (default 30).
app.use(require('./src/middleware/sessionActivity'));

// Multi-provider SSO transport (gated by the master switch; no-ops when off).
// Registered after passport.session so the same strategy/serialize pipeline is
// reused. This initial pass is env-only (the DB isn't connected yet); startServer
// calls reloadSso after db.connect to apply the in-app (Settings) config.
// Failure to configure never blocks boot (local password auth still works).
try {
    require('./src/config/sso').configureSso(passport);
} catch (e) {
    console.warn('SSO configuration skipped:', e.message);
}

// i18n (Phase 6) — FR primary, EN fallback. Always on: it used to be switched
// on by V2_FEATURES=1 too, and without it every page that calls `__` failed to
// render (the optional modules are now settings, see ModuleService).
// IMPORTANT ordering fix: i18next inits asynchronously, but Express dispatches
// middleware in REGISTRATION order — anything `app.use`d after the routers never
// runs for router-handled pages. So we register a synchronous WRAPPER here
// (before the routers) that delegates to the real i18next handle once init
// completes; until then `__` is an identity fallback (keys pass through).
{
    let _i18nHandle = null;
    app.use((req, res, next) => {
        const finish = () => {
            res.locals.__ = req.t ? req.t.bind(req) : (k) => k;
            // Expose the active language to layouts so <html lang> is correct for
            // screen readers (a11y / WCAG 3.1.1), esp. on the bilingual FR content.
            res.locals.lang =
                String(req.language || req.headers['accept-language'] || 'fr')
                    .split(/[-,;]/)[0]
                    .toLowerCase() || 'fr';
            // Shared enum→label helper so server-rendered tables stop printing raw
            // English enum values on the French-first UI (mirrors public/js/enum-labels.js).
            const { enumLabel } = require('./src/utils/enumLabels');
            res.locals.enumLabel = (v) => enumLabel(v, res.locals.lang);
            // the colon separator is TYPOGRAPHY, not punctuation a
            // template owns: French puts a space before it, English does not.
            // Hard-coded as « <%= label %> : » in a dozen templates, it printed
            // the French spacing on the ENGLISH page (« Opens : », « Last
            // activity : »). ONE shared helper, beside `__` and `enumLabel`, so
            // no template can hold its own private constant again.
            res.locals.colon = require('./src/utils/colon').colon(req.t, res.locals.lang);
            next();
        };
        if (_i18nHandle) return _i18nHandle(req, res, finish);
        finish();
    });
    (async () => {
        try {
            const { init } = require('./src/config/i18n');
            const i18n = await init();
            if (i18n && i18n.handle) {
                _i18nHandle = i18n.handle;
                console.log('✓ i18n active (fr primary, en fallback)');
            } else {
                console.log('✓ i18n fallback active (key passthrough — i18next not installed)');
            }
        } catch (e) {
            console.warn('i18n init warning:', e.message);
        }
    })();
}

// Correlation id (before logging so every log line can carry it)
app.use(require('./src/middleware/requestId'));

// Request logging
app.use(requestLogger);

// Rate limiting for API routes
app.use('/api/', apiRateLimiter);

// --- CSRF defense-in-depth: same-origin check for state-changing requests ---
// csurf below is skipped for application/json (the SPA-style fetch POSTs the app
// makes), which would otherwise leave those routes CSRF-exempt. A browser always
// sends an `Origin` header on cross-origin fetch/XHR/POST, so rejecting unsafe
// methods whose Origin doesn't match the host blocks cross-site forgery without
// requiring every client to carry a token. Requests with no Origin (same-origin
// XHR that omits it, server-to-server API-key calls) fall through to the normal
// session/API-key auth + csurf.
// The guard lives in src/middleware/httpHardening.js (testable): Origin must
// match Host for every state-changing request that carries one; a JSON mutation
// with no usable Origin needs a credential that VALIDATES (never the mere
// presence of `?apiKey=` or a Bearer header); `Origin: null` never passes a
// mutation unless such a credential validates; IdP callbacks are exempt.
const _validatedApiCredential = httpHardening.makeValidatedApiCredential();
app.use(
    httpHardening.originGuard({
        trustProxy: () => app.get('trust proxy'),
        validatedCredential: _validatedApiCredential,
        // Security-audit helper — best-effort, never blocking.
        secLog: (req, action, details) => {
            try {
                require('./src/services/LogService')
                    .log({
                        action,
                        entityType: 'security',
                        details,
                        severity: 'warn',
                        category: 'security',
                        requestId: req.id || null,
                        ipAddress: req.ip,
                        userAgent: req.get('user-agent'),
                        actorRef: req.user ? `${req.user.userType}:${req.user.id}` : null,
                    })
                    .catch(() => {});
            } catch (_) {
                /* audit must never break the guard */
            }
        },
    })
);

// CSRF protection — session-based synchroniser token via `csrf-sync` (the maintained
// successor to the now-deprecated `csurf`; same session model as the old
// `csurf({cookie:false})`). The token is minted per session in the res.locals
// middleware below (`generateToken`) and read from `_csrf` (form), `x-csrf-token`
// (fetch/XHR) or, for a multipart request only, `?_csrf=` on the action: multer
// parses a multipart body after this check (httpHardening.csrfTokenFromRequest).
// Validation here runs only on state-changing methods.
const { generateToken: csrfGenerate, csrfSynchronisedProtection } = csrfSync({
    getTokenFromRequest: httpHardening.csrfTokenFromRequest,
});
app.set('csrfGenerate', csrfGenerate); // reused by the res.locals token minter
app.use((req, res, next) => {
    // Skip CSRF for API routes, JSON requests (same-origin-guarded above), login
    // POST and SSO callbacks (state/assertion-protected). No multipart upload is
    // exempt any more (audit SA-15): every upload presents the token in the
    // x-csrf-token header or, from a native form, as ?_csrf= on the action.
    if (httpHardening.csrfSkip(req)) return next();
    // csrfSynchronisedProtection is a no-op for safe methods (GET/HEAD/OPTIONS) and
    // rejects unsafe methods whose token doesn't match the session's. Any error it
    // yields is a CSRF failure → 403.
    csrfSynchronisedProtection(req, res, (err) => {
        if (err) {
            // Never the session id itself (a log reader could replay it): a
            // short hash is enough to correlate repeated failures.
            console.error('CSRF token validation failed:', httpHardening.csrfFailureLogFields(req));
            // Security incident trail: repeated CSRF failures = probe or a
            // broken client — either way it belongs in the audit, not just stderr.
            try {
                require('./src/services/LogService')
                    .log({
                        action: 'CSRF_REJECTED',
                        entityType: 'security',
                        details: `CSRF token validation failed on ${req.method} ${req.path}`,
                        severity: 'warn',
                        category: 'security',
                        requestId: req.id || null,
                        ipAddress: req.ip,
                        userAgent: req.get('user-agent'),
                        actorRef: req.user ? `${req.user.userType}:${req.user.id}` : null,
                    })
                    .catch(() => {});
            } catch (_) {
                /* audit best-effort */
            }
            return res.status(403).send('Invalid CSRF token');
        }
        next();
    });
});

// Make user and CSRF token available to all views
app.use(async (req, res, next) => {
    res.locals.user = req.user || null;
    // Mint (or reuse) the session's CSRF token so every rendered form / AJAX call
    // carries a valid token. generateToken returns the existing token when one is
    // already stored (overwrite=false), so it is stable across a session's requests.
    try {
        const gen = req.app.get('csrfGenerate');
        res.locals.csrfToken = gen && req.session ? gen(req) : '';
    } catch (error) {
        // If CSRF token generation fails, log but don't crash
        console.error('CSRF token generation error:', error);
        res.locals.csrfToken = '';
    }
    res.locals.currentPath = req.path;
    // Granular-permission helper for views: can('manage_roles') etc. Returns
    // true for SuperAdmins (implicit all), or for a local admin holding the
    // grant. Lets the sidebar reveal exactly the delegated areas.
    const RBACService = require('./src/services/RBACService');
    res.locals.can = (slug) => RBACService.hasPermission(req.user, slug);
    // Appliance entitlement status (cached 60s) — drives the over-seat/expired banner
    // for admins. Never blocks the request; a failure just hides the banner.
    if (req.user && req.user.userType === 'admin') {
        try {
            res.locals.entitlement = await require('./src/services/EntitlementService').status();
        } catch {
            res.locals.entitlement = null;
        }
    } else {
        res.locals.entitlement = null;
    }
    // Per-admin workspace-component visibility (dashboard tabs + sidebar sections).
    // wsVisible('tab:training') / wsVisible('nav:tools'): true unless a SuperAdmin
    // hid it for this admin, or the permission-aware default hides it. Non-admins
    // always get true (the feature is admin-only).
    const workspaceComponents = require('./src/config/workspaceComponents');
    res.locals.wsVisible = (key) => workspaceComponents.isVisible(key, req.user);
    // Optional modules (Administration → Modules): computed ONCE per request
    // from TTL-cached settings, so navigation only links to modules that are
    // switched on (their routes answer 404 otherwise) and a change applies on
    // the next request. V2_FEATURES=1 (legacy) forces every module on.
    {
        const ModuleService = require('./src/services/ModuleService');
        const _ms = await ModuleService.resolve();
        res.locals.appModules = _ms.modules;
        res.locals.adoptionStage = _ms.stage;
        res.locals.modulesLegacy = _ms.legacy;
    }
    // SQL console is an operator switch (SQL_CONSOLE_ENABLED=1): hide its menu entry
    // and its Data Management card when it is off (its routes answer 404 then).
    res.locals.sqlConsoleEnabled = require('./src/services/SqlConsoleService').isEnabled();
    res.locals.success = req.flash('success');
    res.locals.errors = req.flash('error');
    // Advisories: the action succeeded but the person should read something
    // (e.g. "this e-mail address is also used by …"). Neither a success nor an error.
    res.locals.warnings = req.flash('warning');
    // a refused form flashes its safe body under `draft:<form path>`
    // (utils/validators keepDraft); the form page repopulates from res.locals.draft.
    try {
        const raw = req.flash('draft:' + req.path);
        res.locals.draft = raw && raw.length ? JSON.parse(raw[raw.length - 1]) : null;
    } catch (_) {
        res.locals.draft = null;
    }
    // one date format per language and kind-aware enum labels
    // for every server-rendered view. `enumLabel(value)` keeps working; views may
    // also call `enumLabel('cycle_status', value)`.
    {
        const { fmtDate, fmtDateTime, fmtPeriodBound } = require('./src/utils/dateFormat');
        const { enumLabel, KINDS } = require('./src/utils/enumLabels');
        const lang = res.locals.lang || 'fr';
        res.locals.fmtDate = (d) => fmtDate(d, lang);
        res.locals.fmtDateTime = (d) => fmtDateTime(d, lang);
        // une BORNE DE CALENDRIER (colonne PG `date`,
        // échéance de campagne) se rend en UTC, sinon minuit UTC recule d'un jour.
        // Les vues qui écrivaient `new Date(x).toISOString.slice(0,10)` — le motif
        // que src/utils/dateFormat.js nomme lui-même « live defect » — passent par ici.
        res.locals.fmtPeriodBound = (d) => fmtPeriodBound(d);
        res.locals.enumLabel = (a, b) =>
            Object.prototype.hasOwnProperty.call(KINDS, a)
                ? enumLabel(a, b, req.t, lang)
                : enumLabel(a, lang);
    }
    // Local-content module: its flag comes from the same resolution as the
    // other modules (strict boolean parse — a '0' stored as a string is OFF).
    res.locals.featureLocalContent = Boolean(
        res.locals.appModules && res.locals.appModules.localContent
    );
    // AI companion (help panel « Assistant » tab) — default ON; only an explicit
    // off value hides it. Rendered pages only need it for signed-in users.
    res.locals.companionEnabled = true;
    if (req.user && !req.path.startsWith('/api/')) {
        try {
            res.locals.companionEnabled =
                await require('./src/services/CompanionService').isEnabled();
        } catch (_) {
            res.locals.companionEnabled = true;
        }
    }
    // White-label branding (name / logo / accent) for every rendered view —
    // micro-cached, falls back to the stock identity if settings are unavailable.
    try {
        res.locals.branding = await require('./src/utils/branding').getBranding();
    } catch (_) {
        res.locals.branding = require('./src/utils/branding').DEFAULTS;
    }
    // Resolved product name for i18n interpolation ({{brand}}). Several strings
    // (setup banner, licence notice, login <title>, reset email) used to hardcode
    // "IDevelop", so a white-labelled install showed TWO product names at once.
    res.locals.brandName = (res.locals.branding && res.locals.branding.appName) || PRODUCT.name;
    // "Getting started" pill in the sidebar: SuperAdmins only, page renders
    // only, until the required setup steps are done or the banner is dismissed.
    res.locals.setupProgress = null;
    if (
        req.method === 'GET' &&
        req.user &&
        req.user.userType === 'admin' &&
        req.user.role === 'superadmin' &&
        !req.path.startsWith('/api/')
    ) {
        try {
            const dismissed = await require('./src/models/AppSettingsModel').getValue(
                'setupDismissed',
                false
            );
            if (!dismissed) {
                const p = await require('./src/controllers/SetupController').getProgress();
                if (!p.complete) res.locals.setupProgress = p;
            }
        } catch (_) {
            /* the pill is best-effort */
        }
    }
    next();
});

// Account lockout check for login attempts
// Logout clears the browser's HTTP cache for this origin (shared workstations)
// and expires the session cookie actually in use (sessionCookieAlias above).
app.post('/logout', httpHardening.logoutHardening());

app.post('/login', checkAccountLockout);

// Login rate limiting
app.post('/login', loginRateLimiter);

// Force first-login password change (skipped for SSO sessions, 3.23.19 S3) —
// see src/middleware/forcePasswordChange.js.
app.use(require('./src/middleware/forcePasswordChange').forcePasswordChange);

// The privileged-MFA policy (every admin role, and managers who sign in with a
// password, with an upgrade grace period, FAILING CLOSED) is enforced by
// src/middleware/mfaEnforcement.js below. The inline gate that stood here
// (privileged roles only, no grace, failed OPEN on any error) was removed.

// ---------------------------------------------------------------------------
// Global security audit — a backstop that captures in system_logs:
//   • every 401/403 = access denied / authz threat pattern
//   • every 5xx = errors/issues
// Successful GETs and noise (assets, health/metrics, the log views themselves,
// and high-frequency analytics polling) are skipped. Best-effort, non-blocking.
// ---------------------------------------------------------------------------
const _LogService = require('./src/services/LogService');
const _PerfEventService = require('./src/services/PerfEventService');
const _SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 1500);
const _AUDIT_SKIP =
    /^\/(health|healthz|readyz|metrics|favicon|css|js|img|images|fonts|public|vendor|assets|robots\.txt)\b/i;
app.use((req, res, next) => {
    const _start = Date.now();
    res.on('finish', () => {
        try {
            const reqPath = req.path || '';
            if (_AUDIT_SKIP.test(reqPath)) return;
            if (reqPath.startsWith('/system-logs')) return; // never self-log the log views
            const m = req.method;
            const sc = res.statusCode;
            const latencyMs = Date.now() - _start;
            // Normalized, low-cardinality route (Express route pattern when available,
            // else the mount path) so aggregates group by endpoint, not by every id.
            const route =
                req.route && req.route.path ? (req.baseUrl || '') + req.route.path : reqPath;
            const denied = sc === 401 || sc === 403;
            const errored = sc >= 500;
            const slow = latencyMs >= _SLOW_REQUEST_MS;
            const u = req.user;
            const actorRef = u ? `${u.userType || 'user'}#${u.id}` : 'anonymous';

            // A slow request is worth a perf_event even if it succeeded — that's a
            // "condition driving a performance issue" a reviewer needs to see.
            if (slow) {
                _PerfEventService.record({
                    requestId: req.id,
                    kind: 'slow_request',
                    route,
                    latencyMs,
                    statusCode: sc,
                });
            }
            // The evidentiary system_logs keep security events (401/403) and
            // server errors only. A successful mutation is NOT written here (it
            // put every POST, with IP and user agent, into a hash-chained table
            // kept forever): authenticated mutations go to perf_events (bounded
            // trail, middleware/activityTrail) and business events are audited
            // by their own controllers.
            if (httpHardening.requestAuditSink(sc) !== 'system') return;
            const severity = errored ? 'error' : 'warn';
            const category = denied ? 'security' : 'http';
            const action = denied
                ? sc === 401
                    ? 'ACCESS_UNAUTHENTICATED'
                    : 'ACCESS_DENIED'
                : 'REQUEST_ERROR';
            _LogService.log({
                adminId: u && u.userType === 'admin' ? u.id : null,
                action,
                entityType: 'http',
                details: `${m} ${reqPath} → ${sc} [${actorRef}] ${latencyMs}ms`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
                requestId: req.id,
                severity,
                category,
                httpMethod: m,
                route,
                statusCode: sc,
                latencyMs,
                actorRef,
            });
        } catch (_) {
            /* auditing must never break the response */
        }
    });
    next();
});

// Policy enforcement: every admin role (`mfaRequiredForPrivileged`) and every
// manager signed in with a password (`mfaRequiredForManagers`) with no confirmed
// MFA is forced to the setup screen before any other page, after the upgrade
// grace period (migration 162). Mounted after auth/session + flash and before
// the app routes. Fails CLOSED.
const { enforceMfaEnrollment } = require('./src/middleware/mfaEnforcement');
app.use(enforceMfaEnrollment);

// Per-USER auth policy (migration 55): an account whose auth_policy is
// 'mfa_required' is forced to MFA setup regardless of role. Fails CLOSED.
const { enforceUserAuthPolicy } = require('./src/middleware/authPolicy');
app.use(enforceUserAuthPolicy);

// Privacy notice (GDPR art. 13/14): once a SuperAdmin has published a version,
// every signed-in person acknowledges it before using the app. Inactive until
// then; fails closed on a read error.
app.use(require('./src/middleware/privacyNotice').privacyNotice);

// Catch-all activity trail: every authenticated MUTATION gets a coarse DB
// audit row (method/path/status/duration, joined by requestId to the file
// logs and the detailed per-action audit). Reads stay in the winston files.
const { enforceActivityTrail } = require('./src/middleware/activityTrail');
app.use(enforceActivityTrail);

// Routes
// IDevelop — Wave 1 versioned JSON API (additive, non-breaking).
app.use('/api/v1', require('./src/api/v1'));

app.use('/', routes);

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// ST-1 (3.23.21): openid-client@6 / jose@6 (Entra SSO) are ES modules loaded with
// require(esm), unflagged only from Node 20.19 and 22.12 (so 21.x and 22.0-22.11
// cannot load them either). Returns the boot warning, or null when the runtime is
// fine or no Entra provider is configured (AZURE_* in .env or the SSO settings).
function nodeTooOldForEntraWarning(nodeVersion, cfg) {
    const m = /^v?(\d+)\.(\d+)/.exec(String(nodeVersion || ''));
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;
    if (ok) return null;
    const c = cfg || {};
    const has = (k) => String(c[k] || '').trim() !== '';
    if (!has('AZURE_CLIENT_ID') && !has('AZURE_TENANT_ID') && !has('AZURE_API_CLIENT_ID'))
        return null;
    return (
        `⚠️  Node ${nodeVersion} cannot load the Entra SSO libraries (openid-client/jose need ` +
        'Node >= 20.19 or >= 22.12): Entra sign-in and Entra API bearer tokens will NOT work. ' +
        'Upgrade Node.js (the installer ships Node 22 LTS).'
    );
}

// Initialize database and start server
async function startServer() {
    try {
        // Production refuses to start without a strong APP_KEY: secrets at rest
        // are never silently stored in clear text, and SESSION_SECRET is never
        // an encryption key there (development is unaffected).
        require('./src/utils/secretBox').assertConfigured();

        console.log('Initializing database...');
        await db.connect();
        console.log('✓ Database connected');

        console.log('Running database migrations...');
        await db.migrate();
        console.log('✓ Database migrations completed');

        // Accent-insensitive search (f_unaccent from migration 46, if present).
        const searchSql = require('./src/utils/searchSql');
        const unaccentOn = await searchSql.init(db);
        console.log(
            unaccentOn
                ? '✓ Accent-insensitive search enabled (unaccent)'
                : '• unaccent not available — search is accent-sensitive'
        );

        console.log('Seeding default data...');
        await db.seed();
        console.log('✓ Database seeding completed');

        // Snapshots taken before secrets were masked may still hold them: scrub
        // once per boot, best-effort (never blocks start-up; idempotent).
        require('./src/services/SnapshotService')
            .scrubSecretsFromStoredSnapshots()
            .catch(() => {});

        // Optional modules: an install started with the legacy V2_FEATURES=1 and
        // no recorded adoption stage is recorded at stage 3 (everything on), so
        // removing the variable later takes nothing away. A fresh install records
        // nothing and reads as stage 1 until a SuperAdmin chooses on /admin/modules.
        try {
            if (await require('./src/services/ModuleService').ensureLegacyStage()) {
                console.log('✓ V2_FEATURES=1 found: adoption stage recorded as 3 (all modules on)');
            }
        } catch (e) {
            console.warn('Adoption stage upgrade skipped:', e.message);
        }

        // Re-register SSO strategies from the merged DB(Settings)+env config now
        // that the database is up, so providers configured in the in-app Settings
        // page are honoured (the earlier env-only pass ran before db.connect).
        try {
            await require('./src/config/sso').reloadSso(passport);
        } catch (e) {
            console.warn('SSO reload skipped:', e.message);
        }
        // ST-1 (3.23.21): Entra SSO needs require(esm) (Node >= 20.19 / 22.12).
        try {
            let ssoOv = {};
            try {
                ssoOv = await require('./src/services/SsoSettingsService').getOverrides();
            } catch (_e) {
                ssoOv = {};
            }
            const nodeWarn = nodeTooOldForEntraWarning(process.version, {
                ...process.env,
                ...ssoOv,
            });
            if (nodeWarn) console.warn(nodeWarn);
        } catch (_e) {
            /* a boot warning never blocks boot */
        }

        // Boot background jobs (dispute escalation, LMS sync, notification
        // release, priority index). Uses BullMQ when REDIS_URL is set, else an
        // in-process scheduler — without this these time-based workflows never ran.
        try {
            require('./src/jobs').start();
        } catch (e) {
            console.warn('Background jobs not started:', e.message);
        }

        // Security hygiene: warn (loudly in production) about default secrets.
        try {
            const bcryptCheck = require('bcrypt');
            const warnings = [];
            const secret = appConfig.sessionSecret || '';
            if (!secret || /change|secret-key|2024|default/i.test(secret)) {
                warnings.push('SESSION_SECRET looks like a default — set a long random value.');
            }
            const appKey = process.env.APP_KEY || '';
            if (
                !appKey ||
                appKey.length < 32 ||
                /change|default|dev|rotate|please|example|sample/i.test(appKey)
            ) {
                // Non-fatal: hot-swapping APP_KEY would orphan encrypted MFA/LMS
                // secrets, so rotate with the guided tool (re-encrypts first):
                //   NEW_APP_KEY='<strong>' node scripts/rotate-app-key.js --commit
                warnings.push(
                    'APP_KEY looks weak/default — rotate it with: NEW_APP_KEY=<strong> node scripts/rotate-app-key.js --commit (then set it in .env). Do NOT change APP_KEY without this tool.'
                );
            }
            if (appConfig.apiKeyRefused) warnings.push(appConfig.apiKeyRefused);
            const admin = await db.get('SELECT password_hash FROM admins WHERE username = ?', [
                'admin',
            ]);
            if (
                admin &&
                admin.passwordHash &&
                (await bcryptCheck.compare('admin123', admin.passwordHash))
            ) {
                warnings.push(
                    "Default super-admin password 'admin123' is still in use — change it now."
                );
            }
            if (warnings.length) {
                const prod = appConfig.env === 'production';
                console.log('');
                console.log(
                    `${prod ? '🛑 SECURITY (production)' : '⚠️  SECURITY'} — review before exposing this app:`
                );
                warnings.forEach((w) => console.log(`   - ${w}`));
                console.log('');
            }
        } catch (_) {
            /* never block startup on the hygiene check */
        }

        // The PostgreSQL schema (tables, the `category` column, and the
        // readiness/gaps views) is fully managed by db/postgres/*.sql, applied
        // via db.migrate above — no per-boot SQLite-era patching needed.

        const port = appConfig.port;
        const https = require('https');
        const http = require('http');

        // Check for SSL certificates
        const certDir = path.join(__dirname, 'certs');
        const keyPath = path.join(certDir, 'key.pem');
        const certPath = path.join(certDir, 'cert.pem');

        const pfxPath = path.join(certDir, 'server.pfx');
        let sslOptions = null;

        // minVersion is declared on the options themselves (rather than patched on
        // afterwards) so the floor is visible both to an auditor reading this block
        // and to static analysis. Node already defaults to TLS 1.2, but stating it
        // means the posture survives a future runtime default change — this ships
        // as an on-prem appliance whose operators get asked for exactly this.
        if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
            console.log('Using PEM certificates');
            sslOptions = {
                key: fs.readFileSync(keyPath),
                cert: fs.readFileSync(certPath),
                minVersion: 'TLSv1.2',
            };
        } else if (fs.existsSync(pfxPath)) {
            console.log('Using PFX certificate');
            sslOptions = {
                pfx: fs.readFileSync(pfxPath),
                passphrase: process.env.SSL_PASSPHRASE || '', // set SSL_PASSPHRASE in .env
                minVersion: 'TLSv1.2',
            };
        }

        let httpServer;
        let redirectServer = null;
        if (tlsServer.isTlsConfigured(process.env)) {
            // 3.23.18 (S-05): installer-managed certificate. HTTPS on HTTPS_PORT, the
            // HTTP port only redirects. resolveTlsOptions throws on an unreadable PFX
            // or a wrong passphrase — never a silent fallback to clear HTTP.
            const tlsOptions = tlsServer.resolveTlsOptions(process.env);
            const started = await tlsServer.startListeners(app, {
                port,
                env: process.env,
                tlsOptions,
            });
            httpServer = started.server;
            redirectServer = started.redirectServer;
            console.log('');
            console.log('========================================');
            console.log(`  ${PRODUCT.fullName} started (HTTPS)`);
            console.log('========================================');
            console.log(`  Server: https://localhost:${started.httpsPort}`);
            console.log(`  HTTP port ${port} redirects to HTTPS (HSTS enabled).`);
            console.log(`  Environment: ${appConfig.env}`);
            console.log('========================================');
            console.log('');
        } else if (sslOptions) {
            // Using sslOptions instead of local options variable

            httpServer = https.createServer(sslOptions, app).listen(port, () => {
                console.log('');
                console.log('========================================');
                console.log(`  ${PRODUCT.fullName} started (HTTPS)`);
                console.log('========================================');
                console.log(`  Server: https://localhost:${port}`);
                console.log(`  Environment: ${appConfig.env}`);
                console.log('');
                console.log('  First-run: a default SuperAdmin "admin" exists and is FORCED to');
                console.log('  set a new password on first sign-in. Do not expose this instance');
                console.log('  publicly until that first-login password change is complete.');
                console.log('========================================');
                console.log('');
            });

            // Optional: Redirect HTTP to HTTPS on a different port (e.g., 80 or 3001)
            // http.createServer((req, res) => {
            //     res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
            //     res.end;
            // }).listen(80);
        } else {
            // Fallback to HTTP
            httpServer = app.listen(port, () => {
                console.log('');
                console.log('========================================');
                console.log(`  ${PRODUCT.fullName} started (HTTP)`);
                console.log('========================================');
                console.log(`  Server: http://localhost:${port}`);
                console.log(
                    '  ⚠️  WARNING: Running in HTTP mode. For HTTPS, generate certificates in certs/ folder.'
                );
                console.log(`  Environment: ${appConfig.env}`);
                console.log('');
                console.log('  First-run: a default SuperAdmin "admin" exists and is FORCED to');
                console.log('  set a new password on first sign-in. Do not expose this instance');
                console.log('  publicly until that first-login password change is complete.');
                console.log('========================================');
                console.log('');
            });
        }

        // Graceful shutdown: stop accepting connections, drain, close the DB pool,
        // then exit so the service supervisor can restart cleanly (no abandoned
        // PG connections or severed in-flight requests).
        let shuttingDown = false;
        const shutdown = (signal) => {
            if (shuttingDown) return;
            shuttingDown = true;
            console.log(`\n[${signal}] shutting down gracefully…`);
            const force = setTimeout(() => {
                console.error('Forced exit after 10s');
                process.exit(1);
            }, 10000);
            const done = () => {
                clearTimeout(force);
                // Stop background jobs (clear timers, close BullMQ workers) BEFORE
                // the pool so no tick fires against a closing connection.
                Promise.resolve()
                    .then(() => {
                        try {
                            return require('./src/jobs').stop();
                        } catch (_) {
                            return null;
                        }
                    })
                    .then(() => db.close().catch(() => {}))
                    .finally(() => process.exit(0));
            };
            if (redirectServer) {
                try {
                    redirectServer.close();
                } catch (_) {
                    /* noop */
                }
            }
            if (httpServer) {
                httpServer.close(done);
            } else {
                done();
            }
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (error) {
        console.error('✗ Failed to start server:', error);
        console.error(error.stack);
        process.exit(1);
    }
}

startServer();

module.exports = app;
