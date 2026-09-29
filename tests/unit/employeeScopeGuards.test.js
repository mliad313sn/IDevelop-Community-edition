'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Object-level authorization (IDOR) guards on employee-targeted routes.
 *
 * Found by an exhaustive audit of all 115 parameterised routes:
 * `/employees/:id/send-credentials` carried `requirePermission('reset_employee_password')`
 * but NOT `checkEmployeeAccess`, while every sibling credential route
 * (reset-password, credentials, activate-account) carried both.
 *
 * That matters because reset_employee_password is a SCOPE-DELEGATED grant — the
 * catalogue describes it as "within the assigned scope". A site-scoped local
 * admin holding it could therefore POST any employee id in the organisation and
 * force a password reset + account activation on a person they do not govern,
 * invalidating that employee's current password and disclosing their username.
 * The service could not save it: OnboardingCredentialService.issueAndSend uses
 * its `actor` argument only for invited_by and the audit row, never for authz.
 *
 * These tests read the route table as text. That is deliberate — the defect was
 * a MISSING MIDDLEWARE in the route declaration, which a handler-level test
 * would not have caught.
 */

const fs = require('fs');
const path = require('path');

const ROUTES = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');

/** The declaration text for a route, from its path literal to the closing of its middleware list. */
function declarationOf(routePath) {
    const idx = ROUTES.indexOf(`'${routePath}'`);
    if (idx === -1) return null;
    return ROUTES.slice(idx, idx + 400);
}

describe('employee-targeted credential routes enforce SCOPE, not just capability', () => {
    // Every route that writes credentials or account state for a specific employee.
    // `/employees/:id/reset-password` and `/employees/:id/activate-account` were
    // REMOVED (Lot B, L3-16): two credential-writing endpoints no view called,
    // replaced by `/employees/:id/credentials`. Their absence is pinned below —
    // an endpoint that nothing calls is an attack surface, not a feature.
    const CREDENTIAL_ROUTES = ['/employees/:id/send-credentials', '/employees/:id/credentials'];
    const REMOVED_ROUTES = ['/employees/:id/reset-password', '/employees/:id/activate-account'];

    test.each(REMOVED_ROUTES)('%s stays removed', (route) => {
        expect(declarationOf(route)).toBeNull();
    });

    test('the scoped account actions of the console keep an explicit scope check', () => {
        // /employees/:id/unlock is guarded inside the handler (scopedEmployeeIds)
        // rather than by the middleware, because it answers JSON.
        expect(declarationOf('/employees/:id/unlock')).toMatch(
            /requirePermission\(\s*'reset_employee_password'\s*\)/
        );
        const ctrl = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/EmployeeController.js'),
            'utf8'
        );
        const unlock = ctrl.slice(
            ctrl.indexOf('async unlock(req, res)'),
            ctrl.indexOf('async sendCredentials(req, res)')
        );
        expect(unlock).toMatch(/scopedEmployeeIds\(req\.user\)/);
        expect(unlock).toMatch(/out_of_scope/);
    });

    test.each(CREDENTIAL_ROUTES)('%s is declared', (route) => {
        expect(declarationOf(route)).not.toBeNull();
    });

    test.each(CREDENTIAL_ROUTES)('%s carries an object-level scope guard', (route) => {
        const decl = declarationOf(route);
        expect(decl).toMatch(/checkEmployeeAccess/);
    });

    test.each(CREDENTIAL_ROUTES)('%s also requires the sensitive capability', (route) => {
        const decl = declarationOf(route);
        expect(decl).toMatch(
            /requirePermission\(\s*'(reset_employee_password|edit_employees)'\s*\)/
        );
    });

    test('the capability guard alone is NOT accepted as sufficient', () => {
        // Guards against a regression where someone "simplifies" the chain by
        // dropping checkEmployeeAccess because a permission is already required.
        const decl = declarationOf('/employees/:id/send-credentials');
        const permOnly = /requirePermission\([^)]*\)\s*,\s*_m55/.test(decl);
        expect(permOnly).toBe(false);
    });
});

describe('scope enforcement is present on every employees/:id write route', () => {
    test('each one has either checkEmployeeAccess, an inline scope check, or is SuperAdmin-only', () => {
        const lines = ROUTES.split('\n');
        const offenders = [];

        lines.forEach((line, i) => {
            if (!/router\.(post|put|patch|delete)\(/.test(line)) return;
            if (!/employees\/:id/.test(line)) return;
            const window = lines.slice(i, i + 25).join('\n');

            const guarded =
                /checkEmployeeAccess/.test(window) || // shared middleware
                /requireSuperAdmin/.test(window) || // unscoped by design
                /scopedEmployeeIds/.test(window) || // inline scope check
                /canAccessEmployee/.test(window) || // service-level check
                /manage_admins/.test(window); // AccountLinkService checks scope internally

            if (!guarded) {
                // The fallback's first slot is unused — named rather than left
                // as an array hole, which reads as a dropped argument.
                const quoted = line.match(/'([^']+)'/);
                offenders.push(quoted ? quoted[1] : line.trim().slice(0, 70));
            }
        });

        expect(offenders).toEqual([]);
    });
});
