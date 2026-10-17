'use strict';
/**
 * Diversity (DEI) data: self-declaration with explicit consent only
 * (migration 171). Behavioural, through the real /v2/cap router and the real
 * DEIService, with the database, RBAC, settings and audit mocked.
 *
 * Before: POST /v2/cap/dei/:employeeId was manager/admin-only (the employee
 * could not declare), accepted ethnicity and disability, defaulted
 * self_declared to TRUE, recorded no consent and offered no withdrawal.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

jest.mock('../../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireManagerOrAdmin: (req, res, next) => next(),
    requireManagerOrAnyPermission: () => (req, res, next) => next(),
    requireSuperAdmin: (req, res, next) => next(),
    wantsJson: () => true,
}));
jest.mock('../../src/middleware/rateLimiter', () => ({
    writeActionLimiter: (req, res, next) => next(),
}));
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockRbac = {
    isSuperAdmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
    hasPermission: (u, slug) =>
        !!u &&
        u.userType === 'admin' &&
        (u.role === 'superadmin' || (u.permissions || []).includes(slug)),
    getFilteredEmployees: jest.fn(),
};
jest.mock('../../src/services/RBACService', () => mockRbac);
const mockSettings = { values: {}, getValue: jest.fn(), setValue: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);
const mockLog = { log: jest.fn().mockResolvedValue() };
jest.mock('../../src/services/LogService', () => mockLog);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(),
    enqueueBulkInApp: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/services/TalentDepthService', () => ({
    listCalibrations: jest.fn().mockResolvedValue([]),
    listObjectives: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/services/RecognitionService', () => ({
    feed: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/services/SkillsIntelligenceService', () => ({}));
jest.mock('../../src/services/WebhookService', () => ({}));
jest.mock('../../src/services/DSRService', () => ({}));
jest.mock('../../src/services/CopilotService', () => ({}));

const router = require('../../src/routes/v2-capability');
const DEI = require('../../src/services/DEIService');

function invoke(method, routePath, { user, params = {}, body = {}, query = {} }) {
    return new Promise((resolve, reject) => {
        const layer = router.stack.find(
            (l) => l.route && l.route.path === routePath && l.route.methods[method]
        );
        if (!layer) return reject(new Error('no route ' + routePath));
        const flashes = [];
        const req = {
            user,
            params,
            body,
            query,
            headers: { accept: 'application/json' },
            get: () => '',
            method: method.toUpperCase(),
            path: routePath,
            flash: (type, msg) => flashes.push([type, msg]),
        };
        const res = {
            statusCode: 200,
            status(c) {
                this.statusCode = c;
                return this;
            },
            set() {
                return this;
            },
            json(b) {
                resolve({ status: this.statusCode, body: b, flashes });
                return this;
            },
            render(view, locals) {
                resolve({ status: this.statusCode, view, locals, flashes });
            },
            redirect(to) {
                resolve({ status: 302, redirect: to, flashes });
            },
        };
        const handles = layer.route.stack.map((s) => s.handle);
        let i = 0;
        const next = (err) => {
            if (err) return reject(err);
            const h = handles[i++];
            if (!h) return reject(new Error('fell through'));
            try {
                h(req, res, next);
            } catch (e) {
                reject(e);
            }
        };
        next();
    });
}

const SUPER = { userType: 'admin', role: 'superadmin', id: 1 };
const HR = { userType: 'admin', role: 'localadmin', id: 7, permissions: ['edit_employees'] };
const LOCAL = { userType: 'admin', role: 'localadmin', id: 8, permissions: ['view_employees'] };
const MGR = { userType: 'manager', id: 30 };
const EMP = { userType: 'employee', id: 31 };

const sql = (fn) => fn.mock.calls.map((c) => String(c[0]));
const writes = () =>
    [...sql(mockDb.run), ...sql(mockDb.get)].filter((s) => /INSERT|UPDATE|DELETE/i.test(s));

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 31 }, { id: 32 }]);
    mockSettings.values = {};
    mockSettings.getValue.mockImplementation(async (k, d) =>
        k in mockSettings.values ? mockSettings.values[k] : d
    );
    mockSettings.setValue.mockImplementation(async (k, v) => {
        mockSettings.values[k] = v;
    });
});

describe('a manager or an admin can no longer write someone’s demographics', () => {
    test.each([
        ['manager', MGR],
        ['local admin', LOCAL],
        ['HR admin', HR],
        ['SuperAdmin', SUPER],
    ])('%s recording ethnicity or disability → 403 with the explicit message', async (_n, user) => {
        for (const body of [
            { ethnicity: 'zqxEth' },
            { disability: 'true' },
            { disability: false },
        ]) {
            const r = await invoke('post', '/dei/:employeeId', {
                user,
                params: { employeeId: '31' },
                body,
            });
            expect(r.status).toBe(403);
            expect(r.body.code).toBe('dei_sensitive_self_only');
        }
        expect(writes()).toEqual([]);
    });

    test('any other field on someone else’s behalf → 403 self-declared only, nothing written', async () => {
        const r = await invoke('post', '/dei/:employeeId', {
            user: SUPER,
            params: { employeeId: '31' },
            body: { gender: 'female', selfDeclared: true },
        });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('dei_self_declared_only');
        expect(writes()).toEqual([]);
    });
});

describe('the person declares — with explicit consent only', () => {
    test('without the consent box → 400, nothing written', async () => {
        const r = await invoke('post', '/my-diversity', {
            user: EMP,
            body: { gender: 'female', ageBand: '35-44' },
        });
        expect(r.redirect).toBe('/v2/cap/my-diversity');
        expect(r.flashes[0][0]).toBe('error');
        expect(writes()).toEqual([]);
        await expect(DEI.declare(31, { gender: 'female' }, {})).rejects.toMatchObject({
            status: 400,
            code: 'dei_consent_required',
        });
    });

    test('disability needs its OWN consent (accommodation purpose)', async () => {
        await expect(
            DEI.declare(31, { disability: 'true' }, { consent: 'true' })
        ).rejects.toMatchObject({ status: 400, code: 'dei_consent_disability_required' });
        expect(writes()).toEqual([]);
    });

    test('with consent: ledger row (fields + text version) and a trusted self row', async () => {
        mockDb.get.mockImplementation(async (s) =>
            /INSERT INTO dei_consents/.test(s) ? { id: 55 } : { employeeId: 31 }
        );
        const r = await invoke('post', '/my-diversity', {
            user: EMP,
            // A spoofed target in the body is ignored: the actor's own id is used.
            body: {
                employeeId: 99,
                gender: 'female',
                ageBand: '35-44',
                disability: 'true',
                consent: 'true',
                consentDisability: 'on',
            },
        });
        expect(r.flashes[0][0]).toBe('success');
        const supersede = mockDb.run.mock.calls.find((c) => /UPDATE dei_consents/.test(c[0]));
        expect(supersede[0]).toMatch(/end_reason = 'superseded'/);
        expect(supersede[1]).toEqual([31]);
        const ledger = mockDb.get.mock.calls.find((c) => /INSERT INTO dei_consents/.test(c[0]));
        expect(ledger[1]).toEqual([
            31,
            ['gender', 'ageBand', 'disability'],
            DEI.CONSENT_TEXT_VERSION,
            null,
        ]);
        const up = mockDb.get.mock.calls.find((c) =>
            /INSERT INTO employee_demographics/.test(c[0])
        );
        expect(up[0]).toMatch(/'self', false/);
        expect(up[1]).toEqual([31, 'female', null, '35-44', true, null, 55]);
        // The audit line carries field NAMES, never a declared value.
        const line = mockLog.log.mock.calls[0][0];
        expect(line.action).toBe('DEI_SELF_DECLARED');
        expect(line.details).not.toMatch(/female|35-44/);
    });

    test('an admin account has no declaration of its own (no write)', async () => {
        const r = await invoke('post', '/my-diversity', {
            user: SUPER,
            body: { gender: 'female', consent: 'true' },
        });
        expect(r.redirect).toBe('/v2/cap/my-diversity');
        expect(writes()).toEqual([]);
    });

    test('malformed labels are still a 400 before any write', async () => {
        await expect(
            DEI.declare(31, { gender: '<img src=x onerror=alert(1)>' }, { consent: true })
        ).rejects.toMatchObject({ status: 400, code: 'dei_invalid_gender' });
        expect(writes()).toEqual([]);
    });
});

describe('ethnicity is OFF by default (feature flag, legal sign-off)', () => {
    test('declaring ethnicity while off → 403, nothing written', async () => {
        await expect(
            DEI.declare(31, { ethnicity: 'zqxEth' }, { consent: true })
        ).rejects.toMatchObject({ status: 403, code: 'dei_ethnicity_disabled' });
        expect(writes()).toEqual([]);
    });

    test('the ethnicity dimension is refused by every analytic while off', async () => {
        for (const p of ['/dei/representation', '/dei/ninebox', '/dei/piprate']) {
            const r = await invoke('get', p, { user: SUPER, query: { dim: 'ethnicity' } });
            expect([p, r.status, r.body.code]).toEqual([p, 403, 'dei_ethnicity_disabled']);
        }
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('only the SuperAdmin, with the exact typed phrase and a reference, turns it on', async () => {
        await expect(
            DEI.setEthnicityEnabled(HR, {
                enabled: true,
                acknowledgement: 'LEGAL SIGN-OFF OBTAINED',
                reference: 'Opinion 2026-12 legal dept',
            })
        ).rejects.toMatchObject({ status: 403 });
        await expect(
            DEI.setEthnicityEnabled(SUPER, {
                enabled: true,
                acknowledgement: 'yes',
                reference: 'Opinion 2026-12 legal dept',
            })
        ).rejects.toMatchObject({ code: 'dei_ack_mismatch' });
        await expect(
            DEI.setEthnicityEnabled(SUPER, {
                enabled: true,
                acknowledgement: 'validation juridique obtenue',
                reference: 'short',
            })
        ).rejects.toMatchObject({ code: 'dei_signoff_reference_required' });
        expect(mockSettings.setValue).not.toHaveBeenCalled();

        const r = await invoke('post', '/dei/settings/ethnicity', {
            user: SUPER,
            body: {
                enabled: 'true',
                acknowledgement: 'validation  juridique obtenue',
                reference: 'Avis juridique 2026-12, service juridique',
            },
        });
        expect(r.flashes[0][0]).toBe('success');
        expect(mockSettings.values.deiEthnicityEnabled).toBe(true);
        expect(mockSettings.values.deiEthnicitySignoff).toMatchObject({
            enabled: true,
            by: 'admin:1',
            reference: 'Avis juridique 2026-12, service juridique',
        });
        expect(mockLog.log.mock.calls.map((c) => c[0].action)).toContain('DEI_ETHNICITY_ENABLED');
        // Now the dimension is accepted.
        mockDb.all.mockResolvedValueOnce([]);
        const ok = await invoke('get', '/dei/representation', {
            user: SUPER,
            query: { dim: 'ethnicity' },
        });
        expect(ok.status).toBe(200);
    });

    test('both switch keys are read-only in the generic settings catalog', () => {
        const real = jest.requireActual('../../src/models/AppSettingsModel');
        expect(real.isReadOnly('deiEthnicityEnabled')).toBe(true);
        expect(real.isReadOnly('deiEthnicitySignoff')).toBe(true);
    });
});

describe('withdrawal nulls the values at once; the ledger row is kept', () => {
    test('POST /my-diversity/withdraw', async () => {
        const r = await invoke('post', '/my-diversity/withdraw', { user: EMP });
        expect(r.flashes[0][0]).toBe('success');
        const calls = mockDb.run.mock.calls.map((c) => [String(c[0]), c[1]]);
        const ledger = calls.find(([s]) => /UPDATE dei_consents/.test(s));
        expect(ledger[0]).toMatch(/withdrawn_at = now\(\), end_reason = 'withdrawn'/);
        expect(ledger[1]).toEqual([31]);
        const values = calls.find(([s]) => /UPDATE employee_demographics/.test(s));
        for (const col of ['gender', 'ethnicity', 'age_band', 'disability', 'nationality'])
            expect(values[0]).toMatch(new RegExp(`${col} = NULL`));
        expect(values[1]).toEqual([31]);
        expect(calls.some(([s]) => /DELETE/i.test(s))).toBe(false);
    });
});

describe('disability: the person and authorised HR only — never a manager', () => {
    const row = {
        gender: 'female',
        ethnicity: 'zqxEth',
        ageBand: '35-44',
        disability: true,
        nationality: null,
        provenance: 'self',
        needsReview: false,
    };
    test.each([
        ['manager', MGR],
        ['admin without the HR permission', LOCAL],
    ])('%s → 403, no read', async (_n, user) => {
        mockDb.get.mockResolvedValue(row);
        const r = await invoke('get', '/dei/employee/:employeeId', {
            user,
            params: { employeeId: '31' },
        });
        expect(r.status).toBe(403);
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('HR admin in scope reads disability; ethnicity hidden while off; audited', async () => {
        mockDb.get.mockResolvedValue(row);
        const r = await invoke('get', '/dei/employee/:employeeId', {
            user: HR,
            params: { employeeId: '31' },
        });
        expect(r.status).toBe(200);
        expect(r.body.data.disability).toBe(true);
        expect(r.body.data).not.toHaveProperty('ethnicity');
        expect(JSON.stringify(r.body)).not.toMatch(/zqxEth/);
        expect(mockLog.log.mock.calls[0][0].action).toBe('DEI_RECORD_VIEWED');
    });

    test('HR admin out of scope → 403', async () => {
        const r = await invoke('get', '/dei/employee/:employeeId', {
            user: HR,
            params: { employeeId: '77' },
        });
        expect(r.status).toBe(403);
    });

    test('disability is never an analytic dimension', async () => {
        const r = await invoke('get', '/dei/representation', {
            user: SUPER,
            query: { dim: 'disability' },
        });
        expect(r.status).toBe(400);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

describe('analytics count only consented self-declarations; thresholds intact', () => {
    test('every analytic filters on provenance self + not under review', async () => {
        await DEI.representation('gender');
        await DEI.nineBoxByGroup('gender');
        await DEI.pipRateByGroup('gender');
        for (const s of sql(mockDb.all))
            expect(s).toMatch(/d\.provenance = 'self' AND d\.needs_review = false/);
    });

    test('min group 5 and the complement rule still apply', async () => {
        mockDb.all.mockResolvedValueOnce([
            { grp: 'female', n: 4 },
            { grp: 'male', n: 12 },
        ]);
        // A hidden cell carries NO count, and with only two
        // groups « male » would give « female » away by subtraction from the total
        // (16 − 12 = 4): complementary suppression hides it too.
        expect(await DEI.representation('gender')).toEqual([
            { grp: 'female', suppressed: true },
            { grp: 'male', suppressed: true },
        ]);
        mockDb.all.mockResolvedValueOnce([{ grp: 'male', headcount: 12, onPip: 9 }]);
        expect(await DEI.pipRateByGroup('gender')).toEqual([
            { grp: 'male', headcount: 12, suppressed: true },
        ]);
    });
});

describe('legacy values (unknown provenance) — HR review', () => {
    test('the review queue lists field NAMES in scope, never values', async () => {
        mockDb.all.mockResolvedValueOnce([
            {
                employeeId: 31,
                firstName: 'A',
                lastName: 'B',
                hasGender: true,
                hasEthnicity: true,
                hasDisability: true,
            },
        ]);
        const r = await invoke('get', '/dei/review', { user: HR });
        expect(r.view).toBe('pages/capability/dei-review');
        expect(r.locals.rows).toEqual([
            {
                employeeId: 31,
                name: 'A B',
                updatedAt: undefined,
                held: ['gender', 'disability', 'ethnicity'],
            },
        ]);
        const [q, params] = mockDb.all.mock.calls[0];
        expect(q).toMatch(/needs_review = true/);
        expect(q).not.toMatch(/d\.gender,|d\.ethnicity,|d\.disability,/);
        expect(params).toEqual([31, 32]);
    });

    test('a manager is sent away from the review page', async () => {
        const r = await invoke('get', '/dei/review', { user: MGR });
        expect(r.redirect).toBe('/v2/cap');
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('HR clears a flagged row with a reason; a self-declared row is refused (409)', async () => {
        await expect(DEI.hrClear(HR, 31, '')).rejects.toMatchObject({
            code: 'dei_reason_required',
        });
        const r = await invoke('post', '/dei/review/:employeeId/clear', {
            user: HR,
            params: { employeeId: '31' },
            body: { reason: 'entered by a manager in 2025' },
        });
        expect(r.flashes[0][0]).toBe('success');
        const [q, params] = mockDb.run.mock.calls[0];
        expect(q).toMatch(/WHERE employee_id = \? AND needs_review = true/);
        expect(params).toEqual(['admin:7', 'entered by a manager in 2025', 31]);
        mockDb.run.mockResolvedValueOnce({ changes: 0 });
        await expect(DEI.hrClear(HR, 31, 'already self-declared')).rejects.toMatchObject({
            status: 409,
        });
    });
});

describe('the employee page and the hub', () => {
    test('GET /my-diversity renders the person’s OWN record', async () => {
        mockDb.get.mockImplementation(async (s) =>
            /employee_demographics/.test(s)
                ? {
                      gender: 'female',
                      provenance: 'legacy_unknown',
                      needsReview: true,
                      ethnicity: 'zqxEth',
                  }
                : null
        );
        const r = await invoke('get', '/my-diversity', { user: EMP });
        expect(r.view).toBe('pages/employee/diversity');
        expect(mockDb.get.mock.calls.every((c) => c[1][0] === 31)).toBe(true);
        expect(r.locals.mine.values.needsReview).toBe(true);
        // Their own held ethnicity is shown to THEM (to withdraw it).
        expect(r.locals.mine.values.ethnicity).toBe('zqxEth');
    });

    test('the hub gives the DEI panel to the SuperAdmin only, ethnicity off', async () => {
        const Mob = require('../../src/services/MobilityService');
        const Sv = require('../../src/services/SurveyService');
        jest.spyOn(Mob, 'listOpportunities').mockResolvedValue([]);
        jest.spyOn(Sv, 'list').mockResolvedValue([]);
        const s = await invoke('get', '/', { user: SUPER });
        expect(s.locals.isSuper).toBe(true);
        expect(s.locals.deiEthnicity.enabled).toBe(false);
        const m = await invoke('get', '/', { user: MGR });
        expect(m.locals.isSuper).toBe(false);
        expect(m.locals.deiCanReview).toBe(false);
    });
});

describe('the consent page stays reachable while the talent module is off', () => {
    const M = require('../../src/config/modules');
    const ModuleService = require('../../src/services/ModuleService');
    function through(path) {
        return new Promise((resolve) => {
            const req = { path, headers: { accept: 'application/json' } };
            const res = {
                status(c) {
                    this.code = c;
                    return this;
                },
                json() {
                    resolve(this.code);
                },
                end() {
                    resolve(this.code);
                },
            };
            ModuleService.capGuard()(req, res, () => resolve('next'));
        });
    }

    test('with only the core switched on, /my-diversity passes and /dei is 404', async () => {
        // Stage 1 (the default): campaigns only — talent is off.
        await expect(through('/my-diversity')).resolves.toBe('next');
        await expect(through('/my-diversity/withdraw')).resolves.toBe('next');
        await expect(through('/dei/review')).resolves.toBe(404);
    });

    test('it is a core route that no module prefix covers', () => {
        expect(M.CORE_PREFIXES).toContain('/v2/cap/my-diversity');
        expect(M.CAP_PATHS.some(([p]) => '/my-diversity'.startsWith(p))).toBe(false);
    });
});
