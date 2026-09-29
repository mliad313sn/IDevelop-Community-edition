'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Leavers must not appear as if they were current staff.
 *
 * A person processed as a leaver is deactivated (`employees.is_active = false`),
 * but they kept appearing on the employee list and in the skill matrix,
 * indistinguishable from everyone else. The inconsistency showed the intent: a
 * MANAGER's view already excluded them, because `findGovernedIds` filters
 * `AND is_active` — so superadmins and local admins were the only ones still
 * seeing them, by accident rather than by design.
 *
 * Measured before the fix, with one employee deactivated:
 *   employee list (superadmin)  77 rows, leaver listed
 *   skill matrix (superadmin)   77 rows, leaver listed
 *   skill matrix (local admin)  17 rows, leaver listed
 *   a manager's sub-tree        leaver already excluded
 *
 * After: the list shows 76 by default and the matrix 76, `?status=inactive`
 * returns exactly the 1 leaver, and `?status=all` returns 77 with the row
 * flagged.
 *
 * WHY THERE IS STILL A WAY TO SEE THEM: hiding a leaver with no way to list one
 * would make reactivating an account impossible from the UI — the record would
 * be unreachable. The filter keeps them findable; the badge keeps them unmistakable.
 *
 * The skill matrix deliberately has NO such toggle: it exists to rate and develop
 * current staff, so a departed person's row would invite an assessment that cannot
 * mean anything. Reactivation happens from the employee list.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the employee list hides leavers by default', () => {
    const ctrl = read('src/controllers/EmployeeController.js');

    test('active is the default and the only statuses are the three intended', () => {
        expect(ctrl).toMatch(/const STATUSES = \['active', 'inactive', 'all'\]/);
        expect(ctrl).toMatch(
            /const status = STATUSES\.includes\(req\.query\.status\) \? req\.query\.status : 'active'/
        );
    });

    test('the filter maps to a real predicate in both directions', () => {
        expect(ctrl).toMatch(/if \(status === 'active'\) filters\.isActive = true;/);
        expect(ctrl).toMatch(/else if \(status === 'inactive'\) filters\.isActive = false;/);
    });

    test('"all" applies no predicate at all', () => {
        // Neither branch fires, so no isActive condition is added.
        const seg = ctrl.slice(
            ctrl.indexOf('const STATUSES'),
            ctrl.indexOf('if (search) filters.search')
        );
        expect(seg).not.toMatch(/status === 'all'/);
    });

    test('isActive:false survives the model filter loop', () => {
        // A truthiness check would silently drop `false` and make "inactive" behave
        // like "all". The guard must test for undefined/null/'' explicitly.
        const model = read('src/models/EmployeeModel.js');
        expect(model).toMatch(
            /if \(filters\[key\] !== undefined && filters\[key\] !== null && filters\[key\] !== ''\)/
        );
    });

    test('the view is given the status and its options', () => {
        expect(ctrl).toMatch(/status,\s*\n\s*statusOptions: STATUSES,/);
    });
});

describe('a leaver is unmistakable wherever they are shown', () => {
    const view = read('views/pages/employees/index.ejs');

    test('the row is flagged from the real column, not inferred', () => {
        expect(view).toMatch(
            /const empInactive = employee\.isActive === false \|\| employee\.isActive === 0;/
        );
    });

    test('it carries BOTH a muted row and an explicit badge', () => {
        // Styling alone is not a label — colour is not information.
        expect(view).toMatch(/<tr class="<%= empInactive \? 'emp-inactive' : '' %>">/);
        expect(view).toMatch(/class="emp-inactive-badge"/);
        expect(view).toMatch(/\.emp-inactive > td \{ opacity/);
    });

    test('the badge explains what to do about it', () => {
        expect(view).toMatch(/title="<%= __\('admin:emp_inactive_title'\) %>"/);
        for (const lang of ['fr', 'en']) {
            const j = JSON.parse(read(`locales/${lang}/admin.json`));
            for (const k of [
                'emp_status_filter',
                'emp_status_active',
                'emp_status_inactive',
                'emp_status_all',
                'emp_inactive_badge',
                'emp_inactive_title',
            ]) {
                expect(typeof j[k]).toBe('string');
                expect(j[k].length).toBeGreaterThan(0);
            }
            // The tooltip must say how to bring them back, not merely that they left.
            expect(j.emp_inactive_title).toMatch(/[Rr]éactiv|[Rr]eactivate/);
        }
    });

    test('the status filter is rendered so a leaver stays reachable', () => {
        expect(view).toMatch(/<select name="status"/);
        expect(view).toMatch(/__\('admin:emp_status_' \+ s\)/);
    });
});

describe('the skill matrix never lists a leaver', () => {
    const ctrl = read('src/controllers/SkillMatrixController.js');

    test('deactivated employees are filtered out of the assessable population', () => {
        expect(ctrl).toMatch(
            /scoped = scoped\.filter\(\(e\) => e\.isActive !== false && e\.isActive !== 0\)/
        );
    });

    test('the filter runs before pagination, so the total is honest', () => {
        const filterAt = ctrl.indexOf('scoped.filter((e) => e.isActive');
        const sliceAt = ctrl.indexOf('scoped.slice(');
        expect(filterAt).toBeGreaterThan(-1);
        expect(sliceAt).toBeGreaterThan(-1);
        expect(filterAt).toBeLessThan(sliceAt);
    });

    test('the reason it has no toggle is recorded', () => {
        expect(ctrl).toMatch(/no "show leavers" toggle here/);
    });
});
