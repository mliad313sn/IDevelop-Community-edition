'use strict';
/**
 * LOT S — security, id-space overlap, deactivation cascade (product-readiness
 * committee, 3.22.88). Every finding below was reproduced by a rolled-back probe
 * against idevelop before the fix and re-proved after it; the numbers quoted are
 * from those probes.
 *
 *  S-DEACT
 *   1  SCIM deprovision flipped two employee flags: linked admin still active,
 *      API key unrevoked, sessions alive, no pii_cleanup job → onLeaver cascade.
 *   2  EmployeeController.delete set isActive=0: password login still succeeded.
 *   3  SCIM active:true resurrected an ERASED subject (is_active=true, "Erased 290").
 *   4  DSRService.erase left employee_number 'EMP-…', username 'btoure', cancel_reason.
 *   5  revert(leaver) reinstated a VOIDED record (is_active=true AND cancelled_at).
 *   6  missingReviewer matched only NULL supervisor: a person re-pointed at an
 *      INACTIVE supervisor vanished from the worklist (old predicate 6, fixed 7).
 *   7  the edit form accepted an inactive/voided supervisor or manager.
 *   8  onboarding approve validated no nesting/scope/reviewer.
 *   9  A→B→A cycle writable; getSupervisorChain aborted after 40 hops on it.
 *  S-ID
 *   10 admin#N read employee#N's "my plans" and signed the employee slot.
 *   11 getFilteredEmployees(super) 78 vs 77 active — the erased subject as staff.
 *  S-AUTHZ
 *   12 comment(): viewer/out-of-scope admin wrote into a thread they cannot read.
 *   13 9-box create/…/disclose: local admin WITHOUT manage_talent_reviews → canApprove true.
 *   14 v2-capability objective/align/relate/suggestion: viewer passed.
 *   15 /reports/export without export_data.
 *   16 apiRequireWrite: session viewer passed.
 *   17 `?apiKey=bogus` switched off origin_required.
 *   18 denyPermission answered HTML to a JSON-body fetch.
 *   19 requireSuperAdmin: role without userType.
 *   20 TRUNCATE not intercepted (migration 101 covers all three tables).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
// The REGISTRATION of a route — path plus guard list — however it is laid out.
// This read "the line containing the path", which assumed the whole
// registration fits on one line; prettier splits it across several as soon as
// the guards overflow, and the guard list then lives on lines of its own, so
// the lookup returned undefined for routes that were correctly gated.
const routeLine = (src, route) => {
    const lit = src.indexOf(`'${route}'`);
    if (lit < 0) return undefined;
    const start = src.lastIndexOf('router.', lit);
    if (start < 0) return undefined;
    const ends = [src.indexOf('=>', lit), src.indexOf(';', lit)].filter((i) => i > -1);
    return src.slice(start, ends.length ? Math.min(...ends) : lit + 400);
};

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_w, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
// Collaborators mocked ONCE, up front, so every later require (controller,
// services, routers) sees the same doubles regardless of describe order.
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: jest.fn(),
    update: jest.fn(),
    findGovernedIds: jest.fn(async () => []),
    wouldCreateReportingCycle: jest.fn(async () => false),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findById: jest.fn(),
    findAll: jest.fn(async () => []),
    findByUsername: jest.fn(),
}));
jest.mock('../../src/services/RBACService', () => ({
    canAccessEmployeeData: jest.fn(async () => true),
    isSuperAdmin: (u) => u && u.userType === 'admin' && u.role === 'superadmin',
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/models/DepartmentModel', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/ServiceModel', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/AppSettingsModel', () => ({ getValue: jest.fn(async () => null) }));
jest.mock('../../src/models/OnboardingRequestModel', () => ({
    findById: jest.fn(),
    update: jest.fn(),
}));
const RBACServiceMock = require('../../src/services/RBACService');

const runs = (re) =>
    mockDb.run.mock.calls.filter(([sql]) => re.test(sql)).map(([sql, params]) => ({ sql, params }));

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.withActor.mockImplementation(async (_w, fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// S-DEACT 1/2 — one cascade for every departure path
// ---------------------------------------------------------------------------
describe('S1/S2 — LifecycleService.deprovision is THE deactivation entry point', () => {
    const Lifecycle = require('../../src/services/LifecycleService');

    test('deprovision records a leaver event and runs the full onLeaver cascade', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM employees e/.test(sql) ? { id: 90, countryCode: 'CI', dsrSlaDays: 30 } : null
        );
        mockDb.all.mockImplementation(async (sql) =>
            /FROM admins WHERE linked_employee_id/.test(sql) ? [{ id: 606 }] : []
        );
        await Lifecycle.deprovision(90, { source: 'scim', actorRef: 'admin:68' });
        expect(runs(/INSERT INTO lifecycle_events/)[0].params[0]).toBe(90);
        expect(
            runs(/UPDATE employees SET is_active = false, is_account_active = false/).length
        ).toBe(1);
        expect(runs(/UPDATE admins SET is_active = false WHERE id = \?/)[0].params).toEqual([606]);
        expect(runs(/DELETE FROM session/).length).toBeGreaterThanOrEqual(3); // employee + manager + admin buckets
        expect(runs(/INSERT INTO pii_cleanup_jobs/).length).toBe(1);
    });

    test('SCIM deprovision/re-enable delegate to the lifecycle service, never to a private UPDATE', () => {
        const src = read('src/routes/scim.js');
        expect(src).toMatch(/LifecycleService\.deprovision\(id, \{ source: 'scim'/);
        expect(src).toMatch(/LifecycleService\.reinstate\(id, \{ source: 'scim'/);
        expect(src).not.toMatch(/UPDATE employees SET is_active = \?, is_account_active = \?/);
    });

    test('EmployeeController.delete goes through the cascade (no bare isActive=0)', () => {
        const src = read('src/controllers/EmployeeController.js');
        const del = src.slice(
            src.indexOf('async delete(req, res)'),
            src.indexOf('async activateAccount(')
        );
        expect(del).toMatch(/LifecycleService'\)\.deprovision\(Number\(id\)/);
        expect(del).not.toMatch(/update\(id, \{ isActive: 0 \}\)/);
    });
});

// ---------------------------------------------------------------------------
// S-DEACT 3/4/5 — erased and voided records never come back
// ---------------------------------------------------------------------------
describe('S3/S5 — no reactivation path reinstates an erased or voided record', () => {
    const Lifecycle = require('../../src/services/LifecycleService');
    const leaverEvent = {
        id: 7,
        employeeId: 289,
        kind: 'leaver',
        revertedAt: null,
        occurredAt: '2026-01-01',
        payload: {},
    };

    test('revert(leaver) refuses a VOIDED record and stamps nothing', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM lifecycle_events WHERE id/.test(sql)) return leaverEvent;
            if (/SELECT cancelled_at, erased_at FROM employees/.test(sql))
                return { cancelledAt: '2026-02-01', erasedAt: null };
            return null;
        });
        await expect(Lifecycle.revert(7, { adminId: 68 })).rejects.toMatchObject({
            message: 'void_record_cannot_be_reinstated',
            status: 409,
        });
        expect(runs(/UPDATE employees SET is_active = true/).length).toBe(0);
        expect(runs(/SET reverted_at = now\(\)/).length).toBe(0);
    });

    test('revert(leaver) refuses an ERASED subject', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM lifecycle_events WHERE id/.test(sql)) return leaverEvent;
            if (/SELECT cancelled_at, erased_at FROM employees/.test(sql))
                return { cancelledAt: null, erasedAt: '2026-02-01' };
            return null;
        });
        await expect(Lifecycle.revert(7, { adminId: 68 })).rejects.toThrow(
            'erased_record_cannot_be_reinstated'
        );
    });

    test('revert(leaver) on a clean record reinstates, and only where cancelled_at/erased_at are NULL', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM lifecycle_events WHERE id/.test(sql)) return leaverEvent;
            if (/SELECT cancelled_at, erased_at FROM employees/.test(sql))
                return { cancelledAt: null, erasedAt: null };
            return null;
        });
        const s = await Lifecycle.revert(7, { adminId: 68 });
        expect(s.reactivated).toBe(true);
        const [u] = runs(/UPDATE employees SET is_active = true, is_account_active = true/);
        expect(u.sql).toMatch(/cancelled_at IS NULL AND erased_at IS NULL/);
    });

    test('reinstate() (the SCIM active:true path) refuses an erased subject before touching anything', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT cancelled_at, erased_at/.test(sql)
                ? { cancelledAt: null, erasedAt: '2026-02-01' }
                : null
        );
        await expect(Lifecycle.reinstate(290, { source: 'scim' })).rejects.toMatchObject({
            code: 'erased_record_cannot_be_reinstated',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('EmployeeModel.update refuses isActive=1 on an erased or voided row (the SuperAdmin reactivate toggle path)', async () => {
        const EmployeeModel = jest.requireActual('../../src/models/EmployeeModel');
        mockDb.get.mockResolvedValue({ cancelledAt: null, erasedAt: '2026-02-01' });
        await expect(EmployeeModel.update(68963, { isActive: 1 })).rejects.toMatchObject({
            code: 'erased_record_cannot_be_reinstated',
        });
        mockDb.get.mockResolvedValue({ cancelledAt: '2026-02-01', erasedAt: null });
        await expect(
            EmployeeModel.update(289, { isActive: true, isAccountActive: 1 })
        ).rejects.toMatchObject({ code: 'void_record_cannot_be_reinstated' });
        expect(runs(/UPDATE employees/).length).toBe(0);
        // an ordinary update never pays for the check
        mockDb.get.mockReset();
        mockDb.get.mockResolvedValue({ id: 90 });
        await EmployeeModel.update(90, { firstName: 'X' });
        expect(mockDb.get.mock.calls.some(([sql]) => /cancelled_at, erased_at/.test(sql))).toBe(
            false
        );
    });
});

describe('S4 — DSRService.erase pseudonymises every direct identifier', () => {
    test('employee_number and username become erased-<id>, cancel_reason is dropped, erased_at is stamped', async () => {
        const DSR = require('../../src/services/DSRService');
        mockDb.get.mockResolvedValue({ id: 290 });
        await DSR.erase(290, 68);
        const [u] = runs(/UPDATE employees SET first_name = 'Erased'/);
        expect(u.sql).toMatch(/employee_number = \?, username = \?/);
        expect(u.sql).toMatch(
            /cancel_reason = CASE WHEN cancelled_at IS NULL THEN NULL ELSE '\[erased\]' END/
        );
        expect(u.sql).toMatch(/erased_at = COALESCE\(erased_at, now\(\)\)/);
        expect(u.params.slice(0, 4)).toEqual([
            '290',
            'erased-290@erased.local',
            'erased-290',
            'erased-290',
        ]);
    });
});

// ---------------------------------------------------------------------------
// S-DEACT 6/7/9 — reporting lines: inactive reviewers, cycles
// ---------------------------------------------------------------------------
describe('S6 — the missing-reviewer worklist tests for an ACTIVE reviewer, not a NULL column', () => {
    test('findPageWithOrg({missingReviewer}) requires an active, non-voided supervisor or manager', async () => {
        const EmployeeModel = jest.requireActual('../../src/models/EmployeeModel');
        mockDb.get.mockResolvedValue({ cnt: 7 });
        await EmployeeModel.findPageWithOrg({
            scopes: null,
            filters: { missingReviewer: true },
            limit: 10,
            offset: 0,
        });
        const [sql] = mockDb.all.mock.calls[0];
        expect(sql).toMatch(
            /sup\.id = e\.supervisor_id AND sup\.is_active = true AND sup\.cancelled_at IS NULL/
        );
        expect(sql).toMatch(
            /mgr\.id = e\.manager_id AND COALESCE\(e\.manager_type, 'employee'\) = 'employee'\s+AND mgr\.is_active = true/
        );
        expect(sql).toMatch(
            /am\.id = e\.manager_id AND e\.manager_type = 'admin' AND am\.is_active = true/
        );
        expect(sql).not.toMatch(/supervisorId IS NULL AND e\.managerId IS NULL/);
    });
});

describe('S9 — reporting cycles', () => {
    const EmployeeModel = jest.requireActual('../../src/models/EmployeeModel');

    test('getSupervisorChain terminates on an A→B→A loop', async () => {
        const rows = { 90: { id: 90, supervisorId: 91 }, 91: { id: 91, supervisorId: 90 } };
        mockDb.get.mockImplementation(async (sql, params) => rows[Number(params[0])] || null);
        const chain = await EmployeeModel.getSupervisorChain(90);
        expect(chain.map((x) => Number(x.id))).toEqual([91]);
        expect(mockDb.get.mock.calls.length).toBeLessThan(10);
    });

    test('wouldCreateReportingCycle: self, or a candidate the employee already governs', async () => {
        const spy = jest.spyOn(EmployeeModel, 'findGovernedIds').mockResolvedValue([91, 92]);
        expect(await EmployeeModel.wouldCreateReportingCycle(90, 90)).toBe(true);
        expect(await EmployeeModel.wouldCreateReportingCycle(90, 92)).toBe(true);
        expect(await EmployeeModel.wouldCreateReportingCycle(90, 150)).toBe(false);
        spy.mockRestore();
    });
});

describe('S7/S9 — the employee form refuses an inactive, voided or looping supervisor/manager', () => {
    const EmployeeModel = require('../../src/models/EmployeeModel');
    const AdminModel = require('../../src/models/AdminModel');
    const Controller = require('../../src/controllers/EmployeeController');
    const superU = { id: 68, userType: 'admin', role: 'superadmin' };
    const fakeReq = (body) => ({
        params: { id: '142' },
        body,
        user: superU,
        flash: jest.fn(),
        t: (k) => k,
        ip: '127.0.0.1',
        get: () => 'jest',
    });
    const fakeRes = () => ({
        redirect: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
    });
    const baseBody = {
        employeeNumber: 'E1',
        firstName: 'A',
        lastName: 'B',
        siteId: '1',
        departmentId: '1',
        serviceId: '1',
        roleId: '1',
    };

    beforeEach(() => {
        EmployeeModel.findById.mockReset();
        EmployeeModel.update.mockReset();
        EmployeeModel.wouldCreateReportingCycle.mockReset().mockResolvedValue(false);
        AdminModel.findById.mockReset();
    });

    test('update: an INACTIVE supervisor is refused (setSupervisor and the form now agree)', async () => {
        EmployeeModel.findById.mockImplementation(async (id) =>
            Number(id) === 142
                ? { id: 142, employeeNumber: 'E1', supervisorId: null }
                : { id: 136, isActive: false, cancelledAt: null }
        );
        const req = fakeReq({ ...baseBody, supervisorId: '136' });
        const res = fakeRes();
        await Controller.update(req, res);
        expect(req.flash).toHaveBeenCalledWith('error', 'flash:emp_invalid_supervisor');
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('update: a VOIDED supervisor is refused', async () => {
        EmployeeModel.findById.mockImplementation(async (id) =>
            Number(id) === 142
                ? { id: 142, employeeNumber: 'E1' }
                : { id: 136, isActive: true, cancelledAt: '2026-01-01' }
        );
        const req = fakeReq({ ...baseBody, supervisorId: '136' });
        await Controller.update(req, fakeRes());
        expect(req.flash).toHaveBeenCalledWith('error', 'flash:emp_invalid_supervisor');
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('update: a supervisor already governed by the employee is refused (reporting loop)', async () => {
        EmployeeModel.findById.mockImplementation(async (id) =>
            Number(id) === 142
                ? { id: 142, employeeNumber: 'E1' }
                : { id: 150, isActive: true, cancelledAt: null }
        );
        EmployeeModel.wouldCreateReportingCycle.mockResolvedValue(true);
        const req = fakeReq({ ...baseBody, supervisorId: '150' });
        await Controller.update(req, fakeRes());
        expect(EmployeeModel.wouldCreateReportingCycle).toHaveBeenCalledWith('142', 150);
        expect(req.flash).toHaveBeenCalledWith('error', 'flash:emp_reporting_cycle');
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('update: an INACTIVE employee-manager is refused', async () => {
        EmployeeModel.findById.mockImplementation(async (id) =>
            Number(id) === 142 ? { id: 142, employeeNumber: 'E1' } : { id: 137, isActive: false }
        );
        const req = fakeReq({ ...baseBody, manager: 'employee:137' });
        await Controller.update(req, fakeRes());
        expect(req.flash).toHaveBeenCalledWith('error', 'Invalid manager selected');
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('update: an active, non-looping supervisor still saves', async () => {
        EmployeeModel.findById.mockImplementation(async (id) =>
            Number(id) === 142
                ? { id: 142, employeeNumber: 'E1' }
                : { id: 136, isActive: true, cancelledAt: null }
        );
        const req = fakeReq({ ...baseBody, supervisorId: '136' });
        await Controller.update(req, fakeRes());
        expect(EmployeeModel.update).toHaveBeenCalledWith(
            '142',
            expect.objectContaining({ supervisorId: 136 })
        );
    });

    test('setSupervisor: a voided or looping supervisor answers 400', async () => {
        EmployeeModel.findById.mockImplementation(async (id) =>
            Number(id) === 142
                ? { id: 142, supervisorId: null }
                : { id: 136, isActive: true, cancelledAt: '2026-01-01' }
        );
        const res = fakeRes();
        await Controller.setSupervisor(
            {
                params: { id: '142' },
                body: { supervisorId: '136' },
                user: superU,
                ip: '',
                get: () => '',
            },
            res
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// S-DEACT 8 — onboarding placement
// ---------------------------------------------------------------------------
describe('S8 — OnboardingService.approve validates the placement like the employee form', () => {
    const DepartmentModel = require('../../src/models/DepartmentModel');
    const ServiceModel = require('../../src/models/ServiceModel');
    const EmployeeModel = require('../../src/models/EmployeeModel');
    const AdminModel = require('../../src/models/AdminModel');
    const RBACService = require('../../src/services/RBACService');
    const Onboarding = require('../../src/services/OnboardingService');

    beforeEach(() => {
        DepartmentModel.findById.mockReset();
        ServiceModel.findById.mockReset();
        EmployeeModel.findById.mockReset();
        AdminModel.findById.mockReset();
        RBACServiceMock.canAccessEmployeeData.mockReset().mockResolvedValue(true);
        AdminModel.findById.mockResolvedValue({ id: 68, role: 'superadmin' });
        DepartmentModel.findById.mockResolvedValue({ id: 5, siteId: 11 });
        ServiceModel.findById.mockResolvedValue({ id: 9, departmentId: 5 });
    });

    test('a trio that does not nest is refused with onbx_q_place_inconsistent', async () => {
        ServiceModel.findById.mockResolvedValue({ id: 9, departmentId: 999 });
        const r = await Onboarding.validatePlacement(
            { siteId: 11, departmentId: 5, serviceId: 9 },
            68
        );
        expect(r).toMatchObject({ ok: false, code: 'onbx_q_place_inconsistent' });
    });

    test('an inactive supervisor is refused with onbx_q_bad_supervisor', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 136, isActive: false });
        const r = await Onboarding.validatePlacement(
            { siteId: 11, departmentId: 5, serviceId: 9, supervisorId: 136 },
            68
        );
        expect(r).toMatchObject({ ok: false, code: 'onbx_q_bad_supervisor' });
    });

    test("a supervisor outside the approving admin's scope is refused", async () => {
        AdminModel.findById.mockResolvedValue({ id: 69, role: 'localadmin' });
        EmployeeModel.findById.mockResolvedValue({ id: 136, isActive: true, cancelledAt: null });
        RBACService.canAccessEmployeeData.mockResolvedValueOnce(false);
        const { resolveAdminScope } = require('../../src/utils/adminScope');
        jest.spyOn(require('../../src/utils/adminScope'), 'resolveAdminScope').mockResolvedValue({
            unrestricted: false,
            departmentIds: [5],
            serviceIds: [9],
        });
        const r = await Onboarding.validatePlacement(
            { siteId: 11, departmentId: 5, serviceId: 9, supervisorId: 136 },
            69
        );
        expect(r).toMatchObject({ ok: false, code: 'onbx_q_bad_supervisor' });
        expect(resolveAdminScope).toBeDefined();
    });

    test('a sound placement with an active in-scope supervisor passes', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 136, isActive: true, cancelledAt: null });
        const r = await Onboarding.validatePlacement(
            {
                siteId: 11,
                departmentId: 5,
                serviceId: 9,
                supervisorId: 136,
                managerId: 12,
                managerType: 'admin',
            },
            68
        );
        expect(r).toBeNull();
    });

    test('approve() runs the validation before creating anything', () => {
        const src = read('src/services/OnboardingService.js');
        const approve = src.slice(src.indexOf('async function approve('));
        expect(approve.indexOf('validatePlacement(placement, adminId)')).toBeGreaterThan(-1);
        expect(approve.indexOf('validatePlacement(placement, adminId)')).toBeLessThan(
            approve.indexOf('EmployeeModel.create(data)')
        );
    });
});

// ---------------------------------------------------------------------------
// S-ID 10/11
// ---------------------------------------------------------------------------
describe('S10 — IDP self-comparisons are qualified on userType', () => {
    const src = read('src/routes/v2-idp.js');
    // Locate a route boundary by REGEX, not by an exact literal: prettier breaks
    // `router.get('/',\s*requireAuth, ...)` across lines as soon as it overflows,
    // and an indexOf on the one-line spelling then returns -1 — slice(-1, -1) is
    // the EMPTY STRING, so the assertions "failed to match" against nothing at
    // all rather than against the route. Shared by every test in this block.
    const at = (re) => {
        const m = re.exec(src);
        expect(m).not.toBeNull();
        return m.index;
    };
    test('"my plans" is an employee-side query; an admin sharing the number gets nothing', () => {
        const list = src.slice(
            at(/router\.get\(\s*'\/',\s*requireAuth/),
            at(/router\.get\(\s*'\/manage'/)
        );
        // LOT PO: the admin no longer gets an empty "my plans" table — they are sent
        // to the team console BEFORE any query keyed on req.user.id can run.
        expect(list).toMatch(
            /if \(!isEmployeeSide\)\s*return res\.redirect\('\/v2\/idp\/manage'\);/
        );
        expect(list.indexOf('if (!isEmployeeSide) return res.redirect')).toBeLessThan(
            list.indexOf('await db.all')
        );
        expect(list).toMatch(/WHERE employee_id = \?[^`]*`,\s*\[req\.user\.id\]/);
    });
    test('the sign slot is derived from userType AND id, and the sign-off records the actor type', () => {
        // Same reason as `list` above: prettier breaks the router call across
        // lines, so an exact-literal indexOf returns -1 and the slice is empty.
        const sign = src.slice(
            at(/router\.post\(\s*'\/:id\/sign'/),
            at(/router\.post\(\s*'\/actions\/:id\/close'/)
        );
        expect(sign).toMatch(
            /const role =\s*isEmployeeSide && Number\(req\.user\.id\) === Number\(plan\.employeeId\)\s*\?\s*'employee'\s*:\s*'supervisor'/
        );
        expect(sign).toMatch(/userType: req\.user\.userType/);
    });
    test('migration 104 gives idp_signoffs.user_type with the employee default', () => {
        const mig = read('db/postgres/104_erasure_stamp_signoff_actor_truncate_guard.sql');
        expect(mig).toMatch(
            /ALTER TABLE idp_signoffs ADD COLUMN IF NOT EXISTS user_type text NOT NULL DEFAULT 'employee'/
        );
        expect(mig).toMatch(/ALTER TABLE employees ADD COLUMN IF NOT EXISTS erased_at timestamptz/);
    });
});

describe('S11 — getFilteredEmployees lists ACTIVE staff by default', () => {
    const EmployeeModel = jest.requireActual('../../src/models/EmployeeModel');
    test('findByScopesAndFilters adds is_active = true unless told otherwise', async () => {
        await EmployeeModel.findByScopesAndFilters(null, {});
        let [sql, params] = mockDb.all.mock.calls[0];
        expect(sql).toMatch(/e\.isActive = \?/);
        expect(params).toEqual([true]);

        mockDb.all.mockClear();
        await EmployeeModel.findByScopesAndFilters(null, { includeInactive: true });
        [sql, params] = mockDb.all.mock.calls[0];
        expect(sql).not.toMatch(/isActive/);
        expect(params).toEqual([]);

        mockDb.all.mockClear();
        await EmployeeModel.findByScopesAndFilters(null, { isActive: false });
        [sql, params] = mockDb.all.mock.calls[0];
        expect(params).toEqual([false]);
    });
    test('the surfaces that legitimately list leavers opted out explicitly', () => {
        for (const f of [
            'src/controllers/DataManagementController.js',
            'src/services/UnifiedExportService.js',
            'src/services/ImportExportService.js',
            'src/controllers/SystemLogController.js',
        ]) {
            expect(read(f)).toMatch(/getFilteredEmployees\([^)]*\{\s*includeInactive: true,?\s*\}/);
        }
        expect(read('src/routes/scim.js')).toMatch(/includeInactive: true/);
    });
});

// ---------------------------------------------------------------------------
// S-AUTHZ 12-19
// ---------------------------------------------------------------------------
describe('S12 — comment() uses the same predicate as _assertCanView', () => {
    const svc = jest.requireActual('../../src/services/SelfAssessmentWorkflowService');
    afterEach(() => jest.restoreAllMocks());
    test('an admin who cannot view the thread cannot write into it', async () => {
        jest.spyOn(svc, 'getAssessment').mockResolvedValue({
            id: 222258,
            employeeId: 68963,
            workflowState: 'submitted',
        });
        jest.spyOn(svc, 'resolveAuthority').mockResolvedValue({
            isSelf: false,
            canSupervise: false,
            canManage: false,
            actorType: 'admin',
            isAdmin: true,
        });
        await expect(
            svc.comment(222258, { id: 70, userType: 'admin', role: 'viewer' }, 'probe')
        ).rejects.toThrow('Not authorized to comment');
        expect(
            mockDb.get.mock.calls.some(([sql]) => /INSERT INTO self_assessment_comments/.test(sql))
        ).toBe(false);
    });
    test('an in-scope supervisor still comments', async () => {
        jest.spyOn(svc, 'getAssessment').mockResolvedValue({
            id: 1,
            employeeId: 142,
            workflowState: 'submitted',
        });
        jest.spyOn(svc, 'resolveAuthority').mockResolvedValue({
            isSelf: false,
            canSupervise: true,
            canManage: false,
            actorType: 'supervisor',
        });
        mockDb.get.mockImplementation(async (sql) =>
            /INSERT INTO self_assessment_comments/.test(sql) ? { id: 5 } : null
        );
        const c = await svc.comment(1, { id: 136, userType: 'manager' }, 'ok');
        expect(c).toEqual({ id: 5 });
    });
});

describe('S13 — 9-box writes need manage_talent_reviews', () => {
    test('every write route carries the slug (create/update/submit/approve/reject/archive/disclose)', () => {
        const src = read('src/routes/index.js');
        for (const r of [
            '/api/ninebox',
            '/api/ninebox/:id/update',
            '/api/ninebox/:id/submit',
            '/api/ninebox/:id/approve',
            '/api/ninebox/:id/reject',
            '/api/ninebox/:id/archive',
            '/api/ninebox/:id/disclose',
        ]) {
            const line = routeLine(src, r);
            expect(line).toBeDefined();
            expect(line).toMatch(/requireManagerOrAnyPermission\('manage_talent_reviews'\)/);
            expect(line).not.toMatch(/requireManagerOrAdmin\s*,/);
        }
    });
    test('NineBoxService: an in-scope local admin WITHOUT the slug can neither draft nor approve; WITH it, both', async () => {
        const N = jest.requireActual('../../src/services/NineBoxService');
        const EmployeeModel = require('../../src/models/EmployeeModel');
        const RBACService = require('../../src/services/RBACService');
        EmployeeModel.findById.mockResolvedValue({ id: 142, supervisorId: 136, managerId: 137 });
        RBACService.canAccessEmployeeData.mockReset().mockResolvedValue(true);
        RBACService.isLocalAdmin = (u) => u.role === 'localadmin';
        RBACService.isViewer = (u) => u.role === 'viewer';
        RBACService.hasPermission = (u, s) =>
            Array.isArray(u.permissions) && u.permissions.includes(s);
        const without = await N.resolveAuthority(
            { id: 69, userType: 'admin', role: 'localadmin', permissions: ['view_employees'] },
            142
        );
        expect(without.canView).toBe(true);
        expect(without.canDraft).toBe(false);
        expect(without.canApprove).toBe(false);
        const withSlug = await N.resolveAuthority(
            {
                id: 69,
                userType: 'admin',
                role: 'localadmin',
                permissions: ['manage_talent_reviews'],
            },
            142
        );
        expect(withSlug.canDraft).toBe(true);
        expect(withSlug.canApprove).toBe(true);
    });
});

describe('S14/S15 — write slugs on v2-capability and the report builder', () => {
    const cap = read('src/routes/v2-capability.js');
    const idx = read('src/routes/index.js');
    test.each([
        ['/objective', 'manage_organization'],
        ['/objective/:id/align', 'manage_organization'],
        ['/skills/relate', 'manage_domains_skills'],
        ['/skills/suggestion/:id/accept', 'manage_assessments'],
        ['/skills/suggestion/:id/dismiss', 'manage_assessments'],
    ])('v2-capability %s carries %s (a WRITE slug — viewers excluded)', (route, slug) => {
        const line = routeLine(cap, route);
        expect(line).toContain(slug);
        expect(line).not.toMatch(/requireManagerOrAdmin\s*,/);
        expect(require('../../src/config/permissions').WRITE_SLUGS.has(slug)).toBe(true);
    });
    test('/reports/export needs export_data; generate and data need a read slug; managers keep access', () => {
        expect(routeLine(idx, '/reports/export')).toMatch(
            /requireManagerOrAnyPermission\('export_data'\)/
        );
        expect(routeLine(idx, '/reports/generate')).toMatch(
            /requireManagerOrAnyPermission\('view_employees', 'export_data'\)/
        );
        expect(routeLine(idx, '/reports/data')).toMatch(
            /requireManagerOrAnyPermission\('view_employees', 'export_data'\)/
        );
    });
    test('requireManagerOrAnyPermission denies a viewer a write slug and admits a manager', async () => {
        const { requireManagerOrAnyPermission } = jest.requireActual('../../src/middleware/auth');
        const run = (user) =>
            new Promise((resolve) => {
                const res = {
                    status: jest.fn().mockReturnThis(),
                    json: jest.fn((b) => resolve({ code: res.status.mock.calls[0][0], body: b })),
                };
                const p = requireManagerOrAnyPermission('manage_organization')(
                    { isAuthenticated: () => true, user, xhr: true, headers: {}, flash() {} },
                    res,
                    () => resolve({ code: 'next' })
                );
                Promise.resolve(p).catch(() => {});
            });
        expect(
            (
                await run({
                    id: 70,
                    userType: 'admin',
                    role: 'viewer',
                    permissions: ['manage_organization'],
                })
            ).code
        ).toBe(403);
        expect((await run({ id: 137, userType: 'manager' })).code).toBe('next');
    });
});

describe('S16 — apiRequireWrite rejects a read-only viewer', () => {
    test('a session viewer is refused on POST /api/v1/goals', async () => {
        const RBACService = require('../../src/services/RBACService');
        RBACService.isViewer = (u) => u && u.userType === 'admin' && u.role === 'viewer';
        const api = jest.requireActual('../../src/api/v1/index.js');
        const layer = api.stack.find(
            (l) => l.route && l.route.path === '/goals' && l.route.methods.post
        );
        const guard = layer.route.stack[0].handle;
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        let nexted = false;
        await guard(
            {
                isAuthenticated: () => true,
                user: { id: 70, userType: 'admin', role: 'viewer' },
                headers: {},
                query: {},
            },
            res,
            () => {
                nexted = true;
            }
        );
        expect(nexted).toBe(false);
        expect(res.status).toHaveBeenCalledWith(403);
        nexted = false;
        await guard(
            {
                isAuthenticated: () => true,
                user: { id: 69, userType: 'admin', role: 'localadmin' },
                headers: {},
                query: {},
            },
            res,
            () => {
                nexted = true;
            }
        );
        expect(nexted).toBe(true);
    });
});

describe('S17 — the origin guard only honours a credential that validates', () => {
    const src = read('server.js');
    test('hasApiKey comes from _validatedApiCredential (ApiKeyService.validate / legacy key), never from the raw header', () => {
        expect(src).toMatch(/async function _validatedApiCredential\(req\)/);
        expect(src).toMatch(/require\('\.\/src\/services\/ApiKeyService'\)\.validate\(key\)/);
        expect(src).toMatch(/hasApiKey = await _validatedApiCredential\(req\)/);
        expect(src).not.toMatch(/const hasApiKey = !!\(req\.headers\['x-api-key'\]/);
    });
});

describe('S18/S19 — middleware/auth', () => {
    const auth = jest.requireActual('../../src/middleware/auth');
    test("wantsJson recognises a JSON body without Accept or X-Requested-With (the app's own fetch)", () => {
        expect(auth.wantsJson({ headers: { 'content-type': 'application/json' } })).toBe(true);
        expect(auth.wantsJson({ headers: { accept: 'application/json' } })).toBe(true);
        expect(auth.wantsJson({ xhr: true, headers: {} })).toBe(true);
        expect(
            auth.wantsJson({
                headers: {
                    accept: 'text/html',
                    'content-type': 'application/x-www-form-urlencoded',
                },
            })
        ).toBe(false);
    });
    test('denyPermission answers JSON 403 to a JSON-body request', async () => {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            render: jest.fn(),
            redirect: jest.fn(),
        };
        await auth.denyPermission(
            {
                headers: { 'content-type': 'application/json' },
                isAuthenticated: () => true,
                user: { userType: 'admin', role: 'viewer' },
                flash() {},
            },
            res,
            ['manage_talent_reviews']
        );
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Access denied. You do not have permission for this action.',
        });
        expect(res.render).not.toHaveBeenCalled();
    });
    test('requireSuperAdmin needs userType admin AND role superadmin', () => {
        const RBACService = require('../../src/services/RBACService');
        RBACService.isSuperAdmin = (u) => u && u.userType === 'admin' && u.role === 'superadmin';
        const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();
        auth.requireSuperAdmin(
            {
                isAuthenticated: () => true,
                user: { id: 137, userType: 'employee', role: 'superadmin' },
                flash() {},
            },
            res,
            next
        );
        expect(next).not.toHaveBeenCalled();
        auth.requireSuperAdmin(
            {
                isAuthenticated: () => true,
                user: { id: 68, userType: 'admin', role: 'superadmin' },
                flash() {},
            },
            res,
            next
        );
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('S20 — TRUNCATE on the append-only tables is refused at the database', () => {
    test('migration 101 covers system_logs, assessment_history AND review_signatures with a BEFORE TRUNCATE statement trigger', () => {
        const m = read('db/postgres/101_append_only_truncate_guard.sql');
        for (const t of ['system_logs', 'assessment_history', 'review_signatures']) {
            expect(m).toMatch(
                new RegExp(
                    `CREATE TRIGGER trg_${t}_no_truncate\\s+BEFORE TRUNCATE ON public\\.${t}\\s+FOR EACH STATEMENT`
                )
            );
        }
    });
});
