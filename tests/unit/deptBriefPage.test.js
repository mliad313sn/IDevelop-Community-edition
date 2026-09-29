'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * DEPARTMENT BRIEF — the CONSULTABLE page (spec of 13/09/2026, §5.3 / §7 rows 11-16).
 *
 * What this suite pins, and why each pin exists:
 *
 *  - the page renders the FROZEN payload and NEVER recomputes on the way in.
 *    Every view underneath descends from `v_employee_details WHERE is_active`,
 *    departmental membership is today's, and `skill_assessments.assessed_at` is
 *    mutated in place — a silent recomputation rewrites history under the reader.
 *    Recomputation exists only behind an explicit button, in its own column.
 *  - GUARD 1, ownership: a brief addressed to somebody else is refused with a
 *    sentence. Measured over HTTP on :3173 — GET /reports/dept-brief/5 as
 *    uat.manager (136) → 403.
 *  - GUARD 2, scope REPLAYED at read time: `admin_scopes` carries `revoked_at`
 *    and `expires_at`, so an archive row must not be a permanent window onto
 *    figures the reader has since lost. Measured over HTTP: the SAME session
 *    reading two rows that differ only by one department id in the frozen
 *    payload gets 200 and 403.
 *  - GUARD 3, no name is ever stored: the payload holds unit ids and aggregates
 *    only; C1b names are re-resolved LIVE from today's DIRECT reports, never from
 *    `findGovernedIds` (that is the whole sub-tree — naming somebody three levels
 *    away in an email is a different act), and never for an admin reader.
 *  - the four cadence checkboxes write ON *and* OFF explicitly: an unchecked box
 *    posts nothing, so a missing row would fall back to the default and switch
 *    the cadence silently back on.
 *  - weekly is OFF by default for an employee recipient (manager-digest already
 *    carries A1/A5/B1/C1/C2 every Monday) and ON for an admin (who receives no
 *    weekly message at all today).
 *
 * Measured on the development database while writing this (all figures below come from that
 * run): employee 136 governs 15 people in ONE department (Riverside / IT, id 11);
 * its rendered brief carries 12 « — » cells, 2 « non publiable » cells, ZERO
 * occurrences of « 0 % » or « 0,0 % », and ZERO amber/red on an unmeasured cell
 * (critical compliance reads « — » in grey #64748b with the tooltip « Jamais
 * évalué — aucune donnée, ce n’est pas un niveau 0 »).
 */

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    inTransaction: jest.fn(() => false),
};
jest.mock('../../src/config/database', () => mockDb);

const mockRbacScope = { scopedEmployeeIds: jest.fn(), scopeClause: jest.fn(() => '') };
jest.mock('../../src/utils/rbacScope', () => mockRbacScope);

const mockService = {
    rosterGrid: jest.fn(async () => []),
    directReportIds: jest.fn(async () => []),
    unitLabel: jest.fn(() => ({ fr: 'unité', en: 'unit' })),
    scopeClause: jest.fn(() => ({ clause: '', params: [] })),
    buildPayload: jest.fn(async () => ({ footer: { units: [] }, computedAt: new Date() })),
    // UAT3 A-09/M-14 + A-15 — the render-time repair of an ALREADY ARCHIVED
    // payload, which `loadForReader` runs on the way out. What it repairs is
    // proven in lotA-dept-brief-uat3; here it only has to exist and hand the
    // payload straight back, so the three read guards below are measured on the
    // same object as before.
    repairFrozenPayload: jest.fn((p) => p),
};
jest.mock('../../src/services/DeptBriefService', () => mockService);

const mockSettings = { getValue: jest.fn(async (k, d) => d) };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const C = require('../../src/controllers/DeptBriefController');
const T = C.__test;

const ROOT = path.join(__dirname, '../..');
const CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/DeptBriefController.js'), 'utf8');
const ROUTES_SRC = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
const LIST_EJS = fs.readFileSync(path.join(ROOT, 'views/pages/reports/dept-brief.ejs'), 'utf8');
const SHOW_EJS = fs.readFileSync(
    path.join(ROOT, 'views/pages/reports/dept-brief-show.ejs'),
    'utf8'
);
const NOTIF_EJS = fs.readFileSync(path.join(ROOT, 'views/pages/account/notifications.ejs'), 'utf8');
const SCHED_EJS = fs.readFileSync(path.join(ROOT, 'views/pages/reports/schedules.ejs'), 'utf8');

