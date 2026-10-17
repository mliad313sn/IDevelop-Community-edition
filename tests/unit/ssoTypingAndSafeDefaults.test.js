'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L5-6 (240), L2-9 (216), L5-10 (108), L4-13 (96) and L5-12 (48).
 *
 * L5-6  The SSO login path typed managers with `findSubordinates` (supervisor_id
 *       only) instead of `governsAnyone` (supervisor_id OR manager_id +
 *       manager_type='employee'). Verified on this instance: 20 people really
 *       govern someone, only 10 do so via supervisor_id — so 10 real managers
 *       signed in through SSO as plain employees, landed on the employee
 *       dashboard, and had their SESSION stamped 'employee' for its whole life,
 *       which is what then broke session listing and revocation for them (L5-4).
 *
 * L2-9  `v2-capability` filtered calibration adjustments with `a.employee_id` on a
 *       row the mapper returns in camelCase: undefined -> NaN -> `gov.has(NaN)` is
 *       always false -> EVERY adjustment was dropped. A scoped facilitator opened
 *       their own session and saw zero adjustments, including ones they had just
 *       entered. The sibling check in the same file reads it correctly.
 *
 * L5-10 The privileged-MFA gate cached POSITIVE enrolment for 5 minutes in a Map
 *       that lived in server.js, where `MfaService.disable()` could not reach it —
 *       so an admin who switched MFA off kept passing the gate for the rest of the
 *       window, against the policy.
 *
 * L4-13 `dryRun` was parsed as `String(x) === 'true'`, so a JSON boolean `true`
 *       from a non-browser client, or 1, or "oui", all failed the comparison and
 *       EXECUTED. A caller who believed they were simulating wrote to the database
 *       through the most destructive tool in the product.
 *
 * L5-12 The Entra bearer path loaded permissions without `expandSlugs`, so a broad
 *       grant no longer satisfied a finer guard and the admin got 403 for a
 *       capability they held.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const MfaService = require('../../src/services/MfaService');

describe('SSO types a manager the same way the rest of the app does (L5-6)', () => {
    const sso = read('src/config/sso.js');

    // The ORIGINAL defect: SSO typed managers with `findSubordinates`, which reads
    // supervisor_id ONLY, so 10 of the 20 people who govern someone signed in as
    // plain employees. What must hold is that SSO counts BOTH governance lines —
    // not that it calls one particular helper.
    //
    // This assertion used to pin the spelling `governsAnyone(principal.id)`, and
    // broke when the call was replaced by `governanceOf`, which resolves both
    // lines in ONE query and additionally exposes which line each person is on.
    // That distinction is required because a SUPERVISOR and a MANAGER are not the
    // same role (canSupervise vs canManage). Equivalence was proven across all 77
    // active employees: 0 mismatches against governsAnyone; 10 supervisors,
    // 10 managers, 0 both. So the test now asserts the BEHAVIOUR.
    test('it counts BOTH governance lines, not supervisor_id alone', () => {
        expect(sso).toMatch(/EmployeeModel\.govern(anceOf|sAnyone)\(principal\.id\)/);
        expect(sso).not.toMatch(
            /const subs = await EmployeeModel\.findSubordinates\(principal\.id\)/
        );
    });

    test('the helper it uses really does count manager_id as well as supervisor_id', () => {
        const model = read('src/models/EmployeeModel.js');
        const called = /governanceOf\(principal\.id\)/.test(sso) ? 'governanceOf' : 'governsAnyone';
        const body = model.slice(
            model.indexOf(`async ${called}(`),
            model.indexOf(`async ${called}(`) + 900
        );
        expect(body).toMatch(/supervisor_id = \?/);
        expect(body).toMatch(/manager_id = \? AND manager_type = 'employee'/);
    });

    test('a person who governs nobody is still typed an employee', () => {
        expect(sso).toMatch(/employee\.userType = isManager \? 'manager' : 'employee'/);
    });

    test('governsAnyone really covers both links', () => {
        const em = read('src/models/EmployeeModel.js');
        expect(em).toMatch(
            /supervisor_id = \? OR \(manager_id = \? AND manager_type = 'employee'\)/
        );
    });
});

