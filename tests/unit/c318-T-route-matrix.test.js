'use strict';
/**
 * 3.23.18 — lane T, CQ-02: route × role ACCESS MATRIX over real HTTP.
 *
 * The real app (server.js's own middleware chain, see
 * tests/helpers/c318/buildApp.js for the four neutralised boot lines and the
 * documented divergences) is driven with supertest against idevelop_fixtures.
 * EVERY route registered on the router stack is enumerated by walking
 * app._router.stack recursively — a new route joins the matrix automatically.
 *
 *   1. anonymous  → every non-public route answers 401, 403, or 302 to /login
 *                   (directly or after ONE auth-gated hop, e.g. → /dashboard);
 *                   the public allow-list is explicit below.
 *   2. per role   → every GET route answers < 500 for anonymous, employee,
 *                   manager, scoped local admin, viewer admin and superadmin.
 *   3. writes     → a representative set of POSTs on real :id resources is
 *                   REFUSED (401/403/404) for a role outside scope.
 *
 * Nothing persists: sessions are MINTED into a MemoryStore (no login, no
 * password, no last_login_at), and EVERY request runs inside a transaction
 * that is always rolled back — the HTTP server is created inside the
 * transaction's AsyncLocalStorage context, so the route's own db.* calls use
 * that client (asserted by the first test). The audit backstop still runs but
 * LogService.log / PerfEventService.record are no-ops (hash-chained log of the
 * test DB untouched). Skipped when DATABASE_URL is not idevelop_fixtures.
 *
 * Known server errors are pinned in KNOWN_500 and asserted with test.failing
 * so that FIXING one makes this suite ask for the list to shrink.
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000';
// SQL-console restore points: a temp dir, never %ProgramData% (the listing
// route creates its folder on read, which answers EPERM there for this process).
process.env.SQL_CONSOLE_BACKUP_DIR = require('path').join(
    require('os').tmpdir(),
    'c318-sql-restore-points'
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
// 3.23.21 (SEC-4): the local-content module is OFF by default, and while it is
// off every /reports/local-content/* route answers 404 for EVERYONE — so the
// write refusals below would pass vacuously. It is switched ON for the matrix
// (the module's own gate, not a setting row) and a test asserts it is on.
jest.mock('../../src/controllers/LocalContentController', () => {
    const real = jest.requireActual('../../src/controllers/LocalContentController');
    real._enabled = async () => true;
    return real;
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, listRoutes, mintSession } = require('../helpers/c318/buildApp');
const storeState = require('../helpers/c318/sessionStoreMock').state;

const ENABLED = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(20 * 60 * 1000);

const CSRF = 'c318-fixed-csrf-token';
const ROLLBACK = Symbol('c318-rollback');
const REPORT_DIR = process.env.C318_REPORT_DIR || null; // optional JSON dump for triage
// Optional triage filter on the route PATTERN (e.g. C318_ONLY=^/v2/cap). Unset in CI.
const ONLY_RE = process.env.C318_ONLY ? new RegExp(process.env.C318_ONLY) : null;
const only = (r) => !ONLY_RE || ONLY_RE.test(r.path);

// ------------------------------------------------------------------ policy

/**
 * Routes an anonymous caller may reach. Each entry is a reviewed decision,
 * matched against the ROUTE PATTERN (not the substituted URL).
 */
const PUBLIC = [
    // probes (mounted before the session, never redirect)
    'GET /health',
    'GET /healthz',
    'GET /health/ready',
    'GET /readyz',
    'GET /metrics', // loopback-only (or METRICS_TOKEN) — supertest IS loopback
    // authentication surfaces
    'GET /login',
    'POST /login',
    'GET /login/mfa',
    'POST /login/mfa',
    'GET /forgot-password',
    'POST /forgot-password',
    'GET /reset-password',
    'POST /reset-password',
    // self-service onboarding (runtime-gated by the onboarding.* settings)
    'GET /signup',
    'POST /signup',
    'GET /onboarding/pending',
    'GET /lang/:lng',
    // SSO / SAML / LTI transports (IdP-, signature- or secret-authenticated)
    'GET /auth/sso/:provider',
    'GET /auth/sso/:provider/callback',
    'POST /auth/sso/:provider/callback',
    'GET /saml/metadata', // SP metadata: our entity id, nothing secret
    'GET /.well-known/lms-jwks.json', // LTI platform PUBLIC keys
    'POST /integrations/lms/:provider/webhook', // per-provider shared secret
    'GET /lti/:provider/auth',
    // versioned API discovery documents
    'GET /api/v1/',
    'GET /api/v1/openapi.json',
];

/**
 * Anonymous non-GET calls NOT fired by the matrix: they reach external
 * processes (pg_dump/pg_restore) or the network if a gate were ever missing,
 * which a rolled-back transaction cannot undo. They sit behind the global
 * `router.use(requireAuth)` like their siblings.
 */
