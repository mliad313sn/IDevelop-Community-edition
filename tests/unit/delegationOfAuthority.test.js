'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Delegation of authority — the rules that must hold no matter how the code moves.
 *
 * Three defects are pinned here, all found by execution against real data:
 *
 * 1. REGION FAIL-OPEN. `EmployeeModel.findByScopesAndFilters` built an OR-list of
 *    scope conditions and applied it "if non-empty". A region scope matched no
 *    branch, so NO condition was applied and the query returned every employee in
 *    the organisation — measured at 77 of 77. An authority row the code does not
 *    understand must grant NOTHING.
 *
 * 2. COUNTRY SCOPE HALF-IMPLEMENTED. Employees resolved correctly for a
 *    country-scoped admin, but sites and departments came back EMPTY, because six
 *    places interpreted admin_scopes independently and only one knew about
 *    'country'. The visible symptom was the employee EDIT form: with no site
 *    option the cascade never fired and the person's existing site, department
 *    and service appeared to have been wiped.
 *
 * 3. LATERAL ADMIN TAKEOVER. Every admin-on-admin verb gated on the
 *    `manage_admins` capability and "target is not a SuperAdmin", never on what
 *    the TARGET governs. A site-scoped delegate could reset a country-scoped
 *    peer's password and sign in as them — acquiring the very authority the
 *    existing `_granterCanAssignScope` guard forbade them from assigning.
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('scope expansion is centralised and fails closed', () => {
    const resolver = read('src/utils/adminScope.js');

    test('the resolver knows all five scope types the schema allows', () => {
        for (const t of ['region', 'country', 'site', 'department', 'service']) {
            expect(resolver).toContain(`'${t}'`);
        }
    });

    test('an unrecognised scope type yields an EMPTY set, never an absent filter', () => {
        // The guard: scopes are filtered to KNOWN_SCOPE_TYPES, and an empty
        // remainder returns the EMPTY result rather than falling through.
        expect(resolver).toMatch(/KNOWN_SCOPE_TYPES\.includes/);
        expect(resolver).toMatch(/if \(!usable\.length\) return \{ \.\.\.EMPTY/);
    });

    test('expired grants confer nothing', () => {
        expect(resolver).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    });

    test('unrestricted is expressed as null, not as an empty list', () => {
        // `[]` meaning "no restriction" is the polarity that caused the fail-open.
        expect(resolver).toMatch(/employeeIds: null/);
        expect(resolver).toMatch(/unrestricted: true/);
    });
});

describe('the region fail-open cannot come back', () => {
    const model = read('src/models/EmployeeModel.js');

    test('findByScopesAndFilters handles region', () => {
        expect(model).toMatch(/scope\.scopeType === 'region'/);
        expect(model).toMatch(/SELECT id FROM countries WHERE regionId/);
    });

    test('a scope set that matches no branch returns NOTHING rather than everything', () => {
        // The exact regression: previously the `if (scopeConditions.length > 0)`
        // simply skipped the filter, leaving the query unrestricted.
        const block = model.slice(
            model.indexOf('const scopeConditions = []'),
            model.indexOf('// 2. Handle Search')
        );
        expect(block).toMatch(/\}\s*else\s*\{\s*return \[\];/);
    });
});

describe('org-unit lookups use the shared resolver, not their own scope parsing', () => {
    const rbac = read('src/services/RBACService.js');

    test.each(['getFilteredSites', 'getFilteredDepartments', 'getFilteredServices'])(
        '%s resolves through utils/adminScope',
        (fn) => {
            const start = rbac.indexOf(`async ${fn}(`);
            expect(start).toBeGreaterThan(-1);
            const body = rbac.slice(start, start + 700);
            expect(body).toMatch(/resolveAdminScope/);
            // and must NOT go back to hand-filtering raw scope rows
            expect(body).not.toMatch(/scopeType === 'site'/);
        }
    );

    test('individual-record access understands region, so the list and the record agree', () => {
        const start = rbac.indexOf('async canAccessEmployeeData(');
        const body = rbac.slice(start, rbac.indexOf('async canAccessCountry('));
        expect(body).toMatch(/hasRegionScope/);
        // and compares ids loosely — a string/number mismatch silently DENIED a
        // legitimate admin before.
        expect(body).toMatch(/String\(a\) === String\(b\)/);
    });
});

describe('the employee edit form always renders what is already stored', () => {
    const ctrl = read('src/controllers/EmployeeController.js');

    test('editForm resolves scope through the shared resolver', () => {
        const start = ctrl.indexOf('async editForm(');
        const body = ctrl.slice(start, start + 5200);
        expect(body).toMatch(/resolveAdminScope/);
    });

    test("the employee's CURRENT site/department/service is force-included", () => {
        const start = ctrl.indexOf('async editForm(');
        const body = ctrl.slice(start, start + 5200);
        expect(body).toMatch(/ensureOption/);
        for (const f of ['employee.siteId', 'employee.departmentId', 'employee.serviceId']) {
            expect(body).toContain(f);
        }
    });
});

describe('admin-on-admin actions check what the TARGET governs', () => {
    const ctrl = read('src/controllers/AdminController.js');

    test('the containment guard exists and fails closed', () => {
        expect(ctrl).toMatch(/async function _canManageTargetAdmin/);
        // any resolution error denies
        const start = ctrl.indexOf('async function _canManageTargetAdmin');
        const body = ctrl.slice(start, ctrl.indexOf('async function _denyIfOutOfScope'));
        expect(body).toMatch(/catch \(_\) \{\s*return false;/);
        // Lot C extracted the set comparison into `_containsScope` (exported as a
        // test seam and exercised directly in lotC-admin-console.test.js); the
        // "they see all, you do not" rule now lives there.
        expect(body).toMatch(/_containsScope\(mine, theirs\)/);
        const contains = ctrl.slice(
            ctrl.indexOf('function _containsScope'),
            ctrl.indexOf('async function _canManageTargetAdmin')
        );
        expect(contains).toMatch(/theirs\.unrestricted\) return false/);
    });

    test.each([
        ['resetPassword', 'reset another admin’s password'],
        ['unlockAccount', 'unlock another admin'],
        ['forcePasswordChange', 'force a password change'],
        ['extendAccess', 'extend another admin’s access'],
        ['delete', 'delete another admin'],
    ])('%s is guarded', (fn) => {
        const start = ctrl.indexOf(`async ${fn}(req, res)`);
        expect(start).toBeGreaterThan(-1);
        const body = ctrl.slice(start, start + 2600);
        expect(body).toMatch(/_denyIfOutOfScope\(req, res, id\)/);
    });

    test('capability alone is not treated as sufficient', () => {
        // _canManage is the capability check; it must never be the ONLY gate on
        // a mutating admin-on-admin verb.
        const start = ctrl.indexOf('async resetPassword(req, res)');
        const body = ctrl.slice(start, start + 2600);
        const capIdx = body.indexOf('_canManage(req.user)');
        const scopeIdx = body.indexOf('_denyIfOutOfScope');
        expect(capIdx).toBeGreaterThan(-1);
        expect(scopeIdx).toBeGreaterThan(capIdx);
    });
});

describe('the e-mail link address is operator-controlled', () => {
    const tpl = read('src/utils/emailTemplate.js');

    test('an App Setting takes precedence over env and over the request', () => {
        expect(tpl).toMatch(/appBaseUrl/);
        const body = tpl.slice(tpl.indexOf('function baseUrl(req)'), tpl.indexOf('const MUTED'));
        // setting is consulted before the env fallback
        expect(body.indexOf('_settingBase')).toBeLessThan(body.indexOf('APP_BASE_URL'));
    });

    test('a Host header is only ever honoured from an explicit allowlist', () => {
        const body = tpl.slice(tpl.indexOf('function baseUrl(req)'), tpl.indexOf('const MUTED'));
        expect(body).toMatch(/TRUSTED_HOSTS/);
        expect(body).toMatch(/trusted\.includes\(host\)/);
    });
});
