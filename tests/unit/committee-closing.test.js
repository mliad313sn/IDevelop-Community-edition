'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Product-readiness committee — LOT X (closing lot).
 *
 * Every finding was reproduced by execution on idevelop (rolled-back
 * transactions, or an in-process express app / an own server on :3151 for the
 * HTTP items) before the fix and re-proved after it. The DB is mocked here;
 * the tests lock the CONTRACT each fix established.
 *
 *  X1  A record VOIDED as created-in-error (MaintenanceService: cancelled_at +
 *      cancel_reason, reversible) rendered on /employees?status=inactive with
 *      the same "Sorti" badge as a departed employee; the profile showed no
 *      marker at all; DSRService.export omitted the state. (probe: voided
 *      employee 290 in a rolled-back tx -> list/show rows carried cancelledAt,
 *      the views ignored it; export profile had no cancelledAt/cancelReason)
 *  X2  asyncHandler ignored err.status: IDPService.signOff's 409 IDP_NOT_DRAFT
 *      (expose=true) rendered a 500 page for an HTML form POST and a 500 JSON
 *      for XHR. (A/B: 500/500 before -> 302 back + flash / 409 {ok:false,code}
 *      after; HTTP on :3151, plan 6 flipped active: 302 -> /v2/idp/6 + flash)
 *      The detail page also rendered the sign form on a non-draft plan.
 *  X3  rbac.denyScope keyed on xhr/Accept only: the app's own fetch() (JSON
 *      body, no Accept) received the HTML 403 page. (A/B: 403 text/html ->
 *      403 application/json)
 *  X4  SetupController and GovernanceService counted "no reviewer" with the
 *      NULL-column predicate while the worklist used "no ACTIVE, non-voided
 *      supervisor/manager". (probe: one person re-pointed at an inactive
 *      supervisor -> worklist 7, setup 6, governance 6; after: 7/7/7)
 *  X5  coaching console "cancel" files a cancellation REQUEST (two-person
 *      rule) but its label still read "Annuler"/"Cancel".
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '../..');
const VIEWS = path.join(ROOT, 'views');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
    withActor: jest.fn(),
    pool: { connect: jest.fn() },
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/utils/ttlCache', () => ({
    dashboardCache: { bust: jest.fn() },
    TtlCache: class {
        get() {
            return undefined;
        }
        set() {}
        delete() {}
        clear() {}
    },
}));
// middleware/auth is loaded for its REAL wantsJson (the shared caller test);
// the passport/strategy wiring around it is stubbed so nothing touches a DB.
jest.mock('../../src/models/AdminModel', () => ({
    findById: jest.fn(),
    findByUsername: jest.fn(),
}));
jest.mock('../../src/services/AuthService', () => ({ verifyPassword: jest.fn() }));
jest.mock('../../src/services/EmployeeAuthService', () => ({ verifyPassword: jest.fn() }));
jest.mock('../../src/middleware/rateLimiter', () => ({ recordLoginAttempt: jest.fn() }));
jest.mock('../../src/services/RBACService', () => ({
    canAccessEmployee: jest.fn(async () => false),
    canAccessEmployeeData: jest.fn(async () => false),
    canAccessSite: jest.fn(async () => false),
    canAccessDepartment: jest.fn(async () => false),
    canAccessService: jest.fn(async () => false),
    isSuperAdmin: (u) => u && u.userType === 'admin' && u.role === 'superadmin',
    getFilteredEmployees: jest.fn(async () => []),
    adminsWithPermission: jest.fn(async () => []),
}));

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
});

