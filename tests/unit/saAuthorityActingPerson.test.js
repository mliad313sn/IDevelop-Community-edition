'use strict';
/**
 * WHO IS ACTING, AND WHAT THAT BUYS THEM.
 *
 * Reported from PRODUCTION and reproduced on a development database
 * (2026-09-15, lot "autorité"):
 *
 *  1. THE BLOCKER — an administration account ERASED the reporting line.
 *     `resolveAuthority` prefixed both hierarchy tests with `!isAdmin &&`, so the
 *     instant `userType` was 'admin' the supervisor/manager link was thrown away
 *     and only the clearance was left. Measured: the same human went from 15
 *     reviewable people (their own team) to 5 (their clearance), NONE of them
 *     theirs — console HTTP 200, queue empty, not one word on screen. And the
 *     login strategy tries the ADMIN table FIRST, so a person whose two accounts
 *     share a login lands on the admin identity without having chosen it.
 *     The database already knew who they were: `admins.linked_employee_id`.
 *     Two authorities held by ONE human ADD UP — a clearance grants a perimeter,
 *     it never takes one away.
 *
 *  2. `manager_type = 'admin'` meant NOTHING. The employee form lets an
 *     administration account be named someone's manager; the named admin drew no
 *     authority at all from it, only from `admin_scopes`. Either the field means
 *     something or the form must not offer it.
 *
 *  3. The mirror-image hole, which must stay shut: `manager_id` is polymorphic
 *     and the id spaces overlap, so the EMPLOYEE whose id equals that ADMIN id
 *     must get nothing.
 *
 * What this pins, and why each line is here:
 *   - the line authority and the clearance are UNIONed, never substituted;
 *   - the sub-tree grants READING only — acting stays on the DIRECT link, which
 *     is the decision taken when the indirect-reviewer defect was closed;
 *   - a bounded admin stays bounded: a Viewer never acts, a local admin acts
 *     inside its clearance and nowhere else;
 *   - an account naming a DEACTIVATED person inherits nothing from them.
 *
 * Behavioural, with the database and the two collaborating models mocked: it
 * runs anywhere, in under a second, and it fails on behaviour rather than on
 * the spelling of a line.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockEmp = {
    findById: jest.fn(),
    governs: jest.fn(),
    findGovernedIds: jest.fn(),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmp);

const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'localadmin'),
    isViewer: (u) => Boolean(u && u.userType === 'admin' && u.role === 'viewer'),
    canAccessEmployeeData: jest.fn(),
    getFilteredEmployees: jest.fn(),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const WF = require('../../src/services/SelfAssessmentWorkflowService');
const Gov = require('../../src/services/GovernanceService');

// Employee 139 — supervised by the PERSON 136, in a site the admin account below
// is NOT cleared for.
const EMPLOYEE_139 = { id: 139, supervisorId: 136, managerId: null, managerType: null, siteId: 11 };

const PERSON_136 = { id: 136, userType: 'manager' };
/** The SAME human's administration account: linked to 136, cleared elsewhere. */
const ADMIN_OF_136 = { id: 838, userType: 'admin', role: 'localadmin' };
const VIEWER_OF_136 = { id: 839, userType: 'admin', role: 'viewer' };

/** `actingPersonId` asks the database for the live person behind the account. */
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
    mockEmp.findById.mockReset().mockResolvedValue(EMPLOYEE_139);
    mockEmp.governs.mockReset().mockResolvedValue(false);
    mockEmp.findGovernedIds.mockReset().mockResolvedValue([]);
    mockRbac.canAccessEmployeeData.mockReset().mockResolvedValue(false);
    mockRbac.getFilteredEmployees.mockReset().mockResolvedValue([]);
});

describe('the person behind the account', () => {
    test('a manager or employee IS the person', async () => {
        await expect(Gov.actingPersonId(PERSON_136)).resolves.toBe(136);
        expect(mockDb.get).not.toHaveBeenCalled(); // no lookup needed
    });

    test('an admin account resolves to admins.linked_employee_id', async () => {
        linkAdminTo(136);
        await expect(Gov.actingPersonId(ADMIN_OF_136)).resolves.toBe(136);
    });

    test('an account naming nobody — or a DEACTIVATED person — resolves to nobody', async () => {
        // The guard lives in the SQL: a departed manager's admin account must not
        // keep governing the team they left.
        linkAdminTo(null);
        await expect(Gov.actingPersonId(ADMIN_OF_136)).resolves.toBeNull();
        const sql = mockDb.get.mock.calls[0][0];
        expect(sql).toMatch(/e\.is_active = true/);
        expect(sql).toMatch(/e\.cancelled_at IS NULL/);
    });

    test('no user is nobody', async () => {
        await expect(Gov.actingPersonId(null)).resolves.toBeNull();
    });
});

