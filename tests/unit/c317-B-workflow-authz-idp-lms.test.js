'use strict';
/**
 * 3.23.17 — lane B (workflow authz), findings 1, 2 and 9.
 *
 *   B-1  POST /v2/idp/actions/:id/close — a manager closing an action on their
 *        OWN plan wrote the post-rating as their OFFICIAL skill level.
 *   B-2  LMS uplifts — _mayDecide checked approve_assessments only: any admin
 *        holding it decided uplifts for every site, and nobody stopped a person
 *        validating their own uplift through a linked admin account.
 *   B-9  lms_integrations.webhook_secret stored in clear.
 *
 * DB mocked; behaviour driven through the real router / service.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_who, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockEmployees = { findById: jest.fn(), governs: jest.fn(async () => false) };
jest.mock('../../src/models/EmployeeModel', () => mockEmployees);

const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isViewer: (u) => Boolean(u && u.userType === 'admin' && u.role === 'viewer'),
    hasPermission: (u, slug) =>
        Boolean(
            u &&
            u.userType === 'admin' &&
            (u.role === 'superadmin' || (u.permissions || []).includes(slug))
        ),
    canAccessEmployeeData: jest.fn(async () => false),
    canAccessEmployee: jest.fn(async () => false),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const mockGov = {
    actingPersonId: jest.fn(async (u) => (u && u.userType !== 'admin' ? Number(u.id) : null)),
    lineAuthorityEmployeeIds: jest.fn(async () => []),
};
jest.mock('../../src/services/GovernanceService', () => mockGov);

jest.mock('../../src/middleware/auth', () => {
    const pass = (req, res, next) => next();
    return {
        requireAuth: pass,
        requireEmployee: pass,
        requireManager: pass,
        requireManagerOrAdmin: pass,
        requireEmployeeOrManager: pass,
        wantsJson: () => true,
    };
});
jest.mock('../../src/services/IDPService', () => ({}));

const express = require('express');

// admin id → linked employee id (admins.linked_employee_id)
const LINKS = { 703: 137 };

function primeDb({ planEmployeeId = 137, preLevel = 1 } = {}) {
    mockDb.get.mockImplementation(async (sql, params = []) => {
        if (/FROM idp_actions a\s+JOIN idp_plans/.test(sql))
            return { id: 5, employeeId: planEmployeeId };
        if (/SELECT linked_employee_id FROM admins WHERE id = \?/.test(sql)) {
            const l = LINKS[Number(params[0])];
            return { linkedEmployeeId: l == null ? null : l };
        }
        if (/FROM admins WHERE linked_employee_id = \?/.test(sql)) return undefined; // actorAdminId
        if (/username = 'admin'/.test(sql)) return { id: 1 };
        if (/FROM action_skill_links/.test(sql)) return { skillId: 11 };
        if (/FROM skill_assessments/.test(sql)) return { currentLevel: preLevel };
        return undefined;
    });
    mockDb.run.mockResolvedValue({ changes: 1 });
}

function call(router, user, method, url, body = {}) {
    return new Promise((resolve) => {
        const app = express.Router();
        app.use('/v2/idp', router);
        const headers = { 'content-type': 'application/json', accept: 'application/json' };
        const r = {
            method,
            url: '/v2/idp' + url,
            originalUrl: '/v2/idp' + url,
            headers,
            body,
            query: {},
            params: {},
            user,
            ip: '127.0.0.1',
            xhr: true,
            isAuthenticated: () => true,
            get: (h) => headers[String(h).toLowerCase()],
            flash: () => {},
            t: (k, o) => (o && o.defaultValue) || k,
        };
        const res = {
            _status: 200,
            status(s) {
                this._status = s;
                return this;
            },
            json(j) {
                resolve({ status: this._status, json: j });
            },
            render(v) {
                resolve({ status: this._status, render: v });
            },
            redirect(u) {
                resolve({ status: 302, location: u });
            },
            set() {
                return this;
            },
            setHeader() {},
            getHeader() {},
        };
        app.handle(r, res, (err) => resolve({ status: 'next', err: err && (err.message || err) }));
    });
}

const officialWrites = () =>
    mockDb.run.mock.calls.filter(([sql]) => /INSERT INTO skill_assessments/.test(sql));

beforeEach(() => {
    jest.clearAllMocks();
    mockEmployees.governs.mockResolvedValue(false);
    mockRbac.canAccessEmployeeData.mockResolvedValue(false);
    mockRbac.canAccessEmployee.mockResolvedValue(false);
    mockGov.lineAuthorityEmployeeIds.mockResolvedValue([]);
});

describe('B-1 — closing an action never raises one’s OWN official level', () => {
    const router = require('../../src/routes/v2-idp');
    const MGR137 = { id: 137, userType: 'manager' };
    const MGR136 = { id: 136, userType: 'manager' };

    test('a manager closing an action on their OWN plan: rating kept as evidence, official level untouched', async () => {
        primeDb({ planEmployeeId: 137, preLevel: 1 });
        mockEmployees.findById.mockResolvedValue({ id: 137, supervisorId: 136 });
        const out = await call(router, MGR137, 'POST', '/actions/5/close', { postRating: 4 });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({
            ok: true,
            ratingPre: 1,
            ratingPost: 4,
            officialUpdated: false,
        });
        expect(officialWrites()).toHaveLength(0);
        // the evidence row is still written, and the action is closed
        expect(
            mockDb.run.mock.calls.some(([s]) => /INSERT INTO action_effectiveness/.test(s))
        ).toBe(true);
        expect(
            mockDb.run.mock.calls.some(([s]) => /UPDATE idp_actions SET status='completed'/.test(s))
        ).toBe(true);
    });

    test('the supervisor closing a report’s action DOES move the official level, attributed to an admins(id)', async () => {
        primeDb({ planEmployeeId: 137, preLevel: 1 });
        mockEmployees.findById.mockResolvedValue({ id: 137, supervisorId: 136 });
        const out = await call(router, MGR136, 'POST', '/actions/5/close', { postRating: 3 });
        expect(out.status).toBe(200);
        expect(out.json.officialUpdated).toBe(true);
        const w = officialWrites();
        expect(w).toHaveLength(1);
        // [employee, skill, level, assessed_by] — assessed_by is the admins(id)
        // FK holder (system account), never the manager's EMPLOYEE id 136.
        expect(w[0][1]).toEqual([137, 11, 3, 1]);
        expect(mockDb.withActor).toHaveBeenCalledWith(MGR136, expect.any(Function));
    });

    test('the subject on their LINKED admin account (clearance over themselves) still cannot move their own level', async () => {
        primeDb({ planEmployeeId: 137, preLevel: 1 });
        mockEmployees.findById.mockResolvedValue({ id: 137, supervisorId: 136 });
        mockRbac.canAccessEmployeeData.mockResolvedValue(true); // their clearance covers their own site
        const LINKED703 = { id: 703, userType: 'admin', role: 'localadmin', permissions: [] };
        const out = await call(router, LINKED703, 'POST', '/actions/5/close', { postRating: 4 });
        expect(out.status).toBe(200);
        expect(out.json.officialUpdated).toBe(false);
        expect(officialWrites()).toHaveLength(0);
    });

    test('a manager with no authority over the subject cannot move the official level', async () => {
        primeDb({ planEmployeeId: 150, preLevel: 1 });
        mockEmployees.findById.mockResolvedValue({ id: 150, supervisorId: 999 });
        // canAccessIdp lets them in through governs(); canManageEmployee also
        // uses governs — flip it only for the access check to prove the gate
        // is the authority test, not the access test.
        mockEmployees.governs.mockResolvedValueOnce(true).mockResolvedValue(false);
        const out = await call(router, MGR136, 'POST', '/actions/5/close', { postRating: 4 });
        // 3.23.18: a sub-tree (indirect) manager may only READ an IDP — the
        // write itself is now refused, and the official level stays untouched.
        expect(out.status).toBe(403);
        expect(officialWrites()).toHaveLength(0);
        expect(
            mockDb.run.mock.calls.some(([s]) => /UPDATE idp_actions SET status='completed'/.test(s))
        ).toBe(false);
    });
});

describe('B-2 — an LMS uplift is decided within scope, and never one’s own', () => {
    const LmsService = require('../../src/services/LmsService');
    const LOCAL = {
        id: 40,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['approve_assessments'],
    };
    const LINKED_SUPER = { id: 703, userType: 'admin', role: 'superadmin', permissions: [] };

    beforeEach(() => primeDb());

    test('a local admin with approve_assessments but NO scope over the employee is refused', async () => {
        mockRbac.canAccessEmployee.mockResolvedValue(false);
        await expect(LmsService._mayDecide(LOCAL, 500)).resolves.toBe(false);
    });

    test('the same admin inside their scope may decide', async () => {
        mockRbac.canAccessEmployee.mockResolvedValue(true);
        await expect(LmsService._mayDecide(LOCAL, 500)).resolves.toBe(true);
    });

    test('nobody decides their OWN uplift — not even a SuperAdmin account linked to that person', async () => {
        await expect(LmsService._mayDecide(LINKED_SUPER, 137)).resolves.toBe(false);
        await expect(LmsService._mayDecide(LINKED_SUPER, 138)).resolves.toBe(true);
    });

    test('a manager deciding their own uplift is refused even if the line says they govern it', async () => {
        mockEmployees.governs.mockResolvedValue(true);
        await expect(LmsService._mayDecide({ id: 137, userType: 'manager' }, 137)).resolves.toBe(
            false
        );
    });

    test('the pending list is filtered by the same test (out-of-scope rows are not listed)', async () => {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM lms_completions c/.test(sql))
                return [
                    { completionId: 1, employeeId: 500 },
                    { completionId: 2, employeeId: 600 },
                ];
            if (/FROM course_skill_map/.test(sql))
                return [{ skillId: 9, levelDelta: 3, skillName: 'S' }];
            return [];
        });
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM lms_completions WHERE id/.test(sql)) return { employeeId: 500, courseId: 3 };
            if (/FROM skill_assessments/.test(sql)) return { currentLevel: 1 };
            return undefined;
        });
        mockRbac.canAccessEmployee.mockImplementation(async (_u, id) => Number(id) === 500);
        const out = await LmsService.pendingUplifts(LOCAL);
        expect(out.map((r) => r.completionId)).toEqual([1]);
    });
});

describe('B-9 — the LMS webhook secret is encrypted at rest, legacy clear still verifies', () => {
    const LmsService = require('../../src/services/LmsService');
    const prevKey = process.env.APP_KEY;
    beforeAll(() => {
        process.env.APP_KEY = 'c317-test-key';
    });
    afterAll(() => {
        if (prevKey === undefined) delete process.env.APP_KEY;
        else process.env.APP_KEY = prevKey;
    });

    test('upsertIntegration never writes the secret in clear', async () => {
        mockDb.run.mockResolvedValue({ changes: 1 });
        mockDb.get.mockResolvedValue({ provider: 'moodle' });
        await LmsService.upsertIntegration('moodle', { name: 'M', webhookSecret: 's3cr3t-value' });
        const params = mockDb.run.mock.calls[0][1];
        const stored = params[4];
        expect(stored).not.toBe('s3cr3t-value');
        // secretBox v2, purpose-bound (v1 is read-only since SA-18 was closed).
        expect(String(stored)).toMatch(/^enc:v2:lms:/);
        expect(JSON.stringify(mockDb.run.mock.calls)).not.toContain('s3cr3t-value');
    });

    test('an encrypted secret verifies the right value and refuses a wrong one', async () => {
        const secretBox = require('../../src/utils/secretBox');
        const stored = secretBox.encrypt('s3cr3t-value');
        mockDb.get.mockResolvedValue({ enabled: true, webhookSecret: stored });
        await expect(LmsService.verifyWebhookSecret('moodle', 's3cr3t-value')).resolves.toBe(true);
        await expect(LmsService.verifyWebhookSecret('moodle', stored)).resolves.toBe(false);
        await expect(LmsService.verifyWebhookSecret('moodle', 'nope')).resolves.toBe(false);
    });

    test('a legacy clear-text secret keeps working (no migration required)', async () => {
        mockDb.get.mockResolvedValue({ enabled: true, webhookSecret: 'legacy-clear' });
        await expect(LmsService.verifyWebhookSecret('moodle', 'legacy-clear')).resolves.toBe(true);
    });

    test('an undecryptable blob fails CLOSED', async () => {
        mockDb.get.mockResolvedValue({ enabled: true, webhookSecret: 'enc:v1:AAAA:BBBB:CCCC' });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(
            LmsService.verifyWebhookSecret('moodle', 'enc:v1:AAAA:BBBB:CCCC')
        ).resolves.toBe(false);
        spy.mockRestore();
    });
});