// A minimal express-like res/req pair for the middleware/handler tests.
function fakeRes() {
    const res = {
        headersSent: false,
        statusCode: 200,
        body: null,
        rendered: null,
        redirected: null,
        jsonBody: null,
    };
    res.status = (s) => {
        res.statusCode = s;
        return res;
    };
    res.json = (b) => {
        res.jsonBody = b;
        return res;
    };
    res.render = (view, locals, cb) => {
        res.rendered = { view, locals };
        if (cb) cb(null, '<html>');
        return res;
    };
    res.redirect = (url) => {
        res.redirected = url;
        return res;
    };
    res.send = (b) => {
        res.body = b;
        return res;
    };
    return res;
}
function fakeReq(headers = {}, extra = {}) {
    const req = {
        method: 'POST',
        path: '/v2/idp/5/sign',
        originalUrl: '/v2/idp/5/sign',
        headers,
        xhr: false,
        flashes: [],
        params: {},
        body: {},
        query: {},
    };
    req.flash = (k, v) => req.flashes.push([k, v]);
    req.get = (h) => headers[String(h).toLowerCase()];
    req.t = (k) => k;
    return Object.assign(req, extra);
}
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// X1 — voided / erased / leaver are three distinct, legible states
// ---------------------------------------------------------------------------
describe('X1 — a voided record is never shown as a departure', () => {
    const fr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/fr/admin.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/admin.json'), 'utf8'));
    const __ = (k, o) => {
        const [ns, key] = k.split(':');
        let s = (ns === 'admin' && fr[key]) || k;
        if (o) for (const [a, b] of Object.entries(o)) s = s.replace(`{{${a}}}`, b);
        return s;
    };
    const base = {
        id: 290,
        firstName: 'Boubacar',
        lastName: 'Marte',
        employeeNumber: 'E290',
        roleName: 'r',
        siteName: 's',
        departmentName: 'd',
        serviceName: 'sv',
    };
    const states = {
        leaver: { ...base, isActive: false, cancelledAt: null, erasedAt: null },
        voided: {
            ...base,
            isActive: false,
            cancelledAt: '2026-09-09T12:00:00Z',
            cancelReason: 'Doublon de E123',
            erasedAt: null,
        },
        erased: { ...base, isActive: false, cancelledAt: null, erasedAt: '2026-09-09T12:00:00Z' },
        active: { ...base, isActive: true, cancelledAt: null, erasedAt: null },
    };
    const locals = {
        lang: 'fr',
        cspNonce: 'n',
        assetVersion: 'v',
        csrfToken: 'c',
        __,
        can: () => true,
        title: 't',
        breadcrumbs: [],
        user: { userType: 'admin', role: 'superadmin' },
        supervisorCandidates: [],
        sites: [],
        filters: {},
        query: {},
        totalEmployees: 1,
        page: 1,
        totalPages: 1,
        perPage: 20,
        status: 'inactive',
        search: '',
        siteId: '',
        missingReviewer: false,
        canManageAccess: false,
        isSuperAdmin: true,
        linkedAdmin: null,
        identities: [],
        passwordDisabled: false,
    };
    const render = (view, emp) =>
        ejs.renderFile(
            path.join(VIEWS, view),
            { ...locals, employees: [emp], employee: emp },
            { views: [VIEWS] }
        );
    // The employee row (class is '' or 'emp-inactive'); the site-separator and
    // empty-row <tr>s carry other classes.
    const rowOf = (html) => (html.match(/<tr class="(?:emp-inactive)?">[\s\S]*?<\/tr>/) || [''])[0];

    test('the FR/EN keys exist with parity', () => {
        for (const k of [
            'emp_record_status',
            'emp_record_active',
            'emp_voided_badge',
            'emp_voided_title',
            'emp_voided_reason',
            'emp_voided_on',
            'emp_erased_badge',
            'emp_erased_title',
        ]) {
            expect(typeof fr[k]).toBe('string');
            expect(typeof en[k]).toBe('string');
        }
        expect(fr.emp_voided_badge).toBe('Fiche annulée (créée par erreur)');
        expect(en.emp_voided_badge).toBe('Record voided (created in error)');
        expect(fr.emp_inactive_badge).toBe('Sorti'); // leavers keep their badge
    });

    test('list: a leaver wears "Sorti"; a voided record wears the void badge + reason, never "Sorti"', async () => {
        const leaver = rowOf(await render('pages/employees/index.ejs', states.leaver));
        expect(leaver).toContain('data-record-state="inactive"');
        expect(leaver).toContain('>Sorti<');
        expect(leaver).not.toContain('Fiche annulée');

        const voided = rowOf(await render('pages/employees/index.ejs', states.voided));
        expect(voided).toContain('data-record-state="voided"');
        expect(voided).toContain('Fiche annulée (créée par erreur)');
        expect(voided).toContain('Motif : Doublon de E123');
        expect(voided).not.toContain('>Sorti<');

        const erased = rowOf(await render('pages/employees/index.ejs', states.erased));
        expect(erased).toContain('data-record-state="erased"');
        expect(erased).toContain('Données effacées (RGPD)');
        expect(erased).not.toContain('>Sorti<');
        expect(erased).not.toContain('Fiche annulée');
    });

    test('profile: the record state row names the state, with date + reason for a void', async () => {
        const voided = await render('pages/employees/show.ejs', states.voided);
        expect(voided).toContain('data-record-state="voided"');
        expect(voided).toContain('Fiche annulée (créée par erreur)');
        expect(voided).toContain('Motif : Doublon de E123');
        expect(voided).toMatch(/Annulée le \d+ \S+ 2026/);
        expect(voided).not.toContain('>Sorti<');

        const leaver = await render('pages/employees/show.ejs', states.leaver);
        expect(leaver).toContain('data-record-state="inactive"');
        expect(leaver).toContain('>Sorti<');

        const erased = await render('pages/employees/show.ejs', states.erased);
        expect(erased).toContain('data-record-state="erased"');
        expect(erased).toContain('Données effacées (RGPD)');

        const active = await render('pages/employees/show.ejs', states.active);
        expect(active).toContain('data-record-state="active"');
        expect(active).toContain('Fiche active');
    });

    test('DSRService.export carries is_active, cancelled_at, cancel_reason and erased_at in the profile', async () => {
        const DSRService = require('../../src/services/DSRService');
        mockDb.get.mockResolvedValue({ id: 290, cancelledAt: '2026-09-09', cancelReason: 'dup' });
        const out = await DSRService.export(290);
        const [sql] = mockDb.get.mock.calls[0];
        expect(sql).toMatch(/FROM employees WHERE id = \?/);
        for (const col of ['is_active', 'cancelled_at', 'cancel_reason', 'erased_at'])
            expect(sql).toContain(col);
        expect(out.profile.cancelReason).toBe('dup');
    });
});