const ANON_WRITE_NOT_FIRED =
    /\/(snapshots|reset|sql-console|restore|test-email|test-copilot|sync|test)(\/|$)/;

/** Server errors known at the time of writing (route pattern → roles). Shrink me. */
const KNOWN_500 = {};

/**
 * The test database may trail the migrations shipped in db/postgres (the suite
 * never migrates it). While migrations are PENDING, a 5xx whose own logged
 * cause is a missing relation/column is reported as schema lag (stderr + the
 * JSON report), not as a route defect. With no pending migration it fails.
 */
let PENDING = [];
const SCHEMA_LAG_RE = /(relation|column) "[^"]+"( of relation "[^"]+")? does not exist/;

// ------------------------------------------------------------------ fixtures

let db;
let app;
let routes = [];
const F = {}; // resolved fixture ids
const COOKIE = {}; // role → Cookie header
const USERS = {}; // role → deserialized user
const results = []; // {role, method, route, url, status, location, body}

const SEGMENT_TABLE = {
    employees: 'employees',
    employee: 'employees',
    'employee-detail': 'employees',
    admins: 'admins',
    'api-keys': 'api_keys',
    cycles: 'assessment_cycles',
    departments: 'departments',
    sites: 'sites',
    services: 'services',
    domains: 'domains',
    subdomains: 'sub_domains',
    roles: 'roles',
    role: 'roles',
    skills: 'skills',
    coaching: 'coaching_plans',
    idp: 'idp_plans',
    pip: 'pips',
    ninebox: 'nine_box_evaluations',
    disputes: 'assessment_disputes',
    notifications: 'notifications',
    'check-ins': 'check_ins',
    'check-in-items': 'check_in_items',
    goals: 'goals',
    surveys: 'surveys',
    survey: 'surveys',
    opportunity: 'opportunities',
    handover: 'handover_plans',
    successors: 'successors',
    successor: 'successors',
    calibration: 'calibration_sessions',
    sessions: 'coaching_sessions',
    snapshots: 'snapshots',
    templates: 'report_templates',
    schedules: 'report_schedules',
    webhooks: 'webhook_subscriptions',
    onboarding: 'onboarding_requests',
    'assessment-changes': 'assessment_change_requests',
    cancellations: 'cancellation_requests',
    'maker-checker': 'maker_checker_requests',
    'post-approval': 'post_approval_reviews',
    dsr: 'dsr_requests',
    absences: 'planned_absences',
    'dept-brief': 'dept_briefs',
    suggestion: 'skill_suggestions',
    // 3.23.21 (SEC-4): 'rules' is two tables — /compliance/rules/:id (coverage)
    // and /safety-gate/config/rules/:id. A 'parent/segment' key wins over the
    // bare segment (see urlFor).
    rules: 'coverage_rules',
    'compliance/rules': 'coverage_rules',
    'config/rules': 'safety_gate_rules',
    course: 'lms_courses',
    certifications: 'employee_certifications',
    // /v2/lms/uplifts/:id/{accept,decline} decide an lms_completions row
    // (LmsService.decideUplift) — it was mapped to training_plans.
    uplifts: 'lms_completions',
    // /reports/local-content/packs/:id/* — regulator packs, not training plans.
    packs: 'lc_regulatory_packs',
    'nationalisation/plans': 'lc_nationalisation_plans',
    'nationalisation/successors': 'lc_nationalisation_successors',
    objectives: 'idp_objectives',
    application: 'opportunity_applications',
    batches: 'sso_remap_batches',
    invitations: 'account_requests',
};
const segIds = {};

const NAMED = {
    provider: 'c318none',
    tick: '1',
    format: 'xlsx',
    name: 'c318none',
    source: 'roles',
    nonce: 'c318none',
    lng: 'fr',
    employeeNumber: 'C318NONE',
    token: 'c318none',
};

/** Concrete URL for a route pattern, using ids of REAL fixture rows. */
function urlFor(pattern, role) {
    return pattern.replace(/(\/)?([\w-]+)?\/:(\w+)(\([^)]*\))?(\?)?/g, (...a) => {
        const [, slash, seg, name] = a;
        const offset = a[a.length - 2];
        const prefix = (slash || '') + (seg ? seg + '/' : '');
        // The segment BEFORE `seg` disambiguates a segment shared by two tables.
        const parent = pattern.slice(0, offset).split('/').filter(Boolean).pop();
        const compound = parent && seg ? `${parent}/${seg}` : null;
        let v;
        if (/^employee(Id)?$|^empId$/.test(name)) v = F.targetEmployeeFor[role] || F.employee;
        else if ((name === 'id' || name === 'oid') && compound && SEGMENT_TABLE[compound])
            v = segIds[compound] || '1';
        else if ((name === 'id' || name === 'oid') && seg && SEGMENT_TABLE[seg])
            v = segIds[seg] || '1';
        else if (Object.prototype.hasOwnProperty.call(NAMED, name)) v = NAMED[name];
        else v = '1';
        return prefix + v;
    });
}