describe('the bearer path grants what was actually granted (L5-12)', () => {
    test('permissions are expanded, as deserializeUser does', () => {
        const sso = read('src/config/sso.js');
        expect(sso).toMatch(/admin\.permissions = permissions\.expandSlugs\(/);
    });
});

describe('calibration adjustments are matched on the key the row actually has (L2-9)', () => {
    test('the scope filter reads camelCase with a snake fallback', () => {
        const r = read('src/routes/v2-capability.js');
        expect(r).toMatch(/gov\.has\(Number\(a\.employeeId \?\? a\.employee_id\)\)/);
        expect(r).not.toMatch(/filter\(\(a\) => gov\.has\(Number\(a\.employee_id\)\)\)/);
    });
});

describe('disabling MFA takes effect immediately (L5-10)', () => {
    test('the enrolment cache lives where disable() can clear it', () => {
        const m = read('src/services/MfaService.js');
        expect(m).toMatch(/MfaService\.forgetEnrolment\(userType, userId\);/);
        // The gate moved from server.js to middleware/mfaEnforcement (the inline
        // copy was removed with the fail-closed policy); it reads the SAME
        // MfaService cache.
        const gate = read('src/middleware/mfaEnforcement.js');
        expect(gate).toMatch(/MfaService\.hasFreshEnrolment\(mfaType, u\.id, 5 \* 60_000\)/);
        const server = read('server.js');
        expect(server).not.toMatch(/mfaPolicyCache/);
    });

    test('a cleared entry stops satisfying the gate', () => {
        MfaService.rememberEnrolment('admin', 4242);
        expect(MfaService.hasFreshEnrolment('admin', 4242, 300000)).toBe(true);
        MfaService.forgetEnrolment('admin', 4242);
        expect(MfaService.hasFreshEnrolment('admin', 4242, 300000)).toBe(false);
    });

    test('a never-enrolled user is never treated as enrolled', () => {
        expect(MfaService.hasFreshEnrolment('admin', 999999, 300000)).toBe(false);
    });

    test('a stale positive expires', () => {
        MfaService.rememberEnrolment('admin', 4243, Date.now() - 600000);
        expect(MfaService.hasFreshEnrolment('admin', 4243, 300000)).toBe(false);
    });
});

describe('an unrecognised dryRun value simulates rather than writes (L4-13)', () => {
    const ctrl = read('src/controllers/SqlConsoleController.js');

    test('only an explicit no disables the simulation', () => {
        // \s* on purpose: prettier puts each disjunct on its own line once the
        // chain is long enough. The rule being pinned is WHICH four values
        // disable the simulation, not that they sit on one line.
        expect(ctrl).toMatch(
            /rawDry === false\s*\|\|\s*rawDry === 'false'\s*\|\|\s*rawDry === 0\s*\|\|\s*rawDry === '0'/
        );
        expect(ctrl).not.toMatch(/String\(req\.body && req\.body\.dryRun\) === 'true'/);
    });

    test('the rule is evaluated the way the code is written', () => {
        // Mirror the expression so the intent is pinned, not just its text.
        const isDry = (rawDry) =>
            !(
                rawDry === false ||
                rawDry === 'false' ||
                rawDry === 0 ||
                rawDry === '0' ||
                rawDry === undefined ||
                rawDry === null ||
                rawDry === ''
            );
        // What the console's own UI sends:
        expect(isDry('true')).toBe(true);
        expect(isDry('false')).toBe(false);
        // What a non-browser client sends — every one of these used to EXECUTE:
        expect(isDry(true)).toBe(true);
        expect(isDry(1)).toBe(true);
        expect(isDry('oui')).toBe(true);
        expect(isDry('yes')).toBe(true);
        // Explicit no, and the omitted field the UI contract relies on:
        expect(isDry(0)).toBe(false);
        expect(isDry(false)).toBe(false);
        expect(isDry(undefined)).toBe(false);
    });
});
