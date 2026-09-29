/**
 * An admin account DIRECTLY named manager of an employee (employees.manager_type
 * = 'admin') sees that person in the People list and may open their record —
 * even outside its org scopes — because the SA-review console already lists and
 * authorises exactly that person. READ only: every write path keeps the
 * scope-only guard. And the SA-review console never shows a leaver.
 *
 * Measured before the fix (dev DB, rolled back): an admin named manager of an
 * out-of-scope employee saw them in SA Reviews but not in People (record: 403);
 * a SuperAdmin's SA Reviews carried 2 cards for inactive employees.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));

const RBAC = require('../../src/services/RBACService');
const Gov = require('../../src/services/GovernanceService');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

afterEach(() => jest.restoreAllMocks());

describe('RBACService.canViewEmployee (read-only)', () => {
    const admin = { id: 33, userType: 'admin', role: 'localadmin' };
    const emp = { id: 84, siteId: 9 };

    test('in scope: allowed without consulting the designation', async () => {
        jest.spyOn(RBAC, 'canAccessEmployeeData').mockResolvedValue(true);
        const d = jest.spyOn(Gov, 'adminDesignatedEmployeeIds');
        expect(await RBAC.canViewEmployee(admin, emp)).toBe(true);
        expect(d).not.toHaveBeenCalled();
    });
    test('out of scope but directly designated: allowed', async () => {
        jest.spyOn(RBAC, 'canAccessEmployeeData').mockResolvedValue(false);
        jest.spyOn(Gov, 'adminDesignatedEmployeeIds').mockResolvedValue([84]);
        expect(await RBAC.canViewEmployee(admin, emp)).toBe(true);
    });
    test('out of scope and not designated: refused', async () => {
        jest.spyOn(RBAC, 'canAccessEmployeeData').mockResolvedValue(false);
        jest.spyOn(Gov, 'adminDesignatedEmployeeIds').mockResolvedValue([287]);
        expect(await RBAC.canViewEmployee(admin, emp)).toBe(false);
    });
    test('a manager (employee account) gains nothing from the admin designation rule', async () => {
        jest.spyOn(RBAC, 'canAccessEmployeeData').mockResolvedValue(false);
        const d = jest.spyOn(Gov, 'adminDesignatedEmployeeIds');
        expect(await RBAC.canViewEmployee({ id: 33, userType: 'manager' }, emp)).toBe(false);
        expect(d).not.toHaveBeenCalled();
    });
});

describe('wiring (source guards)', () => {
    test('the record page uses the read guard; edit/update keep the scope-only one', () => {
        const routes = read('src/routes/index.js');
        expect(routes).toMatch(
            /'\/employees\/:id',\s*requireEmployeeRead,\s*requireNumericParam\('id'\),\s*checkEmployeeReadAccess/
        );
        expect(routes).toMatch(/'\/employees\/:id\/edit',[\s\S]{0,200}?checkEmployeeAccess/);
        const ctrl = read('src/controllers/EmployeeController.js');
        const show = ctrl.slice(
            ctrl.indexOf('    async show(req, res) {'),
            ctrl.indexOf('\n    async ', ctrl.indexOf('    async show(req, res) {') + 10)
        );
        expect(show).toMatch(/RBACService\.canViewEmployee\(req\.user, employee\)/);
        const update = ctrl.slice(ctrl.indexOf('    async update(req, res) {'));
        expect(update.slice(0, 1500)).toMatch(
            /RBACService\.canAccessEmployeeData\(req\.user, employee\)/
        );
    });
    test('the People list ORs the designated ids into the admin scope filter', () => {
        const model = read('src/models/EmployeeModel.js');
        expect(model).toMatch(/alsoEmployeeIds = null/);
        expect(model).toMatch(/sc\.push\('e\.id = ANY\(\?\)'\)/);
        const ctrl = read('src/controllers/EmployeeController.js');
        expect(ctrl).toMatch(
            /alsoEmployeeIds\s*=\s*await\s+require\(\s*'\.\.\/services\/GovernanceService'\s*\)\s*\.adminDesignatedEmployeeIds\(\s*req\.user\.id\s*\)/
        );
        // The read guard runs the scope check FIRST and only then the designation.
        const rbac = read('src/services/RBACService.js');
        expect(rbac).toMatch(
            /async canViewEmployee[\s\S]{0,400}?canAccessEmployeeData\(user, employee\)\) return true;[\s\S]{0,200}?adminDesignatedEmployeeIds/
        );
        expect(
            (ctrl.match(/findPageWithOrg\(\{\s*scopes,\s*employeeIds,\s*alsoEmployeeIds,/g) || [])
                .length
        ).toBe(2);
    });
    test('the SA-review queue never lists a leaver, for any caller', () => {
        expect(read('src/services/SelfAssessmentWorkflowService.js')).toMatch(
            /let where = "sa\.workflow_state <> 'draft' AND e\.is_active = true";/
        );
    });
});