async function inRollback(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn();
            // let fire-and-forget statements started by the route land INSIDE the tx
            await new Promise((r) => setTimeout(r, 15));
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
    return out;
}

async function hit(role, method, pattern, { json = false, url, body } = {}) {
    const target = url || urlFor(pattern, role);
    // Keep what the server logged during THIS request: a 5xx row then carries
    // its own cause in the triage report instead of a generic error page.
    const logged = [];
    const origError = console.error;
    console.error = (...a) =>
        logged.push(
            a
                .map((x) => (x && x.stack) || String(x))
                .join(' ')
                .slice(0, 600)
        );
    const res = await inRollback(() => {
        let r = request(app)[method.toLowerCase()](target).redirects(0).timeout(30000);
        if (COOKIE[role]) r = r.set('Cookie', COOKIE[role]);
        if (json) r = r.set('Accept', 'application/json').set('X-Requested-With', 'XMLHttpRequest');
        else r = r.set('Accept', 'text/html,application/xhtml+xml');
        if (method !== 'GET' && method !== 'HEAD')
            r = r
                .set('x-csrf-token', CSRF)
                .type('form')
                .send(body || { c318: '1' });
        return r.then(
            (x) => x,
            (err) => ({
                status: err.timeout ? 'timeout' : 'error:' + err.message,
                headers: {},
                text: '',
            })
        );
    }).finally(() => {
        console.error = origError;
    });
    const serverError = typeof res.status !== 'number' || res.status >= 500;
    const row = {
        role,
        method,
        route: pattern,
        url: target,
        status: res.status,
        location: (res.headers && res.headers.location) || null,
        body: serverError ? String(res.text || '').slice(0, 300) : undefined,
        logged: serverError ? logged.slice(0, 5) : undefined,
    };
    results.push(row);
    return row;
}

async function deserialize(principal) {
    const { passport } = require('../../src/middleware/auth');
    return new Promise((resolve, reject) =>
        passport.deserializeUser(principal, (err, u) => (err ? reject(err) : resolve(u)))
    );
}

async function pickEmployeeOutsideScope(user, exclude) {
    const RBAC = require('../../src/services/RBACService');
    const rows = await db.all(
        `SELECT id FROM employees WHERE is_active = true AND site_id IS NOT NULL
            AND department_id IS NOT NULL AND service_id IS NOT NULL AND role_id IS NOT NULL
          ORDER BY id LIMIT 400`
    );
    for (const r of rows) {
        if (exclude.includes(Number(r.id))) continue;
        if (!(await RBAC.canViewEmployee(user, Number(r.id)))) return Number(r.id);
    }
    return null;
}