// ---------------------------------------------------------------------------
// X2 — a domain 4xx is answered as a 4xx, for HTML and JSON callers
// ---------------------------------------------------------------------------
describe('X2 — asyncHandler answers a service refusal with its status', () => {
    const asyncHandler = require('../../src/utils/asyncHandler');
    const notDraft = () => {
        const e = new Error("Cannot sign IDP #5 from 'active': only a draft plan can be signed.");
        e.code = 'IDP_NOT_DRAFT';
        e.status = 409;
        e.expose = true;
        return e;
    };

    test('HTML form POST: flash + redirect back to the plan (same-origin Referer), not a 500 page', async () => {
        const req = fakeReq({
            'content-type': 'application/x-www-form-urlencoded',
            referer: 'http://app.local/v2/idp/5',
            host: 'app.local',
        });
        const res = fakeRes();
        asyncHandler(async () => {
            throw notDraft();
        })(req, res, () => {});
        await tick();
        expect(res.rendered).toBeNull();
        expect(res.redirected).toBe('/v2/idp/5');
        expect(req.flashes).toEqual([
            ['error', "Cannot sign IDP #5 from 'active': only a draft plan can be signed."],
        ]);
    });

    test('JSON caller (Content-Type only, as the app fetch() sends): the 4xx status with a machine-readable code', async () => {
        const req = fakeReq({ 'content-type': 'application/json' });
        const res = fakeRes();
        asyncHandler(async () => {
            throw notDraft();
        })(req, res, () => {});
        await tick();
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody).toEqual({
            ok: false,
            error: expect.stringContaining('only a draft plan'),
            code: 'IDP_NOT_DRAFT',
        });
    });

    test('403 IDP_SIGNER_MISMATCH follows the same path', async () => {
        const req = fakeReq({ accept: 'application/json' });
        const res = fakeRes();
        asyncHandler(async () => {
            const e = new Error('An administrator cannot sign as the employee party of an IDP.');
            e.code = 'IDP_SIGNER_MISMATCH';
            e.status = 403;
            e.expose = true;
            throw e;
        })(req, res, () => {});
        await tick();
        expect(res.statusCode).toBe(403);
        expect(res.jsonBody.code).toBe('IDP_SIGNER_MISMATCH');
    });

    test('a genuine failure is still a 500 (HTML page / JSON), and a PG 23xxx still a 400', async () => {
        const html = fakeReq({ 'content-type': 'application/x-www-form-urlencoded' });
        const r1 = fakeRes();
        asyncHandler(async () => {
            throw new TypeError('Cannot read properties of undefined');
        })(html, r1, () => {});
        await tick();
        expect(r1.statusCode).toBe(500);
        expect(r1.rendered.view).toBe('pages/error');
        expect(r1.redirected).toBeNull();

        const json = fakeReq({ 'content-type': 'application/json' });
        const r2 = fakeRes();
        asyncHandler(async () => {
            const e = new Error('duplicate key');
            e.code = '23505';
            throw e;
        })(json, r2, () => {});
        await tick();
        expect(r2.statusCode).toBe(400);
        expect(r2.jsonBody).toEqual({ error: 'duplicate key' });

        // a status outside 4xx, or a 4xx with no expose/userMessage/code, is not a domain refusal
        const r3 = fakeRes();
        asyncHandler(async () => {
            const e = new Error('boom');
            e.status = 503;
            e.expose = true;
            throw e;
        })(fakeReq({ 'content-type': 'application/json' }), r3, () => {});
        await tick();
        expect(r3.statusCode).toBe(500);
    });

    test('the IDP detail page renders the sign form ONLY on a draft plan', async () => {
        const locals = {
            lang: 'fr',
            cspNonce: 'n',
            assetVersion: 'v',
            csrfToken: 'c',
            __: (k) => k,
            objectives: [],
            actions: [],
        };
        const draft = await ejs.renderFile(
            path.join(VIEWS, 'pages/idp/detail.ejs'),
            { ...locals, plan: { id: 5, status: 'draft', employeeId: 1 } },
            { views: [VIEWS] }
        );
        const active = await ejs.renderFile(
            path.join(VIEWS, 'pages/idp/detail.ejs'),
            { ...locals, plan: { id: 5, status: 'active', employeeId: 1 } },
            { views: [VIEWS] }
        );
        expect(draft).toContain('action="/v2/idp/5/sign"');
        expect(active).not.toContain('action="/v2/idp/5/sign"');
    });
});

