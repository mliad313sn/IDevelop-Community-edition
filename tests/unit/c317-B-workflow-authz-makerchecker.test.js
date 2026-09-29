'use strict';
/**
 * 3.23.17 — lane B (workflow authz), finding 3: maker-checker by PERSON.
 *
 * The two-person rules compared ACCOUNTS of the same type (employee vs
 * employee, admin vs admin). One human holding an employee account AND an
 * administration account linked to it (admins.linked_employee_id) could raise
 * on one login and decide on the other. Post-approval withdraw also let any
 * admin holding the grant withdraw a case outside their scope.
 *
 * DB mocked. Admin 703 is linked to employee 137; admin 704 names nobody.
 */

const path = require('path');
const DB_PATH = path.join(__dirname, '..', '..', 'src', 'config', 'database.js');
const LINKS = { 703: 137, 704: null };

function linkedRow(sql, params) {
    if (/SELECT linked_employee_id FROM admins WHERE id = \?/.test(sql)) {
        const l = LINKS[Number(params[0])];
        return { linkedEmployeeId: l == null ? null : l };
    }
    return undefined;
}

describe('personIdentity.isSamePerson', () => {
    let isSamePerson;
    beforeAll(() => {
        jest.resetModules();
        jest.doMock(DB_PATH, () => ({ get: jest.fn(async (sql, p) => linkedRow(sql, p)) }));
        ({ isSamePerson } = require('../../src/utils/personIdentity'));
    });

    test.each([
        [{ id: 703, userType: 'admin' }, 'employee:137', true],
        [{ id: 137, userType: 'manager' }, 'admin:703', true],
        [{ id: 703, userType: 'admin' }, { employeeId: 137 }, true],
        [{ id: 137, userType: 'employee' }, { adminId: 703 }, true],
        [{ id: 703, userType: 'admin' }, 'admin:703', true],
        [{ id: 704, userType: 'admin' }, 'employee:137', false], // names nobody
        [{ id: 703, userType: 'admin' }, 'employee:138', false],
        [{ id: 137, userType: 'manager' }, 'employee:138', false],
        [{ id: 703, userType: 'admin' }, 'admin:704', false],
        [{ id: 137, userType: 'manager' }, 'garbage', false],
    ])('%j vs %j → %s', async (user, ref, expected) => {
        await expect(isSamePerson(user, ref)).resolves.toBe(expected);
    });
});

describe('CancellationService.decide — the requester never approves, whichever login they use', () => {
    let svc;
    let db;
    function load(request) {
        jest.resetModules();
        db = {
            get: jest.fn(async (sql, p) => {
                if (/FROM cancellation_requests WHERE id/.test(sql)) return request;
                if (/FOR UPDATE/.test(sql)) return { id: 9, state: 'active' };
                return linkedRow(sql, p);
            }),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 1 })),
            runTransaction: jest.fn(async (f) => f()),
        };
        jest.doMock(DB_PATH, () => db);
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
        jest.doMock('../../src/services/GovernanceService', () => ({
            canReview: jest.fn(async () => true),
        }));
        jest.doMock('../../src/services/RBACService', () => ({
            hasPermission: (u, s) => u.userType === 'admin' && (u.permissions || []).includes(s),
        }));
        svc = require('../../src/services/CancellationService');
    }
    const LINKED = {
        id: 703,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_mobility'],
    };
    const OTHER = {
        id: 704,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_mobility'],
    };
    const REQ_BY_137 = {
        id: 1,
        entityType: 'coaching',
        entityId: 9,
        employeeId: 150,
        state: 'pending',
        byAdmin: null,
        byEmployee: 137,
    };

    test('asked as employee 137, approved on the admin account linked to 137 → refused', async () => {
        load(REQ_BY_137);
        await expect(svc.decide(LINKED, 1, true, 'n')).rejects.toMatchObject({
            userMessage: 'requester_cannot_approve',
        });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('a genuinely different admin may approve', async () => {
        load(REQ_BY_137);
        await expect(svc.decide(OTHER, 1, true, 'n')).resolves.toBe(true);
    });

    test('asked on the linked admin account, decided on the same admin account → refused (unchanged)', async () => {
        load({ ...REQ_BY_137, byAdmin: 703, byEmployee: null });
        await expect(svc.decide(LINKED, 1, false, 'n')).rejects.toMatchObject({
            userMessage: 'requester_cannot_approve',
        });
    });
});

