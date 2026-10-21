'use strict';
/**
 * Every QUERY / FILTER parameter, on every GET route, over the REAL app
 * (tests/helpers/c318/buildApp.js: server.js's own middleware chain) against a
 * test database, with sessions minted into a MemoryStore and each request
 * inside a transaction that is always rolled back (nothing persists).
 *
 * The parameter list is COMPUTED from the code at test time, so a new filter
 * joins the matrix by itself:
 *   - every key read from req.query in src/ (req.query.x, req.query['x'],
 *     `const { a, b } = req.query`, `const q = req.query; q.x`);
 *   - every field of a GET <form> and every `?key=` / `&key=` in views/.
 *
 * For each GET route and persona (SuperAdmin, manager, employee) one request
 * carries EVERY key set to a harmless marker; a route that refuses that batch
 * (400 / 422) is asked again with the keys in small groups, so an early
 * refusal cannot hide what a later key does. Then:
 *   - never a 5xx;
 *   - an HTML answer never contains the marker's raw tag (escaped or absent);
 *     JSON that echoes it is served as application/json;
 *   - a redirect never carries the raw marker in Location, and the page a
 *     same-origin redirect lands on obeys the same rules.
 * Skipped unless DATABASE_URL names a test database (tests/helpers/testDatabase).
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
process.env.PREAUTH_RATE_LIMIT = '100000000';
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000';
// Every staged module on (talent, 360-degree feedback, one-to-one, coaching,
// IDP, LMS, continuity…), so their pages are in the matrix instead of a 404.
process.env.V2_FEATURES = '1';
process.env.SQL_CONSOLE_BACKUP_DIR = require('path').join(
    require('os').tmpdir(),
    'query-matrix-sql-restore-points'
);
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});
// The local-content module has its own switch (off by default): on for the matrix.
jest.mock('../../src/controllers/LocalContentController', () => {
    const real = jest.requireActual('../../src/controllers/LocalContentController');
    real._enabled = async () => true;
    return real;
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, i18nReady, listRoutes, mintSession } = require('../helpers/c318/buildApp');
const storeState = require('../helpers/c318/sessionStoreMock').state;
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const ROOT = path.join(__dirname, '..', '..');
const CSRF = 'query-matrix-csrf';
const ROLLBACK = Symbol('query-matrix-rollback');
const MARK = '<i data-qpm>m</i>&"\'';
const RAW_TAG = '<i data-qpm>';
const REPORT = process.env.QPM_REPORT || null; // optional JSON dump for triage
const ONLY_RE = process.env.QPM_ONLY ? new RegExp(process.env.QPM_ONLY) : null;
const GROUP = 12; // keys per request when a route refused the full batch

/**
 * Routes not fired: identity-provider and LTI transports (they redirect to a
 * third party or check a signed assertion), sign-out, probes, and the reads
 * that start an external process or a network call (a rolled-back transaction
 * cannot undo those). Everything else is in the matrix.
 */
const NOT_FIRED =
    /^\/(auth\/sso|saml|lti|\.well-known|logout|metrics|health|healthz|readyz)(\/|$)|\/(sync|test|test-email|test-copilot|sql-console|restore|snapshots|stream|events)(\/|$)/;

/** Keys that drive authentication or transport, not a page filter. */
const KEYS_NOT_SENT = new Set([
    'apiKey',
    'api_key',
    '_csrf',
    'token',
    'nonce',
    'RelayState',
    'redirect_uri',
    'lti_message_hint',
    'stream', // a server-sent-events switch: the answer never ends by design
    'v', // asset cache-buster
]);

function walkFiles(dir, ext, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(p, ext, out);
        else if (e.name.endsWith(ext)) out.push(p);
    }
    return out;
}

