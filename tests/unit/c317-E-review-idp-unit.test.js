'use strict';
/**
 * 3.23.17 lane E — edges that need no database: who may move an IDP, and the
 * assigned-reviewer grant for a read-only delegate. (End-to-end behaviour is in
 * c317-E-review-idp-db.test.js, against idevelop_fixtures, rolled back.)
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockEmp = { findById: jest.fn(), governs: jest.fn(), findGovernedIds: jest.fn() };
jest.mock('../../src/models/EmployeeModel', () => mockEmp);
const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'localadmin'),
    isViewer: (u) => Boolean(u && u.userType === 'admin' && u.role === 'viewer'),
    canAccessEmployeeData: jest.fn(),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const IDP = require('../../src/services/IDPService');
const WF = require('../../src/services/SelfAssessmentWorkflowService');

const EMP = { id: 139, supervisorId: 136, managerId: null, managerType: null };
const PLAN = { id: 5, employeeId: 139, status: 'active' };

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue(undefined);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockEmp.findById.mockReset().mockResolvedValue(EMP);
    mockEmp.governs.mockReset().mockResolvedValue(false);
    mockRbac.canAccessEmployeeData.mockReset().mockResolvedValue(false);
});

describe('IDP plan authority', () => {
    test('the direct supervisor may act', async () => {
        await expect(
            IDP.planAuthority({ userType: 'manager', id: 136 }, PLAN)
        ).resolves.toMatchObject({ canAct: true });
    });
    test('the subject never may — even through a linked admin account', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /linked_employee_id/.test(sql) ? { id: 139 } : undefined
        );
        mockRbac.canAccessEmployeeData.mockResolvedValue(true);
        await expect(
            IDP.planAuthority({ userType: 'admin', role: 'localadmin', id: 900 }, PLAN)
        ).resolves.toMatchObject({ canAct: false, isSubject: true });
    });
    test('a read-only delegate never may, clearance or not', async () => {
        mockRbac.canAccessEmployeeData.mockResolvedValue(true);
        await expect(
            IDP.planAuthority({ userType: 'admin', role: 'viewer', id: 901 }, PLAN)
        ).resolves.toMatchObject({ canAct: false });
    });
    test('a stranger may not', async () => {
        await expect(
            IDP.planAuthority({ userType: 'employee', id: 777 }, PLAN)
        ).resolves.toMatchObject({ canAct: false });
    });
    test('archiving an ACTIVE plan needs a reason', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM idp_plans WHERE id/.test(sql) ? PLAN : undefined
        );
        await expect(
            IDP.archivePlan({ idpId: 5, user: { userType: 'manager', id: 136 } })
        ).rejects.toMatchObject({
            code: 'IDP_REASON_REQUIRED',
            status: 400,
        });
    });
});

describe('assigned campaign reviewer — a read-only delegate stays read-only', () => {
    test('viewer assigned for the cycle: may read, may not act', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /FROM cycle_participants cp/.test(sql) ? [{ cycleId: 7 }] : []
        );
        const a = await WF.resolveAuthority({ userType: 'admin', role: 'viewer', id: 901 }, 139, {
            cycleId: 7,
        });
        expect(a.canView).toBe(true);
        expect(a.canSupervise).toBe(false);
        expect(a.canManage).toBe(false);
    });
    test('admin assigned for the cycle (outside clearance) may review it', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /FROM cycle_participants cp/.test(sql) ? [{ cycleId: 7 }] : []
        );
        const a = await WF.resolveAuthority(
            { userType: 'admin', role: 'localadmin', id: 902 },
            139,
            { cycleId: 7 }
        );
        expect(a.canSupervise).toBe(true);
        expect(a.canManage).toBe(false);
    });
});