describe('PostApprovalReviewService — raiser never decides; withdraw stays in scope', () => {
    let svc;
    let db;
    let scoped;
    function load(caseRow) {
        jest.resetModules();
        db = {
            get: jest.fn(async (sql, p) => {
                if (/FROM post_approval_reviews WHERE id/.test(sql)) return caseRow;
                return linkedRow(sql, p);
            }),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 1 })),
            runTransaction: jest.fn(async (f) => f()),
        };
        scoped = jest.fn(async () => null);
        jest.doMock(DB_PATH, () => db);
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
        jest.doMock('../../src/utils/rbacScope', () => ({
            scopedEmployeeIds: (...a) => scoped(...a),
        }));
        jest.doMock('../../src/services/RBACService', () => ({
            hasPermission: (u, s) =>
                u.userType === 'admin' &&
                (u.role === 'superadmin' || (u.permissions || []).includes(s)),
        }));
        svc = require('../../src/services/PostApprovalReviewService');
    }
    const LINKED = {
        id: 703,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['approve_assessments'],
    };
    const OTHER = {
        id: 704,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['approve_assessments'],
    };
    const CASE = {
        id: 5,
        selfAssessmentId: 9,
        employeeId: 150,
        skillId: 3,
        proposedLevel: 3,
        state: 'pending',
        raisedBy: 137,
        raisedByAdmin: null,
    };

    test('raised as employee 137, decided on the admin account linked to 137 → refused', async () => {
        load(CASE);
        await expect(svc.decide(LINKED, 5, true, 'n')).rejects.toMatchObject({
            userMessage: 'raiser_cannot_decide',
        });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('nobody decides a re-review of their own score', async () => {
        load({ ...CASE, employeeId: 137, raisedBy: 200 });
        await expect(svc.decide(LINKED, 5, true, 'n')).rejects.toMatchObject({
            userMessage: 'own_assessment',
        });
    });

    test('a different, in-scope admin decides', async () => {
        load(CASE);
        await expect(svc.decide(OTHER, 5, true, 'n')).resolves.toBe(true);
    });

    test('withdraw: an admin with the grant but OUTSIDE the employee scope is refused', async () => {
        load(CASE);
        scoped.mockResolvedValue([1, 2, 3]); // 150 not included
        await expect(svc.withdraw(OTHER, 5)).rejects.toMatchObject({ userMessage: 'out_of_scope' });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('withdraw: the raiser withdraws their own case', async () => {
        load(CASE);
        scoped.mockResolvedValue([]);
        await expect(svc.withdraw({ id: 137, userType: 'manager' }, 5)).resolves.toBe(true);
    });
});

describe('AssessmentChangeRequestService.decide — no deciding your own request on another login', () => {
    const SERVICE = path.join(
        __dirname,
        '..',
        '..',
        'src',
        'services',
        'AssessmentChangeRequestService.js'
    );
    const WF_PATH = path.join(
        __dirname,
        '..',
        '..',
        'src',
        'services',
        'SelfAssessmentWorkflowService.js'
    );
    function load(requesterRef) {
        jest.resetModules();
        const db = {
            get: jest.fn(async (sql, p) => {
                if (/FROM assessment_change_requests WHERE id/.test(sql))
                    return {
                        id: 1,
                        selfAssessmentId: 7,
                        employeeId: 150,
                        cycleId: null,
                        requesterRef,
                        status: 'pending',
                        targetState: 'reviewed',
                        reason: 'r',
                    };
                return linkedRow(sql, p);
            }),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 1 })),
            runTransaction: jest.fn(async (f) => f()),
        };
        jest.doMock(DB_PATH, () => db);
        jest.doMock(WF_PATH, () => ({
            _auth: jest.fn(async () => ({
                canSupervise: true,
                canManage: true,
                isAdmin: true,
                actorType: 'admin',
            })),
            _actorRef: jest.fn((auth, user) => `${auth.isAdmin ? 'admin' : 'employee'}:${user.id}`),
            _assertCycleWritable: jest.fn(async () => {}),
        }));
        return { svc: require(SERVICE), db };
    }

    test('requested as employee:137, decided on admin 703 (linked to 137) → forbidden', async () => {
        const { svc, db } = load('employee:137');
        await expect(
            svc.decide(1, { id: 703, userType: 'admin' }, { decision: 'refused', reason: 'x' })
        ).rejects.toMatchObject({ code: 'forbidden' });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('a different admin passes the two-person gate', async () => {
        const { svc } = load('employee:137');
        // Past the gate the service reads the round; a missing round answers
        // not_found — proof the two-person refusal did not fire.
        await expect(
            svc.decide(1, { id: 704, userType: 'admin' }, { decision: 'refused', reason: 'x' })
        ).rejects.toMatchObject({ code: 'not_found' });
    });
});
