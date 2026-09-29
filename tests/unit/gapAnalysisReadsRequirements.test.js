'use strict';

/**
 * The manager's primary decision page reported absence of PAPERWORK as absence
 * of GAPS.
 *
 * /supervisor/gap-analysis was built from `supervisor_reviews`, so a requirement
 * with no review row produced no gap — while the page told the manager it
 * measured "par rapport aux niveaux requis de chaque rôle". On a 16-person team:
 *
 *   page said     : 1 employee, 2 gaps
 *   v_employee_skill_gaps for the same 16 : 14 employees, 90 unmet requirements
 *
 * /reports/gaps and /api/dashboard/skill-gaps both gave the correct answer, so
 * the platform contradicted itself on the screen managers act from.
 *
 * After the fix, driving the real page as test.manager:
 *
 *   governed employees 16 · DB truth {employeesWithGaps:14, measuredGaps:90, unmeasured:11}
 *   page rows 15 · sum of Total column 90 · pageerrors 0
 *
 * 15 rather than 14 because one employee has ONLY never-assessed requirements
 * and now appears with an unmeasured count instead of vanishing.
 *
 * A gap stays a MEASURED shortfall (is_assessed = 1). The view coalesces an
 * absent level to 0, so counting unassessed rows as gaps would invent
 * shortfalls nobody observed — the same fabrication corrected in the manager
 * digest and the employee dashboard.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ctrl = fs.readFileSync(
    path.join(__dirname, '../../src/controllers/SupervisorReviewController.js'),
    'utf8'
);
const view = fs.readFileSync(
    path.join(__dirname, '../../views/pages/supervisor/gap-analysis.ejs'),
    'utf8'
);

describe('gap analysis reads role requirements, not review rows', () => {
    test('it queries the canonical gaps view', () => {
        expect(ctrl).toMatch(/FROM v_employee_skill_gaps g/);
    });

    test('it no longer derives the page from supervisor_reviews', () => {
        const fn = ctrl.slice(ctrl.indexOf('async viewGapAnalysis'));
        expect(fn).not.toMatch(/SupervisorReviewModel\.findForReviewer/);
    });

    test('it is scoped with the shared RBAC helper', () => {
        expect(ctrl).toMatch(/const \{ scopedEmployeeIds \} = require\('\.\.\/utils\/rbacScope'\)/);
        expect(ctrl).toMatch(/const ids = await scopedEmployeeIds\(req\.user\)/);
    });

    test('an empty scope shows nothing rather than the whole organisation', () => {
        // ids === null means unrestricted (superadmin); [] means no access.
        expect(ctrl).toMatch(/if \(ids === null \|\| \(Array\.isArray\(ids\) && ids\.length\)\)/);
    });

    test('the measured figures the page was contradicting are recorded', () => {
        expect(ctrl).toMatch(/1 employee with 2 gaps/);
        expect(ctrl).toMatch(/14 employees with 90 unmet requirements/);
    });
});

describe('a gap is a measured shortfall', () => {
    test('totals filter on is_assessed = 1', () => {
        expect(ctrl).toMatch(
            /FILTER \(WHERE g\.is_assessed = 1 AND g\.gap > 0\)::int AS "totalGaps"/
        );
    });

    test('critical gaps mean critical SKILLS, measured', () => {
        expect(ctrl).toMatch(
            /FILTER \(WHERE g\.is_assessed = 1 AND g\.gap > 0 AND g\.is_critical\)::int AS "criticalGaps"/
        );
    });

    test('never-assessed requirements are counted separately', () => {
        expect(ctrl).toMatch(/FILTER \(WHERE g\.is_assessed = 0\)::int AS "unmeasured"/);
    });

    test('an employee with only unmeasured requirements still appears', () => {
        expect(ctrl).toMatch(/OR COUNT\(\*\) FILTER \(WHERE g\.is_assessed = 0\) > 0/);
    });
});

describe('the page shows measurement debt as its own column', () => {
    test('there is an unmeasured column header', () => {
        expect(view).toMatch(/<th><%= __\('dash:rd_not_measured'\) %><\/th>/);
    });

    test('it renders amber, with the "this is not a level 0" explanation', () => {
        expect(view).toMatch(/badge-warning/);
        expect(view).toMatch(/__\('dash:rd_not_measured_title'\)/);
    });

    test('zero unmeasured shows a dash, not a success badge that implies coverage', () => {
        expect(view).toMatch(/<span class="text-muted">—<\/span>/);
    });
});