describe('THE BLOCKER — an admin identity must not erase the reporting line', () => {
    test('the same human keeps their direct reports when signed in as an admin', async () => {
        linkAdminTo(136);
        mockRbac.canAccessEmployeeData.mockResolvedValue(false); // cleared on ANOTHER site

        const asPerson = await WF.resolveAuthority(PERSON_136, 139);
        const asAdmin = await WF.resolveAuthority(ADMIN_OF_136, 139);

        expect(asPerson.isSupervisor).toBe(true);
        expect(asPerson.canView).toBe(true);
        expect(asPerson.canSupervise).toBe(true);

        // The whole point: the admin identity ADDS a clearance, it does not
        // replace the hierarchy.
        expect(asAdmin.isSupervisor).toBe(true);
        expect(asAdmin.canView).toBe(true);
        expect(asAdmin.canSupervise).toBe(true);
    });

    test('the clearance still counts on its own — the two are a UNION', async () => {
        linkAdminTo(null); // links to nobody
        mockRbac.canAccessEmployeeData.mockResolvedValue(true); // but IS cleared here
        const auth = await WF.resolveAuthority(ADMIN_OF_136, 139);
        expect(auth.canView).toBe(true);
        expect(auth.canSupervise).toBe(true); // local admin in clearance
    });

    test('an admin with neither clearance nor line still gets nothing', async () => {
        linkAdminTo(null);
        mockRbac.canAccessEmployeeData.mockResolvedValue(false);
        const auth = await WF.resolveAuthority(ADMIN_OF_136, 139);
        expect(auth.canView).toBe(false);
        expect(auth.canSupervise).toBe(false);
        expect(auth.canManage).toBe(false);
    });

    test('the queue is scoped by the same union, so the list and the guard agree', async () => {
        linkAdminTo(136);
        mockEmp.findGovernedIds.mockResolvedValue([138, 139, 140]);
        mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 88 }, { id: 89 }]);
        const ids = (await Gov.reviewableEmployeeIds(ADMIN_OF_136))
            .map(Number)
            .sort((a, b) => a - b);
        expect(ids).toEqual([88, 89, 138, 139, 140]);
    });
});

describe('a bounded admin stays bounded, on every path', () => {
    test('a local admin acts inside its CLEARANCE and nowhere else', async () => {
        // Linked to a person who governs 139 through an INTERMEDIATE level, and
        // cleared for nothing: reachable by the reporting line only.
        linkAdminTo(500);
        mockRbac.canAccessEmployeeData.mockResolvedValue(false);
        mockEmp.governs.mockResolvedValue(true); // reachable by the LINE only
        const auth = await WF.resolveAuthority(
            { id: 900, userType: 'admin', role: 'localadmin' },
            139
        );
        expect(auth.canView).toBe(true); // the sub-tree grants reading
        expect(auth.canSupervise).toBe(false); // and never the right to act
        expect(auth.canManage).toBe(false);
    });

    test('a read-only delegation never acts, even carrying a reporting line', async () => {
        linkAdminTo(136); // a supervisor's viewer account
        mockRbac.canAccessEmployeeData.mockResolvedValue(true);
        const auth = await WF.resolveAuthority(VIEWER_OF_136, 139);
        expect(auth.canView).toBe(true); // reads — that is the role
        expect(auth.canSupervise).toBe(false);
        expect(auth.canManage).toBe(false);
    });
});