/** Every query key the code reads or the views send. */
function queryKeys() {
    const keys = new Set();
    for (const f of walkFiles(path.join(ROOT, 'src'), '.js')) {
        const s = fs.readFileSync(f, 'utf8');
        for (const m of s.matchAll(/req\.query\.(\w+)/g)) keys.add(m[1]);
        for (const m of s.matchAll(/req\.query\[['"]([\w-]+)['"]\]/g)) keys.add(m[1]);
        for (const m of s.matchAll(/\{([^{}]{1,600})\}\s*=\s*req\.query\b/g))
            for (const k of m[1].split(',')) {
                const kk = k
                    .trim()
                    .split(/[:=\s]/)[0]
                    .replace(/^\.\.\./, '');
                if (/^\w+$/.test(kk)) keys.add(kk);
            }
        for (const m of s.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*req\.query\b/g))
            for (const mm of s.matchAll(new RegExp('\\b' + m[1] + '\\.(\\w+)', 'g')))
                keys.add(mm[1]);
    }
    for (const f of walkFiles(path.join(ROOT, 'views'), '.ejs')) {
        const s = fs.readFileSync(f, 'utf8');
        for (const form of s.matchAll(/<form\b[^>]*method=["']?get["']?[^>]*>([\s\S]*?)<\/form>/gi))
            for (const m of form[1].matchAll(/\bname=["'](\w+)["']/g)) keys.add(m[1]);
        for (const m of s.matchAll(/[?&](?:amp;)?([a-zA-Z]\w{0,30})=/g)) keys.add(m[1]);
    }
    const JS_PROPS = new Set(['length', 'toString', 'hasOwnProperty', 'constructor']);
    return [...keys].filter((k) => !JS_PROPS.has(k) && !KEYS_NOT_SENT.has(k)).sort();
}

// ---------------------------------------------------------------- fixtures

let db;
let app;
const F = {};
const COOKIE = {};
const results = [];

const SEGMENT_TABLE = {
    employees: 'employees',
    employee: 'employees',
    admins: 'admins',
    cycles: 'assessment_cycles',
    departments: 'departments',
    sites: 'sites',
    services: 'services',
    domains: 'domains',
    roles: 'roles',
    role: 'roles',
    skills: 'skills',
    coaching: 'coaching_plans',
    idp: 'idp_plans',
    pip: 'pips',
    disputes: 'assessment_disputes',
    notifications: 'notifications',
    goals: 'goals',
    surveys: 'surveys',
    templates: 'report_templates',
    schedules: 'report_schedules',
    onboarding: 'onboarding_requests',
    calibration: 'calibration_sessions',
    objectives: 'idp_objectives',
};
const segIds = {};
const NAMED = { lng: 'fr', provider: 'none', format: 'xlsx', source: 'roles', name: 'none' };

function urlFor(pattern) {
    return pattern.replace(/(\/)?([\w-]+)?\/:(\w+)(\([^)]*\))?(\?)?/g, (...a) => {
        const [, slash, seg, name] = a;
        const prefix = (slash || '') + (seg ? seg + '/' : '');
        let v = '1';
        if (/^employee(Id)?$|^empId$/.test(name)) v = F.employee;
        else if ((name === 'id' || name === 'oid') && seg && segIds[seg]) v = segIds[seg];
        else if (Object.prototype.hasOwnProperty.call(NAMED, name)) v = NAMED[name];
        return prefix + v;
    });
}

async function inRollback(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn();
            await new Promise((r) => setTimeout(r, 10));
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
    return out;
}

async function get(role, url) {
    return inRollback(() =>
        request(app)
            .get(url)
            .redirects(0)
            .timeout(45000)
            .set('Cookie', COOKIE[role])
            .set('Accept', 'text/html,application/xhtml+xml')
            .buffer(true)
            .parse((res, cb) => {
                // every answer as text (xlsx / pdf / csv included), without decoding errors
                const chunks = [];
                res.on('data', (c) => chunks.push(Buffer.from(c)));
                res.on('end', () => cb(null, Buffer.concat(chunks).toString('latin1')));
            })
            .then(
                (x) => x,
                (err) => ({ status: err.timeout ? 'timeout' : 'error:' + err.message, headers: {} })
            )
    );
}

/** A problem with this answer, or null. */
function verdict(res) {
    if (typeof res.status !== 'number') return 'no answer: ' + res.status;
    if (res.status >= 500) return 'server error ' + res.status;
    const loc = (res.headers && res.headers.location) || '';
    if (loc.includes('<') || loc.includes('"'))
        return 'raw marker in Location: ' + loc.slice(0, 120);
    const ct = String((res.headers && res.headers['content-type']) || '');
    const body = typeof res.body === 'string' ? res.body : String(res.text || '');
    if (/text\/html/i.test(ct) && body.includes(RAW_TAG)) {
        const at = body.indexOf(RAW_TAG);
        return 'raw marker in HTML: …' + body.slice(Math.max(0, at - 120), at + 40) + '…';
    }
    if (/^\s*[[{]/.test(body) && body.includes(RAW_TAG) && !/json/i.test(ct))
        return 'JSON echoing the marker served as ' + ct;
    return null;
}

async function resolveFixtures() {
    const usable = (row) =>
        row &&
        !row.forcePasswordChange &&
        row.authPolicy !== 'mfa_required' &&
        row.isActive !== false &&
        row.isAccountActive !== false;
    const sa = await db.get(
        "SELECT * FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id LIMIT 1"
    );
    F.superadmin = Number(sa.id);
    // a supervisor and one of their reports, both able to sign in
    const pairs = await db.all(
        `SELECT e.id AS emp, e.supervisor_id AS mgr FROM employees e
          WHERE e.is_active = true AND e.supervisor_id IS NOT NULL
          ORDER BY e.id LIMIT 50`
    );
    for (const p of pairs) {
        const [m, e] = [
            await db.get('SELECT * FROM employees WHERE id = ?', [p.mgr]),
            await db.get('SELECT * FROM employees WHERE id = ?', [p.emp]),
        ];
        if (usable(m) && usable(e)) {
            F.manager = Number(p.mgr);
            F.employee = Number(p.emp);
            break;
        }
    }
    for (const [seg, table] of Object.entries(SEGMENT_TABLE)) {
        try {
            const r = await db.get(`SELECT MIN(id) AS id FROM ${table}`);
            if (r && r.id != null) segIds[seg] = String(r.id);
        } catch (_) {
            /* table absent: '1' */
        }
    }
    segIds.employees = segIds.employee = String(F.employee);
    segIds.admins = String(F.superadmin);
    const P = {
        superadmin: { id: F.superadmin, userType: 'admin' },
        manager: { id: F.manager, userType: 'employee' },
        employee: { id: F.employee, userType: 'employee' },
    };
    for (const [role, p] of Object.entries(P))
        COOKIE[role] = await mintSession(storeState.store, p, CSRF);
}

d('every query parameter on every GET route: escaped or refused, never a 5xx', () => {
    let routes = [];
    let KEYS = [];
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        await require('../../src/utils/searchSql').init(db);
        app = loadApp();
        await i18nReady();
        routes = listRoutes(app).filter(
            (r) =>
                r.method === 'GET' && !NOT_FIRED.test(r.path) && (!ONLY_RE || ONLY_RE.test(r.path))
        );
        KEYS = queryKeys();
        await resolveFixtures();
    });

    afterAll(async () => {
        if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(results, null, 1));
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    test('preconditions: routes, keys and personas resolved; the marker reaches a page escaped', async () => {
        if (!ONLY_RE) expect(routes.length).toBeGreaterThan(250);
        for (const k of ['search', 'q', 'site', 'page', 'sort', 'cycleId', 'status'])
            expect(KEYS).toContain(k);
        expect(KEYS.length).toBeGreaterThan(100);
        expect(F.manager && F.employee && F.superadmin).toBeTruthy();
        const r = await get('superadmin', '/about');
        expect(r.status).toBe(200);
        // the employee list echoes ?search= (escaped): the marker really reaches a page
        const s = await get('superadmin', '/employees?search=' + encodeURIComponent(MARK));
        expect(s.status).toBe(200);
        expect(s.body).toContain('&lt;i data-qpm&gt;');
        expect(s.body).not.toContain(RAW_TAG);
    });

    /** Run `fn` over `items`, `n` at a time (each request owns its rolled-back transaction). */
    async function pool(items, n, fn) {
        let i = 0;
        const worker = async () => {
            while (i < items.length) {
                const it = items[i++];
                await fn(it);
            }
        };
        await Promise.all(Array.from({ length: n }, worker));
    }

    /** The answer, and, for a same-origin redirect, the page it lands on. */
    async function probe(role, url, label, failures) {
        const res = await get(role, url);
        const v = verdict(res);
        if (v) failures.push(`${role} GET ${label} -> ${v}`);
        const loc = (res.headers && res.headers.location) || '';
        if (
            res.status >= 300 &&
            res.status < 400 &&
            /^\/(?!\/)/.test(loc) &&
            !/^\/login\b/.test(loc)
        ) {
            const hop = await get(role, loc);
            const vh = verdict(hop);
            if (vh) failures.push(`${role} GET ${label} => ${loc.slice(0, 80)} -> ${vh}`);
        }
        return res;
    }

    for (const role of ['superadmin', 'manager', 'employee']) {
        test(`${role}: all keys at once, then in groups where the batch was refused`, async () => {
            const failures = [];
            const q = (keys) => keys.map((k) => `${k}=${encodeURIComponent(MARK)}`).join('&');
            const all = q(KEYS);
            const groups = [];
            for (let i = 0; i < KEYS.length; i += GROUP) groups.push(KEYS.slice(i, i + GROUP));
            await pool(routes, 4, async (r) => {
                const base = urlFor(r.path);
                const sep = base.includes('?') ? '&' : '?';
                const res = await probe(role, base + sep + all, `${r.path} [all keys]`, failures);
                results.push({ role, route: r.path, status: res.status });
                if (res.status === 400 || res.status === 422) {
                    for (const g of groups)
                        await probe(
                            role,
                            base + sep + q(g),
                            `${r.path} [${g[0]}..${g[g.length - 1]}]`,
                            failures
                        );
                }
            });
            expect(failures.sort()).toEqual([]);
        });
    }
});