async function resolveFixtures() {
    const usable = (row) =>
        row &&
        !row.forcePasswordChange &&
        row.authPolicy !== 'mfa_required' &&
        row.isActive !== false;
    const admin = async (username, role) => {
        let row = await db.get('SELECT * FROM admins WHERE username = ? AND is_active = true', [
            username,
        ]);
        if (!usable(row))
            row = await db.get(
                'SELECT * FROM admins WHERE role::text = ? AND is_active = true AND NOT COALESCE(force_password_change,false) ORDER BY id LIMIT 1',
                [role]
            );
        return row ? Number(row.id) : null;
    };
    F.superadmin = await admin('test.super', 'superadmin');
    F.localadmin = await admin('test.local', 'localadmin');
    F.viewer = await admin('test.viewer', 'viewer');

    const EmployeeModel = require('../../src/models/EmployeeModel');
    const bosses = await db.all(
        `SELECT e.supervisor_id AS id, COUNT(*) AS n FROM employees e
          WHERE e.is_active = true AND e.supervisor_id IS NOT NULL
          GROUP BY e.supervisor_id ORDER BY COUNT(*) DESC, e.supervisor_id LIMIT 20`
    );
    for (const b of bosses) {
        const row = await db.get('SELECT * FROM employees WHERE id = ?', [b.id]);
        if (!usable(row) || row.isAccountActive === false) continue;
        if (!(await EmployeeModel.governanceOf(Number(b.id))).governs) continue;
        const reps = await db.all(
            'SELECT * FROM employees WHERE supervisor_id = ? AND is_active = true ORDER BY id',
            [b.id]
        );
        for (const r of reps) {
            if (!usable(r) || r.isAccountActive === false) continue;
            if ((await EmployeeModel.governanceOf(Number(r.id))).governs) continue;
            F.manager = Number(b.id);
            F.employee = Number(r.id);
            break;
        }
        if (F.manager) break;
    }

    for (const [seg, table] of Object.entries(SEGMENT_TABLE)) {
        try {
            const r = await db.get(`SELECT MIN(id) AS id FROM ${table}`);
            if (r && r.id != null) segIds[seg] = String(r.id);
        } catch (_) {
            /* table absent on this schema: '1' is used */
        }
    }
    segIds.employees = segIds.employee = segIds['employee-detail'] = String(F.employee);
    segIds.admins = String(F.superadmin);

    const principals = {
        employee: { id: F.employee, userType: 'employee' },
        manager: { id: F.manager, userType: 'employee' },
        localadmin: { id: F.localadmin, userType: 'admin' },
        viewer: { id: F.viewer, userType: 'admin' },
        superadmin: { id: F.superadmin, userType: 'admin' },
    };
    for (const [role, p] of Object.entries(principals)) {
        USERS[role] = await deserialize(p);
        COOKIE[role] = await mintSession(storeState.store, p, CSRF);
    }
    COOKIE.anonymous = await mintSession(storeState.store, null, CSRF);

    const exclude = [F.employee, F.manager].filter(Boolean);
    F.targetEmployeeFor = {
        anonymous: F.employee,
        employee: F.employee,
        manager: F.employee,
        localadmin: F.employee,
        viewer: F.employee,
        superadmin: F.employee,
    };
    F.outsideManager = await pickEmployeeOutsideScope(USERS.manager, exclude);
    F.outsideLocal = await pickEmployeeOutsideScope(USERS.localadmin, exclude);

    // 3.23.21 (SEC-4): real rows for the new write probes (null when the test
    // database has none — the probe is then skipped, never faked).
    const firstId = async (sql, params = []) => {
        try {
            const r = await db.get(sql, params);
            return r && r.id != null ? Number(r.id) : null;
        } catch (_) {
            return null;
        }
    };
    // An IDP whose subject is NOT the employee fixture (employee / viewer act on it)…
    F.idpOther = await firstId('SELECT MIN(id) AS id FROM idp_plans WHERE employee_id <> ?', [
        F.employee,
    ]);
    // …and one of a person OUTSIDE the manager's governance.
    F.idpOutsideManager = await firstId(
        'SELECT MIN(id) AS id FROM idp_plans WHERE employee_id = ?',
        [F.outsideManager]
    );
    F.objectiveOther = await firstId(
        'SELECT MIN(o.id) AS id FROM idp_objectives o JOIN idp_plans p ON p.id = o.idp_id WHERE p.employee_id <> ?',
        [F.employee]
    );
    F.surveyAny = await firstId('SELECT MIN(id) AS id FROM surveys');
    F.applicationAny = await firstId('SELECT MIN(id) AS id FROM opportunity_applications');

    // A VALID edit form for a real employee (its own current values), so the
    // write probe passes body validation and reaches the SCOPE check: an empty
    // body stops at employeeValidation (400) and proves nothing about authz.
    F.editBody = {};
    for (const id of [F.employee, F.outsideManager, F.outsideLocal]) {
        const e = await db.get('SELECT * FROM employees WHERE id = ?', [id]);
        F.editBody[id] = {
            firstName: e.firstName,
            lastName: e.lastName,
            siteId: String(e.siteId),
            departmentId: String(e.departmentId),
            serviceId: String(e.serviceId),
            roleId: String(e.roleId),
            employeeNumber: e.employeeNumber || '',
            email: e.email || '',
        };
    }
}

// ------------------------------------------------------------------ suite