describe('manager_type is the discriminator, in BOTH directions', () => {
    const MANAGED_BY_ADMIN_33 = {
        id: 287,
        supervisorId: null,
        managerId: 33,
        managerType: 'admin',
        siteId: 11,
    };

    test('the ADMIN named manager draws authority from the designation', async () => {
        mockEmp.findById.mockResolvedValue(MANAGED_BY_ADMIN_33);
        linkAdminTo(null);
        mockRbac.canAccessEmployeeData.mockResolvedValue(false); // no covering scope at all
        const auth = await WF.resolveAuthority(
            { id: 33, userType: 'admin', role: 'localadmin' },
            287
        );
        expect(auth.isManager).toBe(true);
        expect(auth.canView).toBe(true);
        expect(auth.canManage).toBe(true);
    });

    test('the EMPLOYEE who merely shares that number draws nothing', async () => {
        // The two id spaces overlap. This is the over-access half of the same
        // defect and it must stay shut.
        mockEmp.findById.mockResolvedValue(MANAGED_BY_ADMIN_33);
        mockEmp.governs.mockResolvedValue(false);
        const auth = await WF.resolveAuthority({ id: 33, userType: 'employee' }, 287);
        expect(auth.isManager).toBe(false);
        expect(auth.canView).toBe(false);
        expect(auth.canSupervise).toBe(false);
    });

    test('the designation reaches the queue too', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /manager_type = 'admin'/.test(sql) ? [{ id: 287 }] : []
        );
        mockEmp.findGovernedIds.mockImplementation(async (id) => (Number(id) === 287 ? [301] : []));
        const ids = (
            await Gov.lineAuthorityEmployeeIds({ id: 33, userType: 'admin', role: 'localadmin' })
        )
            .map(Number)
            .sort((a, b) => a - b);
        expect(ids).toEqual([287]);
    });

    /**
     * CE QUI A CASSE, mesure par l'integrateur le 16/09/2026, sur une base de
     * developpement, ecritures annulees.
     *
     * Cette liste descendait AUSSI le sous-tree du designe (elle rendait [287, 301]).
     * Le garde par objet, lui, ne resout le sous-arbre que par
     * `EmployeeModel.governs(actingPersonId(user), …)`, et actingPersonId vaut NULL
     * pour un compte d'administration sans linked_employee_id : sa branche isManager
     * ne couvre que la personne DIRECTEMENT designee. Un compte a ZERO habilitation
     * designe manager de 136 voyait donc 16 personnes dans sa file — dont l'employe
     * 138 — et recevait canView=false sur ce meme 138. Une liste qui propose ce que
     * le garde refuse : la forme exacte du defaut que ce programme combat, re-creee
     * dans une branche neuve.
     *
     * CE QUE CE TEST EMPECHE : que les deux surfaces reprennent des chemins
     * differents. Il ne verifie PAS un contenu en particulier, il verifie leur
     * ACCORD — quelle que soit la decision future sur le sous-arbre, elle devra etre
     * prise des deux cotes a la fois ou ce test virera au rouge.
     */
    test('the queue and the guard agree, person by person', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /manager_type = 'admin'/.test(sql) ? [{ id: 287 }] : []
        );
        mockEmp.findGovernedIds.mockImplementation(async (id) => (Number(id) === 287 ? [301] : []));
        linkAdminTo(null);
        mockRbac.canAccessEmployeeData.mockResolvedValue(false); // aucune habilitation
        mockEmp.governs.mockResolvedValue(false);

        const user = { id: 33, userType: 'admin', role: 'localadmin' };
        const queue = (await Gov.lineAuthorityEmployeeIds(user)).map(Number);

        for (const [id, row] of [
            [287, MANAGED_BY_ADMIN_33],
            [
                301,
                { id: 301, supervisorId: 287, managerId: 287, managerType: 'employee', siteId: 11 },
            ],
        ]) {
            mockEmp.findById.mockResolvedValue(row);
            const auth = await WF.resolveAuthority(user, id);
            expect({ id, inQueue: queue.includes(id), canView: auth.canView }).toEqual({
                id,
                inQueue: auth.canView,
                canView: auth.canView,
            });
        }
    });
});

describe('a REVOKED clearance confers nothing', () => {
    test('every scope-matching query excludes revoked rows, like AdminModel does', async () => {
        // "Désactiver" writes revoked_at and KEEPS the row — the house rule is
        // that nothing is deleted. Only this file ignored it, and a withdrawn
        // clearance still opened the review of everyone in the unit who has no
        // supervisor and no manager.
        mockDb.get.mockResolvedValue({ id: 5, supervisorId: null, managerId: null });
        await Gov.coveringAdmins(5);
        await Gov.fallbackEmployeeIdsForAdmin(7);
        const sqls = mockDb.all.mock.calls.map((c) => c[0]);
        expect(sqls.length).toBeGreaterThanOrEqual(2);
        sqls.forEach((sql) => expect(sql).toMatch(/sc\.revoked_at IS NULL/));
    });

    test('the reference is AdminModel.findWithScopes — the two must not drift', async () => {
        // They no longer CAN drift: "this clearance is live" is now one predicate
        // (utils/reviewerGapSql.liveAdminScopeSql) that this file, AdminModel and
        // the orphan worklist / Setup checklist all consume — the fragment that
        // fed those last two filtered `expires_at` alone and counted a REVOKED
        // clearance as cover. Checked on the SQL actually issued, not on the text
        // of the file.
        const AdminModel = require('../../src/models/AdminModel');
        const { liveAdminScopeSql } = require('../../src/utils/reviewerGapSql');
        mockDb.get.mockResolvedValue({ id: 7, username: 'scoped' });
        mockDb.all.mockClear();

        await AdminModel.findWithScopes(7);

        const sql = mockDb.all.mock.calls[0][0];
        expect(sql).toContain(liveAdminScopeSql('acs'));
        expect(sql).toMatch(/acs\.revoked_at IS NULL/);
        expect(sql).toMatch(/acs\.expires_at IS NULL OR acs\.expires_at > now\(\)/);
        // and the very same rule, on the alias this file uses
        expect(liveAdminScopeSql('sc')).toMatch(/sc\.revoked_at IS NULL/);
    });
});