/** Guards run against CODE, not prose: the comments deliberately name what is banned. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const CTRL_CODE = strip(CTRL_SRC);
const SHOW_CODE = SHOW_EJS.replace(/<%#[\s\S]*?%>/g, ' ');
const LIST_CODE = LIST_EJS.replace(/<%#[\s\S]*?%>/g, ' ');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function mkRes() {
    const res = { locals: {}, rendered: null, statusCode: 200, redirected: null };
    res.render = jest.fn((view, locals) => {
        res.rendered = { view, locals };
    });
    res.redirect = jest.fn((u) => {
        res.redirected = u;
    });
    res.status = jest.fn((c) => {
        res.statusCode = c;
        return res;
    });
    return res;
}

function mkReq(user, over = {}) {
    return {
        user,
        params: {},
        query: {},
        body: {},
        method: 'GET',
        originalUrl: '/reports/dept-brief/1',
        flash: jest.fn(),
        get: jest.fn(() => null),
        csrfToken: () => 'tok',
        // Return the fallback so assertions read the real sentence, not the key.
        t: (k, o) => (o && o.defaultValue) || k,
        ...over,
    };
}

const MANAGER = { id: 136, userType: 'manager' };
const OTHER_MANAGER = { id: 999, userType: 'manager' };
const SUPERADMIN = { id: 666, userType: 'admin', role: 'superadmin' };
const LOCAL_ADMIN = { id: 32, userType: 'admin', role: 'admin' };

function archivedRow(over = {}) {
    return {
        id: 4,
        cadence: 'quarterly',
        period: '2026-Q2',
        recipientType: 'employee',
        recipientId: 136,
        periodStart: new Date('2026-04-01T00:00:00Z'),
        periodEnd: new Date('2026-07-01T00:00:00Z'),
        scopeSignature: 'abc123',
        scopeSize: 15,
        isEmpty: false,
        computedAt: new Date('2026-09-13T00:00:00Z'),
        sentAt: null,
        payload: { units: [{ departmentId: 11 }], blocks: { A: [], B: [], C: [] } },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({});
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockService.rosterGrid.mockResolvedValue([
        { departmentId: 11, unitName: 'Riverside / IT', headcount: 15, totalHeadcount: 36 },
    ]);
    mockService.directReportIds.mockResolvedValue([]);
    mockRbacScope.scopedEmployeeIds.mockResolvedValue([1, 2, 3]);
});

// ---------------------------------------------------------------------------
// GUARD 1 — ownership
// ---------------------------------------------------------------------------

describe('guard 1 — a brief is served only to the recipient it was addressed to', () => {
    test('another recipient’s brief is refused with a 403 and a sentence, never a blank page', async () => {
        mockDb.get.mockResolvedValue(archivedRow({ recipientId: 138 }));
        const req = mkReq(MANAGER, { params: { id: '4' } });
        const res = mkRes();
        const next = jest.fn();

        await C.show(req, res, next);

        expect(res.render).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
        const err = next.mock.calls[0][0];
        expect(err.status).toBe(403);
        // `expose` is what keeps the sentence readable on a production appliance:
        // a refusal the reader cannot understand looks like an outage.
        expect(err.expose).toBe(true);
        expect(err.message).toMatch(/quelqu/);
    });

    test('an admin recipient id never collides with an employee recipient id', async () => {
        // The two id spaces overlap (employees 84..68963, admins 1..666), so the
        // TYPE is half of the key. An admin #136 must not read employee #136's brief.
        mockDb.get.mockResolvedValue(archivedRow({ recipientType: 'employee', recipientId: 136 }));
        const req = mkReq({ id: 136, userType: 'admin', role: 'admin' }, { params: { id: '4' } });
        const res = mkRes();
        const next = jest.fn();

        await C.show(req, res, next);

        expect(next.mock.calls[0][0].status).toBe(403);
    });

    test('a SuperAdmin may read another recipient’s brief', async () => {
        mockDb.get.mockResolvedValue(archivedRow());
        mockRbacScope.scopedEmployeeIds.mockResolvedValue(null); // unrestricted
        const req = mkReq(SUPERADMIN, { params: { id: '4' } });
        const res = mkRes();
        const next = jest.fn();

        await C.show(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.rendered.view).toBe('pages/reports/dept-brief-show');
        // …but never recompute it: that would have to resolve somebody ELSE's
        // scope, and this controller never fabricates a principal.
        expect(res.rendered.locals.canRecompute).toBe(false);
    });

    test('a missing brief is a 404, not a 403 and not a 500', async () => {
        mockDb.get.mockResolvedValue(null);
        const next = jest.fn();
        await C.show(mkReq(MANAGER, { params: { id: '4242' } }), mkRes(), next);
        expect(next.mock.calls[0][0].status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// GUARD 2 — scope replayed at read time
// ---------------------------------------------------------------------------

describe('guard 2 — the reader’s scope is re-resolved on every open', () => {
    test('a department the reader no longer covers refuses the whole row', async () => {
        // The archive says the brief covered departments 11 and 19; the reader's
        // LIVE scope covers only 11 — an admin scope revoked or expired since,
        // or a sub-tree that shrank.
        mockDb.get.mockResolvedValue(
            archivedRow({ payload: { units: [{ departmentId: 11 }, { departmentId: 19 }] } })
        );
        const next = jest.fn();
        const res = mkRes();

        await C.show(mkReq(MANAGER, { params: { id: '4' } }), res, next);

        expect(res.render).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0].status).toBe(403);
        expect(next.mock.calls[0][0].message).toMatch(/périmètre/);
    });

    test('the same row is served when every department is still covered', async () => {
        mockDb.get.mockResolvedValue(archivedRow());
        const next = jest.fn();
        const res = mkRes();

        await C.show(mkReq(MANAGER, { params: { id: '4' } }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.rendered.view).toBe('pages/reports/dept-brief-show');
    });

    test('an emptied scope refuses — `[]` means NOTHING, never "everything"', async () => {
        // The sentinel matters: middleware/rbac.js only carries a `-1` because
        // downstream an empty array used to mean "no filter".
        mockDb.get.mockResolvedValue(archivedRow());
        mockRbacScope.scopedEmployeeIds.mockResolvedValue([]);
        mockService.rosterGrid.mockResolvedValue([]);
        const next = jest.fn();
        const res = mkRes();

        await C.show(mkReq(LOCAL_ADMIN, { params: { id: '4' } }), res, next);

        expect(res.render).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0].status).toBe(403);
    });

    test('the deep link from a notification gets the same treatment', async () => {
        // "The notification exists" proves nothing: it was written when the scope
        // was wider, which is exactly the case this guard is for.
        mockDb.get.mockResolvedValue(archivedRow({ payload: { units: [{ departmentId: 19 }] } }));
        const next = jest.fn();
        await C.show(
            mkReq(MANAGER, { params: { id: '4' }, originalUrl: '/notifications/12/go' }),
            mkRes(),
            next
        );
        expect(next.mock.calls[0][0].status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// GUARD 3 — no name is stored; names are re-resolved live
// ---------------------------------------------------------------------------

describe('guard 3 — names are re-resolved from today’s DIRECT reports', () => {
    const payloadWithNames = () => ({
        units: [{ departmentId: 11 }],
        blocks: {
            A: [],
            B: [],
            C: [{ id: 'C1b', lines: [{ employeeId: 144 }, { employeeId: 146 }] }],
        },
    });

    test('only a person who is STILL a direct report today is named', async () => {
        mockService.directReportIds.mockResolvedValue([144]); // 146 has moved away
        mockDb.all.mockResolvedValue([{ employeeId: 144, fullName: 'A. NOVAK' }]);
        const scope = { type: 'employee', id: 136, ids: [144, 146], unrestricted: false };

        const names = await T.resolveNames(scope, payloadWithNames());

        expect(names.byId).toEqual({ 144: 'A. NOVAK' });
        expect(names.withheld).toBe(1);
        expect(mockService.directReportIds).toHaveBeenCalledWith(136);
    });

    test('an ADMIN reader is never given a name, however wide their scope', async () => {
        const scope = { type: 'admin', id: 32, ids: [144, 146], unrestricted: false };
        const names = await T.resolveNames(scope, payloadWithNames());
        expect(names.byId).toEqual({});
        expect(names.allowed).toBe(false);
        expect(names.withheld).toBe(2);
        // The whole-sub-tree resolver must not even be consulted for an admin.
        expect(mockService.directReportIds).not.toHaveBeenCalled();
    });

    test('a direct report who has left the reader’s data scope is still withheld', async () => {
        mockService.directReportIds.mockResolvedValue([144, 146]);
        const scope = { type: 'employee', id: 136, ids: [144], unrestricted: false };
        mockDb.all.mockResolvedValue([{ employeeId: 144, fullName: 'A. NOVAK' }]);
        const names = await T.resolveNames(scope, payloadWithNames());
        expect(Object.keys(names.byId)).toEqual(['144']);
        expect(names.withheld).toBe(1);
    });

    test('the payload itself must never be asked for a name', () => {
        // The archive stores aggregates and unit ids. A frozen name cannot be
        // re-authorised later, which is why none is frozen — the view therefore
        // reads names ONLY from `names.byId`.
        expect(SHOW_CODE).toMatch(/names\s*&&\s*names\.byId/);
        expect(SHOW_CODE).not.toMatch(/l\.fullName|l\.employeeName|line\.name\b/);
    });
});

// ---------------------------------------------------------------------------
// The page never recomputes
// ---------------------------------------------------------------------------

describe('the page renders the frozen payload', () => {
    test('show() never calls buildPayload', async () => {
        mockDb.get.mockResolvedValue(archivedRow());
        const res = mkRes();
        await C.show(mkReq(MANAGER, { params: { id: '4' } }), res, jest.fn());
        expect(mockService.buildPayload).not.toHaveBeenCalled();
        expect(res.rendered.locals.payload).toEqual(archivedRow().payload);
        expect(res.rendered.locals.today).toBeNull();
    });

    test('recompute() adds a SEPARATE column and leaves the archive untouched', async () => {
        mockDb.get.mockResolvedValue(archivedRow());
        const res = mkRes();
        await C.recompute(mkReq(MANAGER, { params: { id: '4' }, method: 'POST' }), res, jest.fn());

        expect(mockService.buildPayload).toHaveBeenCalledTimes(1);
        // The frozen payload still goes to the view unchanged, beside the new one.
        expect(res.rendered.locals.payload).toEqual(archivedRow().payload);
        expect(res.rendered.locals.today).toBeTruthy();
        // NOTHING is written: no UPDATE, no INSERT on dept_briefs.
        const writes = mockDb.run.mock.calls.map((c) => String(c[0]));
        expect(writes.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
    });

    test('recompute() is refused to a reader who is not the recipient', async () => {
        mockDb.get.mockResolvedValue(archivedRow());
        mockRbacScope.scopedEmployeeIds.mockResolvedValue(null);
        const next = jest.fn();
        const res = mkRes();
        await C.recompute(mkReq(SUPERADMIN, { params: { id: '4' }, method: 'POST' }), res, next);
        expect(mockService.buildPayload).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0].status).toBe(403);
    });

    test('recompute() resolves the SESSION identity, never the archive row’s', async () => {
        mockDb.get.mockResolvedValue(archivedRow());
        await C.recompute(
            mkReq(MANAGER, { params: { id: '4' }, method: 'POST' }),
            mkRes(),
            jest.fn()
        );
        const [recipient, cadence] = mockService.buildPayload.mock.calls[0];
        expect(recipient).toEqual({ type: 'employee', id: 136, role: null });
        expect(cadence).toBe('quarterly');
        expect(mockRbacScope.scopedEmployeeIds).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// The list, and `?dept=`
// ---------------------------------------------------------------------------

describe('the list', () => {
    test('`?dept=` outside the scope says so and still lists — an empty table is itself a signal', async () => {
        const res = mkRes();
        await C.list(mkReq(MANAGER, { query: { dept: '19' } }), res);
        expect(res.rendered.locals.deptOutOfScope).toBe(true);
        expect(res.rendered.locals.filters.dept).toBe('');
        // …and no containment filter was pushed into the query.
        const sql = String(mockDb.all.mock.calls[0][0]);
        expect(sql).not.toMatch(/@>/);
    });

    test('`?dept=` inside the scope filters on the FROZEN unit list', async () => {
        const res = mkRes();
        await C.list(mkReq(MANAGER, { query: { dept: '11' } }), res);
        const sql = String(mockDb.all.mock.calls[0][0]);
        expect(sql).toMatch(/payload -> 'units' @> \?::jsonb/);
    });

    test('a non-SuperAdmin only ever lists their own rows', async () => {
        const res = mkRes();
        await C.list(mkReq(MANAGER), res);
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(String(sql)).toMatch(/recipient_type = \? AND recipient_id = \?/);
        expect(params.slice(0, 2)).toEqual(['employee', 136]);
    });

    test('a rubbish cadence or period is dropped, not passed through', async () => {
        const res = mkRes();
        await C.list(mkReq(MANAGER, { query: { cadence: "'; DROP", period: '../../etc' } }), res);
        const [sql] = mockDb.all.mock.calls[0];
        expect(String(sql)).not.toMatch(/cadence = \?/);
        expect(String(sql)).not.toMatch(/period = \?/);
    });
});

// ---------------------------------------------------------------------------
// Cadence preferences
// ---------------------------------------------------------------------------

describe('the four cadence checkboxes', () => {
    test('ON and OFF are both written explicitly', async () => {
        // An unchecked checkbox posts nothing. If OFF were left unwritten, the
        // missing row would fall back to the default and silently switch the
        // cadence back on at the next tick.
        const req = mkReq(MANAGER, { method: 'POST', body: { weekly: 'on', yearly: 'on' } });
        const res = mkRes();
        await C.savePrefs(req, res);

        const written = mockDb.run.mock.calls.map((c) => ({ cadence: c[1][2], enabled: c[1][3] }));
        expect(written).toEqual([
            { cadence: 'weekly', enabled: true },
            { cadence: 'monthly', enabled: false },
            { cadence: 'quarterly', enabled: false },
            { cadence: 'yearly', enabled: true },
        ]);
        expect(String(mockDb.run.mock.calls[0][0])).toMatch(
            /ON CONFLICT \(recipient_type, recipient_id, cadence\)/
        );
    });

    test('they are written on the SESSION identity', async () => {
        await C.savePrefs(mkReq(LOCAL_ADMIN, { method: 'POST', body: {} }), mkRes());
        expect(mockDb.run.mock.calls[0][1].slice(0, 2)).toEqual(['admin', 32]);
    });

    test('weekly is OFF by default for an employee and ON for an admin', async () => {
        // §4.8: every governing employee already receives manager-digest every
        // Monday with A1, A5, B1, C1, C2 and the footer; admins receive no weekly
        // message at all.
        await expect(T.defaultFor('weekly', 'employee')).resolves.toBe(false);
        await expect(T.defaultFor('weekly', 'admin')).resolves.toBe(true);
        await expect(T.defaultFor('monthly', 'employee')).resolves.toBe(true);
    });

    test('the global switch wins over the per-type default', async () => {
        mockSettings.getValue.mockImplementation(async (k) =>
            k === 'deptBriefYearlyEnabled' ? 'false' : true
        );
        await expect(T.defaultFor('yearly', 'admin')).resolves.toBe(false);
    });

    test('a settings failure never takes the surface down', async () => {
        mockSettings.getValue.mockRejectedValue(new Error('boom'));
        await expect(T.defaultFor('monthly', 'admin')).resolves.toBe(true);
    });

    test('a stored row wins over the default, and says it is explicit', async () => {
        mockDb.all.mockResolvedValue([{ cadence: 'weekly', enabled: true }]);
        const prefs = await T.prefsFor({ type: 'employee', id: 136 });
        expect(prefs.weekly).toEqual({ enabled: true, source: 'explicit' });
        expect(prefs.monthly).toEqual({ enabled: true, source: 'default' });
    });

    test('attachPrefs never takes the shared notifications page down', async () => {
        mockDb.all.mockRejectedValue(new Error('db gone'));
        const res = mkRes();
        const next = jest.fn();
        await C.attachPrefs(mkReq(MANAGER), res, next);
        expect(res.locals.deptBriefPrefs).toBeNull();
        expect(next).toHaveBeenCalled();
    });

    test('attachPrefs does nothing on a non-GET', async () => {
        const res = mkRes();
        await C.attachPrefs(mkReq(MANAGER, { method: 'POST' }), res, jest.fn());
        expect(res.locals.deptBriefPrefs).toBeUndefined();
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Wiring — the routes, in ONE contiguous block, in the right ORDER
// ---------------------------------------------------------------------------

describe('routes', () => {
    const block = (() => {
        const a = ROUTES_SRC.indexOf('// ---- LOT BILAN B3');
        const b = ROUTES_SRC.indexOf('// ---- end LOT BILAN B3 ----');
        return a >= 0 && b > a ? ROUTES_SRC.slice(a, b) : '';
    })();

    test('the four routes live in ONE contiguous B3 block', () => {
        expect(block).toBeTruthy();
        expect(block).toMatch(/router\.get\(\s*'\/reports\/dept-brief',\s*requireManagerOrAdmin/);
        expect(block).toMatch(
            /router\.get\(\s*'\/reports\/dept-brief\/:id',\s*requireManagerOrAdmin/
        );
        expect(block).toMatch(
            /router\.post\(\s*'\/reports\/dept-brief\/:id\/recompute',\s*requireManagerOrAdmin/
        );
        // The preference route is requireAuth ONLY: it is the one surface the
        // three audiences share, and nobody may be denied the ability to switch a
        // message off.
        expect(block).toMatch(/router\.post\(\s*'\/account\/dept-brief-prefs',\s*requireAuth,/);
        expect(block).not.toMatch(/dept-brief-prefs',\s*requireManagerOrAdmin/);
    });

    test('the list route is registered BEFORE the :id route', () => {
        expect(block.indexOf("'/reports/dept-brief'")).toBeLessThan(
            block.indexOf("'/reports/dept-brief/:id'")
        );
    });

    test('attachPrefs is mounted BEFORE /account/notifications, or it never fires', () => {
        // Express runs layers in registration order. Mounted after that route the
        // provider would never run and the four checkboxes could not render their
        // real state server-side.
        // Located by expression: prettier moves the path onto its own line when
        // the registration overflows, and an exact one-line `indexOf` then
        // returns -1 — which compares as "mounted first" and passed by accident.
        const mw = ROUTES_SRC.search(/router\.use\(\s*'\/account\/notifications'/);
        const page = ROUTES_SRC.search(/router\.get\(\s*'\/account\/notifications'/);
        expect(mw).toBeGreaterThan(-1);
        expect(page).toBeGreaterThan(-1);
        expect(mw).toBeLessThan(page);
    });

    test('the deep link KIND_META promises (/reports/dept-brief) is really mounted', () => {
        // tests/unit/notificationKinds.test.js checks the same thing from the
        // other side; this is the route's own half of the contract.
        expect(ROUTES_SRC).toMatch(/router\.get\(\s*'\/reports\/dept-brief'/);
    });

    test('the :id routes reject a non-numeric identifier before any bigint query', () => {
        expect(block).toMatch(/requireNumericParam\('id'\)/);
    });
});

// ---------------------------------------------------------------------------
// Views — one language per session, four display states, no fabricated zero
// ---------------------------------------------------------------------------

describe('the views', () => {
    test('every visible string is a locale key — no bilingual concatenation', () => {
        // The email is FR-primary + EN grey because the schema has no per-user
        // language column. The PAGE localises itself at READ time; mixing the two
        // regimes is what printed « Fréquence / Frequency » on the schedules card.
        for (const src of [LIST_CODE, SHOW_CODE]) {
            expect(src).not.toMatch(/Fréquence\s*\/\s*Frequency/);
            // No hardcoded French sentence in an output tag.
            expect(src).not.toMatch(/<%=\s*'[^']*[éèêàçù][^']*'\s*%>/);
        }
    });

    test('a figure is printed from the frozen cell, never recomputed or re-coloured', () => {
        expect(SHOW_CODE).toMatch(/L\(v\.text\)/);
        expect(SHOW_CODE).toMatch(/v\.color \|\| 'inherit'/);
        // `|| 0` in a display path turns an unknown into a bad score — the live
        // defect at dept-digest.js:163. It must not exist here.
        expect(SHOW_CODE).not.toMatch(/\.value\s*\|\|\s*0/);
        // No threshold arithmetic of the view's own on a possibly-null value.
        expect(SHOW_CODE).not.toMatch(/>=\s*80/);
    });

    test('the two mandatory fixed footers are rendered', () => {
        expect(SHOW_CODE).toMatch(/reports:db_frozen_note/);
        expect(SHOW_CODE).toMatch(/payload\.disclaimer/);
        expect(SHOW_CODE).toMatch(/payload\.natureOfFigures/);
    });

    test('period bounds use fmtPeriodBound (UTC), never toISOString().slice', () => {
        for (const src of [LIST_CODE, SHOW_CODE]) {
            expect(src).toMatch(/fmtPeriodBound\(/);
            expect(src).not.toMatch(/toISOString\(\)\.slice/);
        }
        expect(CTRL_CODE).toMatch(/fmtPeriodBound/);
    });

    test('the four cadence checkboxes are on the shared preferences page', () => {
        expect(NOTIF_EJS).toMatch(/action="\/account\/dept-brief-prefs"/);
        // The four boxes are one loop over the cadence list; the input name IS
        // the cadence, which is what savePrefs reads from the body.
        expect(NOTIF_EJS).toMatch(/\['weekly', 'monthly', 'quarterly', 'yearly'\]\.forEach/);
        expect(NOTIF_EJS).toMatch(/type="checkbox" name="<%= c %>"/);
        expect(NOTIF_EJS).toMatch(/deptBriefPrefs\[c\]\.enabled \? 'checked' : ''/);
        // Its own submit button: silencing the yearly brief must not resave quiet
        // hours as a side effect.
        expect(NOTIF_EJS).toMatch(/reports:db_prefs_save/);
    });

    test('« Gérer la fréquence de ce bilan » links both pages to the preferences', () => {
        expect(LIST_CODE).toMatch(/reports:db_manage_frequency/);
        expect(SHOW_CODE).toMatch(/reports:db_manage_frequency/);
        expect(NOTIF_EJS).toMatch(/id="dept-brief-prefs"/);
    });

    test('the schedules card is untouched apart from its help sentence', () => {
        expect(SCHED_EJS).toMatch(/__\('admin:dg_help'\)/);
        // The subscription controls themselves are left exactly as they were.
        expect(SCHED_EJS).toMatch(/id="dg-subscribe"/);
        expect(SCHED_EJS).toMatch(/id="dg-freq"/);
    });
});

// ---------------------------------------------------------------------------
// Locales — FR and EN, in the same pass
// ---------------------------------------------------------------------------

describe('locales', () => {
    const fr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/fr/reports.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/reports.json'), 'utf8'));
    const frAdmin = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/fr/admin.json'), 'utf8'));
    const enAdmin = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/admin.json'), 'utf8'));

    test('every reports:db_* key exists in BOTH languages', () => {
        const frKeys = Object.keys(fr)
            .filter((k) => k.startsWith('db_'))
            .sort();
        const enKeys = Object.keys(en)
            .filter((k) => k.startsWith('db_'))
            .sort();
        expect(frKeys.length).toBeGreaterThan(40);
        expect(frKeys).toEqual(enKeys);
    });

    test('no key is left as its own French text in the English file', () => {
        // A one- or two-word label ("Cadence", "Actions", "Volume") legitimately
        // coincides in the two languages. A SENTENCE that is byte-identical is an
        // untranslated paste — that is the thing worth failing on.
        const identicalSentences = [];
        for (const k of Object.keys(fr).filter((x) => x.startsWith('db_'))) {
            expect(en[k]).toBeTruthy();
            if (en[k] !== fr[k]) continue;
            if (String(fr[k]).trim().split(/\s+/).length > 2) identicalSentences.push(k);
        }
        expect(identicalSentences).toEqual([]);
    });

    test('every reports:db_* key the two views use is defined', () => {
        const used = new Set();
        for (const src of [LIST_EJS, SHOW_EJS, NOTIF_EJS]) {
            for (const m of src.matchAll(/reports:(db_[a-zA-Z0-9_]+)/g)) used.add(m[1]);
        }
        // Two families are built by concatenation (`'db_cadence_' + c`,
        // `'db_m_' + key`); the bare prefixes the regex catches are not keys, and
        // the families themselves are covered by the two tests below.
        used.delete('db_cadence_');
        used.delete('db_m_');
        for (const c of ['weekly', 'monthly', 'quarterly', 'yearly']) used.add('db_cadence_' + c);
        const missing = [...used].filter((k) => !(k in fr) || !(k in en));
        expect(missing).toEqual([]);
    });

    test('every metric key the frozen payload can carry has a label', () => {
        // These are the cell-bearing keys DeptBriefService puts on its lines; a
        // missing one prints the raw identifier on a French page.
        const metrics = [
            'count',
            'oldestAge',
            'age',
            'toActivate',
            'ending',
            'milestoneMissed',
            'toCountersign',
            'noGovernance',
            'adminAsManager',
            'state',
            'notStarted',
            'actions',
            'soleHolder',
            'noQualified',
            'expiring',
            'expired',
            'expiringSoon',
            'expiringLater',
            'breaches',
            'predicted',
            'gaps',
            'newlyHigh',
            'd1Coverage',
            'd2Readiness',
            'd3Completion',
            'd3Met',
            'd4Critical',
            'd5MeasuredPeople',
            'value',
            'coverage',
            'completion',
            'measuredPeople',
        ];
        for (const m of metrics) {
            expect(fr['db_m_' + m]).toBeTruthy();
            expect(en['db_m_' + m]).toBeTruthy();
        }
    });

    test('admin:dg_help now points at the preference page, in both languages', () => {
        // §7 row 15: the department brief is PUSHED — it needs no subscription —
        // and its cadence lives on « Mon compte → Notifications ».
        expect(frAdmin.dg_help).toMatch(/Notifications/);
        expect(frAdmin.dg_help).toMatch(/bilan/i);
        expect(enAdmin.dg_help).toMatch(/Notifications/);
        expect(enAdmin.dg_help).toMatch(/brief/i);
        expect(frAdmin.dg_help).not.toBe(enAdmin.dg_help);
    });
});

// ---------------------------------------------------------------------------
// The controller's own non-negotiables
// ---------------------------------------------------------------------------

describe('the controller', () => {
    test('scope comes from the SESSION, never from the archive row', () => {
        expect(CTRL_CODE).toMatch(/scopedEmployeeIds\(req\.user\)/);
        // A principal rebuilt from `row.recipientId` would serve somebody else's
        // brief through somebody else's scope.
        expect(CTRL_CODE).not.toMatch(/row\.recipientId[^)]*userType/);
        expect(CTRL_CODE).not.toMatch(/scopeOf\(\s*\{[^}]*row\./);
    });

    test('the forbidden wide scopes are never consulted', () => {
        // adminScope hands a department-scoped admin the PARENT SITE id so their
        // dropdowns render; using those as a data filter is guaranteed
        // over-disclosure.
        for (const banned of [
            'siteIds',
            'departmentIds',
            'serviceIds',
            'getReadinessByGroup',
            'getOverviewKPIs',
            'GovernanceService',
        ]) {
            expect(CTRL_CODE).not.toMatch(new RegExp(banned));
        }
    });

    test('a refusal is a 403 with an exposed sentence, never a redirect to a blank page', () => {
        expect(CTRL_CODE).toMatch(/err\.status = 403/);
        expect(CTRL_CODE).toMatch(/err\.expose = true/);
    });
});