d('c318 T — route × role access matrix (HTTP, idevelop_fixtures, rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        await require('../../src/utils/searchSql').init(db);
        try {
            await require('../../src/config/i18n').init();
        } catch (_) {
            /* key passthrough */
        }
        app = loadApp();
        await new Promise((r) => setTimeout(r, 300)); // let server.js's own i18n init settle
        routes = listRoutes(app);
        const mig = await require('../../src/controllers/HealthController').migrationsState();
        PENDING = (mig && mig.pending) || [];
        await resolveFixtures();
    });

    afterAll(async () => {
        if (REPORT_DIR) {
            fs.mkdirSync(REPORT_DIR, { recursive: true });
            fs.writeFileSync(
                path.join(REPORT_DIR, 'c318-route-matrix.json'),
                JSON.stringify(results, null, 1)
            );
        }
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    test('preconditions: the matrix has routes, every role resolved, and a request runs INSIDE the rollback transaction', async () => {
        expect(routes.length).toBeGreaterThan(300);
        for (const role of ['employee', 'manager', 'localadmin', 'viewer', 'superadmin']) {
            expect(USERS[role]).toBeTruthy();
        }
        expect(USERS.employee.userType).toBe('employee');
        expect(USERS.manager.userType).toBe('manager');
        expect(USERS.localadmin.role).toBe('localadmin');
        expect(USERS.viewer.role).toBe('viewer');
        expect(USERS.superadmin.role).toBe('superadmin');
        expect(F.outsideManager).toBeTruthy();
        expect(F.outsideLocal).toBeTruthy();
        // The allow-list stays honest: every public entry is a route that exists.
        const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
        expect(PUBLIC.filter((p) => !registered.has(p))).toEqual([]);

        // AsyncLocalStorage reaches the handler: a probe app sees db.inTransaction().
        const express = require('express');
        const probe = express();
        probe.get('/tx', (req, res) => res.json({ inTx: db.inTransaction() }));
        const r = await inRollback(() => request(probe).get('/tx'));
        expect(r.body).toEqual({ inTx: true });

        // …and the minted session is honoured by the real chain.
        const who = await hit('superadmin', 'GET', '/about');
        expect(who.status).toBe(200);
    });

    test('anonymous: every non-public route is refused (401/403 or redirect to /login)', async () => {
        const failures = [];
        const isPublic = (m, p) => PUBLIC.includes(`${m} ${p}`);
        for (const r of routes.filter(only)) {
            if (isPublic(r.method, r.path)) continue;
            if (r.method !== 'GET' && ANON_WRITE_NOT_FIRED.test(r.path)) continue;
            const row = await hit('anonymous', r.method, r.path, { json: r.method !== 'GET' });
            let ok = row.status === 401 || row.status === 403;
            if (!ok && row.status === 302 && row.location) {
                if (/^\/login\b/.test(row.location)) ok = true;
                else if (/^\/[^/]/.test(row.location)) {
                    // one hop: the redirect target must itself send an anonymous caller to /login
                    const hop = await hit('anonymous', 'GET', row.location.split('?')[0], {
                        url: row.location,
                    });
                    ok =
                        hop.status === 401 ||
                        (hop.status === 302 && /^\/login\b/.test(hop.location || ''));
                }
            }
            if (!ok)
                failures.push(
                    `${r.method} ${r.path} → ${row.status}${row.location ? ' ' + row.location : ''}`
                );
        }
        expect(failures).toEqual([]);
    });

    for (const role of ['anonymous', 'employee', 'manager', 'localadmin', 'viewer', 'superadmin']) {
        test(`GET routes never answer 5xx for ${role}`, async () => {
            const failures = [];
            const lag = [];
            for (const r of routes.filter(only)) {
                if (r.method !== 'GET') continue;
                const known = KNOWN_500[r.path];
                if (known && known.includes(role)) continue;
                const row = await hit(role, 'GET', r.path);
                if (typeof row.status === 'number' && row.status < 500) continue;
                const cause = (row.logged || []).join(' ');
                if (PENDING.length && SCHEMA_LAG_RE.test(cause))
                    lag.push(`GET ${r.path} → ${row.status}: ${cause.slice(0, 160)}`);
                else
                    failures.push(
                        `GET ${r.path} (${row.url}) → ${row.status} ${cause.slice(0, 160)}`
                    );
            }
            if (lag.length)
                process.stderr.write(
                    `\n[c318] ${role}: ${lag.length} route(s) fail only because idevelop_fixtures lacks migration(s) ` +
                        `${PENDING.join(', ')}:\n  ${lag.join('\n  ')}\n`
                );
            expect(failures).toEqual([]);
        });
    }

    // Representative writes on REAL rows by a role OUTSIDE scope: must be refused.
    const WRITES = () => {
        const E = F.employee;
        const XM = F.outsideManager;
        const XL = F.outsideLocal;
        const role = segIds.roles;
        const skill = segIds.skills;
        const cycle = segIds.cycles;
        const sa = F.superadmin;
        // 3.23.21 (SEC-4): writes of the 3.23.18-.20 surfaces. A probe whose row
        // does not exist in the test database is dropped, never pointed at id 1.
        const has = (u) => !/\/(null|undefined)(\/|$)/.test(u);
        const gateRule = segIds['config/rules'] || null;
        const pack = segIds.packs || null;
        const plan = segIds['nationalisation/plans'] || null;
        const safetyConfig = [
            '/safety-gate/config/rules',
            '/safety-gate/config/rules/preview',
            '/safety-gate/config/settings',
            `/safety-gate/config/rules/${gateRule}/deactivate`,
            `/safety-gate/config/rules/${gateRule}/mode`,
        ];
        const localContentPacks = [
            '/reports/local-content/packs',
            `/reports/local-content/packs/${pack}/publish`,
            `/reports/local-content/packs/${pack}/discard`,
        ];
        const localContentPlans = [
            '/reports/local-content/nationalisation/plans',
            `/reports/local-content/nationalisation/plans/${plan}/target`,
            `/reports/local-content/nationalisation/plans/${plan}/close`,
        ];
        const idpLifecycle = (idp) => [`/v2/idp/${idp}/complete`, `/v2/idp/${idp}/archive`];
        const objectiveState = [`/v2/idp/objectives/${F.objectiveOther}/state`];
        // SEC-3: an ADMIN never answers a survey (for anybody).
        const surveyRespond = [`/v2/cap/survey/${F.surveyAny}/respond`];
        const mobilityDecide = [`/v2/cap/opportunity/application/${F.applicationAny}/decide`];
        const extra = {
            employee: [
                ...safetyConfig,
                ...localContentPacks,
                ...localContentPlans,
                ...idpLifecycle(F.idpOther),
                ...objectiveState,
                ...mobilityDecide,
            ],
            manager: [...safetyConfig, ...localContentPacks, ...idpLifecycle(F.idpOutsideManager)],
            viewer: [
                ...safetyConfig,
                ...localContentPacks,
                ...localContentPlans,
                ...idpLifecycle(F.idpOther),
                ...objectiveState,
                ...surveyRespond,
                ...mobilityDecide,
            ],
            // test.local holds no manage_compliance: the config and packs are closed.
            localadmin: [...safetyConfig, ...localContentPacks, ...surveyRespond],
        };
        const base = {
            employee: [
                `/employees/${XM}`,
                `/employees/${XM}/delete`,
                `/employees/${XM}/deactivate`,
                `/employees/${XM}/assessments`,
                `/employees/${XM}/grant-admin`,
                `/employees/${XM}/credentials`,
                '/admins',
                `/admins/${sa}/reset-password`,
                `/roles/${role}`,
                `/roles/${role}/delete`,
                `/skills/${skill}/delete`,
                '/app-settings',
                `/cycles/${cycle}/close`,
                `/v2/talent/placements/${XM}/override`,
                '/v2/pip/propose',
            ],
            manager: [
                `/employees/${XM}`,
                `/employees/${XM}/delete`,
                `/employees/${XM}/deactivate`,
                `/employees/${XM}/assessments`,
                `/employees/${XM}/grant-admin`,
                `/employees/${XM}/supervisor`,
                '/admins',
                `/admins/${sa}/reset-password`,
                `/roles/${role}/delete`,
                `/skills/${skill}/delete`,
                '/app-settings',
                `/cycles/${cycle}/close`,
            ],
            viewer: [
                `/employees/${E}`,
                `/employees/${E}/delete`,
                `/employees/${E}/deactivate`,
                `/employees/${E}/assessments`,
                `/employees/${E}/grant-admin`,
                '/admins',
                `/admins/${sa}/reset-password`,
                `/roles/${role}`,
                `/roles/${role}/delete`,
                `/skills/${skill}/delete`,
                '/app-settings',
                `/cycles/${cycle}/close`,
            ],
            localadmin: [
                `/employees/${XL}`,
                `/employees/${XL}/delete`,
                `/employees/${XL}/deactivate`,
                `/employees/${XL}/assessments`,
                `/employees/${XL}/credentials`,
                `/employees/${XL}/grant-admin`,
                '/admins',
                `/admins/${sa}/reset-password`,
                `/admins/${sa}/delete`,
                '/app-settings',
                '/app-settings/branding',
            ],
        };
        const out = {};
        for (const role of Object.keys(base))
            out[role] = [...base[role], ...(extra[role] || []).filter(has)];
        return out;
    };

    /**
     * A body that passes the route's own INPUT validation, so the probe reaches
     * the authority check: a 400 on a malformed body proves nothing about who
     * may write (IDPService.setObjectiveState validates `state` first).
     */
    function writeBody(url) {
        if (/\/objectives\/\d+\/state$/.test(url)) return { state: 'completed' };
        if (/\/config\/rules\/\d+\/mode$/.test(url)) return { mode: 'enforce' };
        if (/\/config\/rules\/\d+\/deactivate$/.test(url)) return { reason: 'c318 probe' };
        if (/\/config\/rules(\/preview)?$/.test(url))
            return { roleId: segIds.roles, skillId: segIds.skills, siteId: '', minLevel: '2' };
        if (/\/config\/settings$/.test(url)) return { expiryWarningDays: '17' };
        if (/\/decide$/.test(url)) return { decision: 'accepted' };
        if (/\/respond$/.test(url)) return { c318: '1' };
        return undefined;
    }

    /** Write refusals that currently FAIL — real authorisation defects, pinned. */
    const KNOWN_WRITE_DEFECTS = {};

    for (const role of ['employee', 'manager', 'viewer', 'localadmin']) {
        test(`writes outside scope are refused for ${role} (401/403/404)`, async () => {
            const failures = [];
            for (const url of WRITES()[role]) {
                if ((KNOWN_WRITE_DEFECTS[role] || []).includes(url.replace(/\d+/g, ':n'))) continue;
                const m = /^\/employees\/(\d+)$/.exec(url);
                const body = m ? F.editBody[Number(m[1])] : writeBody(url);
                const row = await hit(role, 'POST', url, { json: true, url, body });
                if (![401, 403, 404].includes(row.status))
                    failures.push(`POST ${url} → ${row.status}`);
            }
            expect(failures).toEqual([]);
        });
    }

    // ------------------------------------------------------ 3.23.21 (SEC-4)

    test('the local-content module is ON for this matrix (its write refusals are not vacuous 404s)', async () => {
        const row = await hit('superadmin', 'GET', '/reports/local-content');
        expect(row.status).toBe(200); // OFF: 302 → /dashboard for everyone
    });

    /**
     * API key × feed over the REAL app (SEC-2). Each key is minted INSIDE the
     * request's rolled-back transaction, so nothing persists. `true` = the feed
     * lets that scope in (any status but 401/403), `false` = 401/403.
     */
    const FEED_URLS = {
        powerbi: '/api/powerbi/employees',
        scim: '/scim/v2/Users?count=1',
        safety: '/v2/safety-gate/status',
        v1: '/api/v1/employees?limit=1',
    };
    async function keyHit(scope, url) {
        const ApiKeyService = require('../../src/services/ApiKeyService');
        return inRollback(async () => {
            const k = await ApiKeyService.generate({
                label: `c321-${scope}`,
                scope,
                createdBy: F.superadmin,
            });
            return request(app)
                .get(url)
                .redirects(0)
                .set('X-API-Key', k.key)
                .set('Accept', 'application/json');
        });
    }
    const KEY_MATRIX = {
        'powerbi.read': { powerbi: true, scim: false, safety: false },
        'safety.read': { powerbi: false, scim: false, safety: true },
        'scim.write': { powerbi: false, scim: true, safety: false },
        full: { powerbi: false, scim: false, safety: false },
    };

    test('API key × feed: a key opens ONLY the feed its scope names (Power BI, SCIM, safety gate)', async () => {
        const wrong = [];
        for (const [scope, feeds] of Object.entries(KEY_MATRIX)) {
            for (const [feed, allowed] of Object.entries(feeds)) {
                const r = await keyHit(scope, FEED_URLS[feed]);
                const refused = r.status === 401 || r.status === 403;
                if (refused === allowed) wrong.push(`${scope} on ${feed} → ${r.status}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    test('API key × feed: /api/v1 lets a powerbi.read key read', async () => {
        const r = await keyHit('powerbi.read', FEED_URLS.v1);
        expect([401, 403]).not.toContain(r.status);
    });

    /**
     * PINNED (SEC-2, /api/v1 half): api/v1/index.js resolves keys in its OWN
     * apiAuth and never reads the scope — a safety.read, scim.write or 'full'
     * key reads the v1 employee directory. The fix is a coordinator edit
     * (feedScopeAllowed('v1', scope) in that apiAuth). This test.failing then
     * FAILS: make it a plain test.
     */
    test('API key × feed: /api/v1 refuses safety.read, scim.write and unknown-scope keys', async () => {
        const wrong = [];
        for (const scope of ['safety.read', 'scim.write', 'full']) {
            const r = await keyHit(scope, FEED_URLS.v1);
            if (r.status !== 401 && r.status !== 403) wrong.push(`${scope} → ${r.status}`);
        }
        expect(wrong).toEqual([]);
    });

    /**
     * SEC-3 over HTTP: an admin cannot answer a survey FOR an employee of its
     * own scope. The test database has no survey, so an OPEN one (legacy
     * org-wide audience) with one question is created inside the rolled-back
     * transaction; the assertion is the number of answers recorded.
     */
    test('SEC-3: a local admin answering FOR an in-scope employee is refused and records nothing', async () => {
        const RBAC = require('../../src/services/RBACService');
        const inScope = (await RBAC.getFilteredEmployees(USERS.localadmin))[0];
        expect(inScope).toBeTruthy();
        const out = await inRollback(async () => {
            const s = await db.get(
                `INSERT INTO surveys (kind, title, anonymous, min_responses, state, audience_scoped)
                 VALUES ('pulse', 'c321 probe', false, 5, 'open', false) RETURNING id`
            );
            const q = await db.get(
                `INSERT INTO survey_questions (survey_id, ord, text, qtype)
                 VALUES (?, 0, 'c321 q', 'scale') RETURNING id`,
                [s.id]
            );
            const r = await request(app)
                .post(`/v2/cap/survey/${s.id}/respond`)
                .redirects(0)
                .set('Cookie', COOKIE.localadmin)
                .set('x-csrf-token', CSRF)
                .set('Accept', 'application/json')
                // A form post (the origin guard refuses an Origin-less JSON write
                // before any route runs — that refusal would prove nothing here).
                .type('form')
                .send(
                    `employeeId=${Number(inScope.id)}` +
                        `&answers[0][questionId]=${Number(q.id)}&answers[0][score]=4`
                );
            const n = await db.get(
                'SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?',
                [s.id]
            );
            return { status: r.status, recorded: Number(n.n) };
        });
        expect(out).toEqual({ status: 403, recorded: 0 });
    });

    /**
     * SEC-1: a LOCAL admin holding manage_compliance may configure rules on the
     * sites of its clearance — never the organisation-wide settings (warning
     * window, outgoing webhook) and never a site-less (every-site) rule. The
     * grant is inserted inside the request's rolled-back transaction; the
     * handler answers with a flash + redirect either way, so the assertion is
     * the DATABASE STATE read back inside the same transaction.
     */
    async function asComplianceAdmin(fn) {
        return inRollback(async () => {
            await db.run(
                `INSERT INTO admin_permissions (admin_id, permission)
                 SELECT ?, 'manage_compliance'
                  WHERE NOT EXISTS (SELECT 1 FROM admin_permissions
                                     WHERE admin_id = ? AND permission = 'manage_compliance'
                                       AND revoked_at IS NULL)`,
                [F.localadmin, F.localadmin]
            );
            return fn();
        });
    }
    const post = (role, url, body) =>
        request(app)
            .post(url)
            .redirects(0)
            .set('Cookie', COOKIE[role])
            .set('x-csrf-token', CSRF)
            .type('form')
            .send(body);
    /**
     * The safety-gate config reads columns added by a later migration (rule
     * mode, F5). While that migration is PENDING on the test database the
     * config page and rule writes fail on the missing column — reported as
     * schema lag (the suite's own rule, see PENDING), strict once migrated.
     */
    async function safetySchemaLag(label) {
        if (!PENDING.length) return false;
        const col = await db.get(
            `SELECT 1 AS ok FROM information_schema.columns
              WHERE table_name = 'safety_gate_rules' AND column_name = 'mode'`
        );
        if (col) return false;
        process.stderr.write(
            `\n[c318] ${label}: skipped — idevelop_fixtures lacks safety_gate_rules.mode (pending ${PENDING.join(', ')})\n`
        );
        return true;
    }
    const warningDays = async () =>
        Number(
            (await db.get('SELECT expiry_warning_days AS d FROM safety_gate_settings WHERE id = 1'))
                .d
        );

    test('SEC-1: the granted local admin reaches the config page (the refusals below are not a missing grant)', async () => {
        if (await safetySchemaLag('SEC-1 config page')) return;
        const seen = await asComplianceAdmin(async () => {
            const r = await request(app)
                .get('/safety-gate/config')
                .redirects(0)
                .set('Cookie', COOKIE.localadmin);
            return `${r.status} ${r.headers.location || ''}`.trim();
        });
        expect(seen).toBe('200');
    });

    test('SEC-1: a manage_compliance LOCAL admin cannot change the org-wide settings; the SuperAdmin can', async () => {
        const out = await asComplianceAdmin(async () => {
            const before = await warningDays();
            const target = before === 17 ? 18 : 17;
            await post('localadmin', '/safety-gate/config/settings', {
                expiryWarningDays: String(target),
                webhookUrl: '',
                webhookSecret: '',
            });
            const afterLocal = await warningDays();
            await post('superadmin', '/safety-gate/config/settings', {
                expiryWarningDays: String(target),
                webhookUrl: '',
                webhookSecret: '',
            });
            const afterSuper = await warningDays();
            return { before, target, afterLocal, afterSuper };
        });
        expect(out.afterLocal).toBe(out.before);
        expect(out.afterSuper).toBe(out.target); // positive control: the probe can write
    });

    test('SEC-1: a manage_compliance LOCAL admin cannot add or deactivate a SITE-LESS (every-site) rule', async () => {
        if (await safetySchemaLag('SEC-1 site-less rule')) return;
        const out = await asComplianceAdmin(async () => {
            const roleId = Number(segIds.roles);
            const skillId = Number(segIds.skills);
            const count = async () =>
                Number(
                    (
                        await db.get(
                            `SELECT COUNT(*) AS n FROM safety_gate_rules
                              WHERE is_active AND role_id = ? AND site_id IS NULL AND skill_id = ?`,
                            [roleId, skillId]
                        )
                    ).n
                );
            const before = await count();
            await post('localadmin', '/safety-gate/config/rules', {
                roleId: String(roleId),
                siteId: '',
                skillId: String(skillId),
                minLevel: '2',
            });
            const afterAdd = await count();
            // Positive control: the same form from the SuperAdmin DOES add it.
            await post('superadmin', '/safety-gate/config/rules', {
                roleId: String(roleId),
                siteId: '',
                skillId: String(skillId),
                minLevel: '2',
            });
            const afterSuper = await count();
            // A global rule that exists (inserted here, rolled back) must survive
            // the local admin's deactivation attempt.
            const other = Number(
                (await db.get('SELECT id FROM skills WHERE id <> ? ORDER BY id LIMIT 1', [skillId]))
                    .id
            );
            const rule = await db.get(
                `INSERT INTO safety_gate_rules (role_id, site_id, skill_id, min_level)
                 VALUES (?, NULL, ?, 2) RETURNING id`,
                [roleId, other]
            );
            await post('localadmin', `/safety-gate/config/rules/${rule.id}/deactivate`, {
                reason: 'c321 probe',
            });
            const still = await db.get(
                'SELECT is_active AS a FROM safety_gate_rules WHERE id = ?',
                [rule.id]
            );
            return { before, afterAdd, afterSuper, stillActive: still.a === true };
        });
        expect(out.afterAdd).toBe(out.before);
        expect(out.afterSuper).toBe(out.before + 1);
        expect(out.stillActive).toBe(true);
    });
});