// ---------------------------------------------------------------------------
// X3 — a scope denial on an AJAX action is JSON
// ---------------------------------------------------------------------------
describe('X3 — rbac.denyScope answers the app fetch() with JSON', () => {
    const rbac = require('../../src/middleware/rbac');

    test('JSON body, no Accept, no X-Requested-With -> 403 JSON', async () => {
        const req = fakeReq(
            { 'content-type': 'application/json' },
            { params: { id: '7' }, user: { id: 1, userType: 'admin', role: 'viewer' } }
        );
        const res = fakeRes();
        await rbac.checkEmployeeAccess(req, res, () => {
            throw new Error('must not pass');
        });
        expect(res.statusCode).toBe(403);
        expect(res.jsonBody).toEqual({ error: 'Access denied' });
        expect(res.rendered).toBeNull();
    });

    test('a plain HTML request still gets the 403 page', async () => {
        const req = fakeReq(
            { 'content-type': 'application/x-www-form-urlencoded' },
            { params: { id: '7' }, user: { id: 1, userType: 'admin', role: 'viewer' } }
        );
        const res = fakeRes();
        await rbac.checkEmployeeAccess(req, res, () => {
            throw new Error('must not pass');
        });
        expect(res.statusCode).toBe(403);
        expect(res.rendered.view).toBe('pages/errors/403-permission');
        expect(res.jsonBody).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// X4 — one "no reviewer" rule on all three surfaces
// ---------------------------------------------------------------------------
describe('X4 — the setup checklist and governance counts use the worklist rule', () => {
    const ACTIVE_SUP =
        /sup\.id = e\.supervisor_id AND sup\.is_active = true AND sup\.cancelled_at IS NULL/;
    const ACTIVE_MGR =
        /mgr\.id = e\.manager_id AND COALESCE\(e\.manager_type, 'employee'\) = 'employee'\s+AND mgr\.is_active = true AND mgr\.cancelled_at IS NULL/;
    const NULL_COLUMN =
        /supervisor_id IS NULL\s+AND e\.manager_id IS NULL|supervisor_id IS NULL AND e\.manager_id IS NULL/;

    test('utils/reviewerGapSql.missingReviewerSql is the shared predicate and the worklist uses it', async () => {
        const EmployeeModel = require('../../src/models/EmployeeModel');
        const { missingReviewerSql } = require('../../src/utils/reviewerGapSql');
        const frag = missingReviewerSql('e');
        expect(frag).toMatch(ACTIVE_SUP);
        expect(frag).toMatch(ACTIVE_MGR);
        expect(frag).toContain('e.is_active = true AND e.cancelled_at IS NULL');
        expect(frag).not.toContain('--'); // a comment in a SELECT list breaks GROUP BY expansion
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ cnt: 0 });
        await EmployeeModel.findPageWithOrg({ scopes: null, filters: { missingReviewer: true } });
        const [listSql] = mockDb.all.mock.calls[0];
        expect(listSql).toMatch(ACTIVE_SUP);
    });

    test('SetupController.getChecks counts "no reviewer" with the active-supervisor rule', async () => {
        const SetupController = require('../../src/controllers/SetupController');
        mockDb.get.mockResolvedValue({
            sites: 1,
            departments: 1,
            services: 1,
            skills: 1,
            roles: 1,
            rolesWithReq: 1,
            employees: 77,
            noReviewer: 7,
            noEmail: 0,
            openCycles: 0,
            assessments: 1,
        });
        const { checks } = await SetupController.getChecks();
        const [sql] = mockDb.get.mock.calls[0];
        expect(sql).toMatch(ACTIVE_SUP);
        expect(sql).toMatch(ACTIVE_MGR);
        expect(sql).not.toMatch(NULL_COLUMN);
        expect(checks.find((c) => c.key === 'reviewers')).toMatchObject({
            count: 7,
            done: false,
            href: '/employees?missingReviewer=1',
        });
    });

    test('GovernanceService.coverageSummary / orphanedEmployees / fallbackEmployeeIdsForAdmin use it too', async () => {
        const GovernanceService = require('../../src/services/GovernanceService');
        mockDb.get.mockResolvedValue({ byPerson: 62, byAdmin: 8, orphaned: 7 });
        const cov = await GovernanceService.coverageSummary();
        expect(cov).toEqual({ byPerson: 62, byAdmin: 8, orphaned: 7 });
        const [covSql] = mockDb.get.mock.calls[0];
        expect(covSql).toMatch(ACTIVE_SUP);
        expect(covSql).not.toMatch(NULL_COLUMN);
        expect(covSql).not.toMatch(/supervisor_id IS NOT NULL OR e\.manager_id IS NOT NULL/);

        mockDb.all.mockResolvedValue([]);
        await GovernanceService.orphanedEmployees();
        const [orphSql] = mockDb.all.mock.calls[0];
        expect(orphSql).toMatch(ACTIVE_SUP);
        expect(orphSql).not.toMatch(NULL_COLUMN);

        mockDb.all.mockClear();
        await GovernanceService.fallbackEmployeeIdsForAdmin(3);
        const [fbSql] = mockDb.all.mock.calls[0];
        expect(fbSql).toMatch(ACTIVE_SUP);
        expect(fbSql).not.toMatch(NULL_COLUMN);
    });
});

// ---------------------------------------------------------------------------
// X5 — the coaching cancel button says what it does
// ---------------------------------------------------------------------------
describe('X5 — coaching console cancel label', () => {
    test('btn_cancel reads "Demander l\'annulation" / "Request cancellation" and only the console uses it', () => {
        const fr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/fr/coaching.json'), 'utf8'));
        const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/coaching.json'), 'utf8'));
        expect(fr.btn_cancel).toBe("Demander l'annulation");
        expect(en.btn_cancel).toBe('Request cancellation');
        const console_ = fs.readFileSync(
            path.join(VIEWS, 'pages/coaching/plans-console.ejs'),
            'utf8'
        );
        expect(console_).toContain("__('coaching:btn_cancel')");
        // the button files a cancellation REQUEST, it does not cancel
        expect(console_).toMatch(/this\.api\('\/cancellations','POST'/);
    });
});
