'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-6 (378), L4-7 (252) and L4-10 (270).
 *
 * L4-6  The full-system JSON import only ever INSERTED. For an employee who
 *       already existed the `if (!employee)` branch wrote nothing, so the
 *       documented workflow — export, correct, re-import — silently discarded
 *       every correction to site, department, service, role, e-mail and phone,
 *       while the import reported success and `results.employees` stayed 0.
 *       It was PARTIAL, which is what hid it: the second pass DID update
 *       supervisor_id and the assessments WERE rewritten. Only the placement was
 *       lost. Verified after the fix: a corrected phone and service survive the
 *       round-trip, and the summary reports 77 updated instead of 0.
 *       G=6, O=7, D=9.
 *
 * L4-7  `isActive` was neither exported nor honoured on import, which hard-coded
 *       `true`. Departed people were exported with no marker and RESURRECTED as
 *       active on the target, inflating every denominator — readiness, coverage,
 *       headcount — by an invisible number. Verified: a leaver now exports as
 *       isActive=false and is still inactive after a re-import. G=7, O=4, D=9.
 *
 * L4-10 The organisation report put the RBAC condition in the WHERE clause on a
 *       LEFT-JOINed employees table, which silently makes it an INNER JOIN. A
 *       VACANT service therefore disappeared for a scoped user while a superadmin
 *       saw it at 0 — precisely the service somebody needs to see in order to
 *       staff it. Measured on identical population: 17 rows for the superadmin,
 *       16 for the scoped user, with "Riverside / IT / Projects" missing. After the
 *       fix: 17 = 17. The correct pattern was already used two functions above.
 *       G=5, O=6, D=9.
 */

const fs = require('fs');
const path = require('path');
const { flat } = require('../helpers/flatSource');
// Layout-proof: prettier reflows the sources these assertions read.
const read = (p) => flat(fs.readFileSync(path.join(__dirname, '../..', p), 'utf8'));

describe('an existing employee is updated, not skipped (L4-6)', () => {
    const svc = read('src/services/UnifiedJsonService.js');

    test('there is an else branch that writes', () => {
        expect(svc).toMatch(
            /await db\.run\(`UPDATE employees SET \$\{sets\.join\(', '\)\} WHERE id = \?`, vals\)/
        );
    });

    test('a placement whose name did not resolve is reported, not nulled', () => {
        // The placement columns are NOT NULL; writing an unresolved name would
        // abort the whole import, and skipping it silently would lose the edit.
        expect(svc).toMatch(/that placement was left unchanged\./);
        expect(svc).toMatch(/if \(site\) put\('siteId', site\.id\)/);
    });

    test('the summary reports what it changed', () => {
        expect(svc).toMatch(/employees: 0, employeesUpdated: 0, assessments: 0/);
        expect(svc).toMatch(
            /results\.employeesUpdated = \(results\.employeesUpdated \|\| 0\) \+ 1/
        );
    });
});

describe('a leaver stays a leaver across a round-trip (L4-7)', () => {
    const svc = read('src/services/UnifiedJsonService.js');

    test('isActive is exported', () => {
        expect(svc).toMatch(/isActive: emp\.isActive !== false && emp\.isActive !== 0/);
    });

    test('the insert honours it instead of hard-coding true', () => {
        expect(svc).toMatch(
            /e\.isActive === undefined \? true : !\(e\.isActive === false \|\| e\.isActive === 0\)/
        );
        expect(svc).not.toMatch(
            /serviceId, roleId, isActive\)\s*\n\s*VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, true\)/
        );
    });

    test('an update carries it too', () => {
        expect(svc).toMatch(/if \(e\.isActive !== undefined\) put\('isActive'/);
    });
});

describe('a vacant service survives a scoped read (L4-10)', () => {
    const svc = read('src/services/ReportBuilderService.js');

    test('the scope is applied in the JOIN, not the WHERE', () => {
        expect(svc).toMatch(
            /LEFT JOIN employees e ON sv\.id = e\.serviceId AND e\.isActive = 1\$\{joinScope\}/
        );
    });

    test('the scope params bind at the JOIN position', () => {
        // Putting them anywhere else silently mis-binds every later placeholder.
        expect(svc).toMatch(/const params = \[\.\.\.rbacFilter\.params\];/);
    });

    test('it now matches the role report, which had it right all along', () => {
        expect(svc).toMatch(
            /LEFT JOIN employees e ON r\.id = e\.roleId AND e\.isActive = 1\$\{joinScope\}/
        );
        const joinScopes =
            svc.match(
                /const joinScope = rbac(?:Filter)?\.condition \? ` AND \(\$\{rbac(?:Filter)?\.condition\}\)` : '';/g
            ) || [];
        expect(joinScopes.length).toBe(2);
    });
});
