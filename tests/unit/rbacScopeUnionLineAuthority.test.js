'use strict';
/**
 * THE LIST AND THE GUARD MUST BE SCOPED BY THE SAME AUTHORITY.
 *
 * `RBACService.scopeFilter` is the SQL scope behind every V2 queue and list —
 * the self-assessment review console, the talent queues, the IDP and PIP lists.
 * For an administration account it returned the CLEARANCE and nothing else.
 *
 * So a supervisor or manager who also holds an admin account, signed in on that
 * account, got ` AND 1=0` (or someone else's site) where their own team should
 * have been: an empty review console, HTTP 200, no message, measured on a
 * development database. Meanwhile the per-object guard
 * (`SelfAssessmentWorkflowService.resolveAuthority`) is now resolved on the
 * PERSON — so without this union the two would disagree again, which is the
 * exact shape of the defect the product keeps re-living: a console that lists a
 * population it then refuses, or refuses a population it should list.
 *
 * `GovernanceService.lineAuthorityEmployeeIds` is the ONE resolution of the
 * reporting line. Both surfaces call it. That is what this file protects.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockAdminModel = { findWithScopes: jest.fn() };
jest.mock('../../src/models/AdminModel', () => mockAdminModel);

const mockEmp = {
    findByScopesAndFilters: jest.fn(),
    findGoverned: jest.fn(),
    findGovernedIds: jest.fn(),
    findById: jest.fn(),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmp);

const RBACService = require('../../src/services/RBACService');

const SUPERADMIN = { id: 1, userType: 'admin', role: 'superadmin' };
const LOCAL_ADMIN = { id: 838, userType: 'admin', role: 'localadmin' };
const MANAGER = { id: 136, userType: 'manager' };

/** `GovernanceService.actingPersonId` asks the database who this account is. */
function linkAdminTo(personId) {
    mockDb.get.mockImplementation(async (sql) =>
        /linked_employee_id/.test(sql)
            ? personId == null
                ? undefined
                : { id: personId }
            : undefined
    );
}

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue(undefined);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockAdminModel.findWithScopes.mockReset().mockResolvedValue({ id: 838, scopes: [] });
    mockEmp.findByScopesAndFilters.mockReset().mockResolvedValue([]);
    mockEmp.findGoverned.mockReset().mockResolvedValue([]);
    mockEmp.findGovernedIds.mockReset().mockResolvedValue([]);
});

const idsOf = (sc) => (sc.params[0] || []).map(Number).sort((a, b) => a - b);

describe('scopeFilter — clearance UNION reporting line', () => {
    test('a superadmin is unrestricted', async () => {
        await expect(RBACService.scopeFilter(SUPERADMIN)).resolves.toEqual({
            clause: '',
            params: [],
        });
    });

    test('an admin cleared elsewhere still gets their OWN team', async () => {
        linkAdminTo(136);
        mockAdminModel.findWithScopes.mockResolvedValue({
            id: 838,
            scopes: [{ scopeType: 'site', siteId: 13 }],
        });
        mockEmp.findByScopesAndFilters.mockResolvedValue([{ id: 88 }, { id: 89 }]); // the clearance
        mockEmp.findGovernedIds.mockResolvedValue([138, 139]); // the team

        const sc = await RBACService.scopeFilter(LOCAL_ADMIN);
        expect(sc.clause).toBe(' AND e.id = ANY(?)');
        expect(idsOf(sc)).toEqual([88, 89, 138, 139]); // UNION, de-duplicated
    });

    test('an admin with NO clearance at all is no longer cut off from their team', async () => {
        // This is the measured blocker: ` AND 1=0` on a console that had 15
        // people to review.
        linkAdminTo(136);
        mockAdminModel.findWithScopes.mockResolvedValue({ id: 838, scopes: [] });
        mockEmp.findGovernedIds.mockResolvedValue([138, 139, 140]);

        const sc = await RBACService.scopeFilter(LOCAL_ADMIN);
        expect(sc.clause).toBe(' AND e.id = ANY(?)');
        expect(idsOf(sc)).toEqual([138, 139, 140]);
    });

    test('an admin who is nobody and governs nobody still sees nobody', async () => {
        linkAdminTo(null);
        mockAdminModel.findWithScopes.mockResolvedValue({ id: 838, scopes: [] });
        await expect(RBACService.scopeFilter(LOCAL_ADMIN)).resolves.toEqual({
            clause: ' AND 1=0',
            params: [],
        });
    });

    test("an admin NAMED someone's manager carries that person in the list", async () => {
        linkAdminTo(null);
        mockAdminModel.findWithScopes.mockResolvedValue({ id: 838, scopes: [] });
        mockDb.all.mockImplementation(async (sql) =>
            /manager_type = 'admin'/.test(sql) ? [{ id: 287 }] : []
        );

        const sc = await RBACService.scopeFilter(LOCAL_ADMIN);
        expect(idsOf(sc)).toEqual([287]);
    });

    test('a manager (non-admin) is unchanged: their sub-tree, nothing else', async () => {
        mockEmp.findGovernedIds.mockResolvedValue([138, 139]);
        const sc = await RBACService.scopeFilter(MANAGER);
        expect(sc.clause).toBe(' AND e.id = ANY(?)');
        expect(idsOf(sc)).toEqual([138, 139]);
        expect(mockDb.get).not.toHaveBeenCalled(); // no account lookup for a person
    });

    test('the alias the caller asked for is honoured on the union path', async () => {
        linkAdminTo(136);
        mockEmp.findGovernedIds.mockResolvedValue([138]);
        const sc = await RBACService.scopeFilter(LOCAL_ADMIN, { empAlias: 'emp' });
        expect(sc.clause).toBe(' AND emp.id = ANY(?)');
    });
});
