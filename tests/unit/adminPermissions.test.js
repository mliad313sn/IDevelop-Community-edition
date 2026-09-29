'use strict';

// RBACService pulls in the DB config module, which refuses to load without a
// DATABASE_URL. hasPermission() is pure (never connects), so a placeholder URL
// is enough to let the module graph initialise in a no-DB unit run.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const {
    PERMISSIONS,
    ALL_SLUGS,
    WRITE_SLUGS,
    BY_SLUG,
    GROUPS,
    isValidSlug,
    isWrite,
    expandSlugs,
} = require('../../src/config/permissions');
const RBACService = require('../../src/services/RBACService');

describe('permission catalog', () => {
    test('every permission has the required shape', () => {
        PERMISSIONS.forEach((p) => {
            expect(typeof p.slug).toBe('string');
            expect(typeof p.label).toBe('string');
            expect(typeof p.description).toBe('string');
            expect(GROUPS).toContain(p.group);
            expect(typeof p.write).toBe('boolean');
        });
    });

    test('slugs are unique and match ALL_SLUGS', () => {
        const set = new Set(ALL_SLUGS);
        expect(set.size).toBe(PERMISSIONS.length);
    });

    test('WRITE_SLUGS only contains write permissions', () => {
        [...WRITE_SLUGS].forEach((s) => expect(isWrite(s)).toBe(true));
    });

    test('isValidSlug rejects unknown slugs', () => {
        expect(isValidSlug('manage_roles')).toBe(true);
        expect(isValidSlug('totally_made_up')).toBe(false);
    });

    test('known capabilities are present with correct write flags', () => {
        expect(ALL_SLUGS).toEqual(
            expect.arrayContaining([
                'manage_employees',
                'manage_assessments',
                'manage_organization',
                'manage_domains_skills',
                'manage_roles',
                'manage_app_settings',
                'export_data',
                'import_data',
                'view_system_logs',
                'manage_admins',
            ])
        );
        expect(isWrite('export_data')).toBe(false);
        expect(isWrite('view_system_logs')).toBe(false);
        expect(isWrite('manage_roles')).toBe(true);
        expect(isWrite('import_data')).toBe(true);
    });

    test('finer-grained view/edit slugs exist with correct write flags', () => {
        expect(ALL_SLUGS).toEqual(
            expect.arrayContaining([
                'edit_employees',
                'reset_employee_password',
                'view_domains_skills',
                'view_roles',
                'view_app_settings',
            ])
        );
        // read-only variants must not be write
        ['view_domains_skills', 'view_roles', 'view_app_settings'].forEach((s) =>
            expect(isWrite(s)).toBe(false)
        );
        // sensitive employee actions are write
        expect(isWrite('edit_employees')).toBe(true);
        expect(isWrite('reset_employee_password')).toBe(true);
    });

    test('every implies target references a valid slug', () => {
        PERMISSIONS.forEach((p) => {
            if (Array.isArray(p.implies)) {
                p.implies.forEach((t) => expect(isValidSlug(t)).toBe(true));
            }
        });
    });
});

describe('permission implication (backward compatibility)', () => {
    test('manage_employees implies edit + reset (so existing grants still pass)', () => {
        const expanded = expandSlugs(['manage_employees']);
        expect(expanded).toEqual(
            expect.arrayContaining([
                'manage_employees',
                'edit_employees',
                'reset_employee_password',
            ])
        );
    });

    test('manage_* config grants imply their read-only viewer', () => {
        expect(expandSlugs(['manage_roles'])).toContain('view_roles');
        expect(expandSlugs(['manage_domains_skills'])).toContain('view_domains_skills');
        expect(expandSlugs(['manage_app_settings'])).toContain('view_app_settings');
    });

    test('a finer grant does NOT imply the coarse one (no upward escalation)', () => {
        const expanded = expandSlugs(['edit_employees']);
        // DOWNWARD only: editing staff necessarily includes reading them
        // (view_employees), but never the coarser or more sensitive grants.
        expect(expanded).toEqual(expect.arrayContaining(['edit_employees', 'view_employees']));
        expect(expanded).toHaveLength(2);
        expect(expanded).not.toContain('manage_employees');
        expect(expanded).not.toContain('reset_employee_password');
    });

    test('the READ tier is the floor — it implies nothing at all', () => {
        // The whole point of view_employees: it can be granted (or withheld)
        // without dragging any write capability along with it.
        expect(expandSlugs(['view_employees'])).toEqual(['view_employees']);
    });

    test('expansion is idempotent and safe on unknown/empty input', () => {
        expect(expandSlugs([])).toEqual([]);
        expect(expandSlugs(['nonexistent'])).toEqual(['nonexistent']);
        const once = expandSlugs(['manage_roles']);
        expect(expandSlugs(once).sort()).toEqual(once.sort());
    });
});

describe('RBACService.hasPermission', () => {
    const superadmin = { userType: 'admin', role: 'superadmin' };
    const localWithRoles = {
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_roles', 'export_data'],
    };
    const localNoGrants = { userType: 'admin', role: 'localadmin', permissions: [] };
    const viewerReadOnly = {
        userType: 'admin',
        role: 'viewer',
        permissions: ['view_system_logs', 'export_data'],
    };
    const viewerWithWrite = { userType: 'admin', role: 'viewer', permissions: ['manage_roles'] };
    const employee = { userType: 'employee', id: 5 };

    test('superadmin holds every permission implicitly', () => {
        ALL_SLUGS.forEach((s) => expect(RBACService.hasPermission(superadmin, s)).toBe(true));
    });

    test('local admin holds only granted slugs', () => {
        expect(RBACService.hasPermission(localWithRoles, 'manage_roles')).toBe(true);
        expect(RBACService.hasPermission(localWithRoles, 'export_data')).toBe(true);
        expect(RBACService.hasPermission(localWithRoles, 'manage_admins')).toBe(false);
        expect(RBACService.hasPermission(localWithRoles, 'manage_organization')).toBe(false);
    });

    test('local admin with no grants holds nothing', () => {
        ALL_SLUGS.forEach((s) => expect(RBACService.hasPermission(localNoGrants, s)).toBe(false));
    });

    test('viewer can exercise read grants but never write grants', () => {
        expect(RBACService.hasPermission(viewerReadOnly, 'view_system_logs')).toBe(true);
        expect(RBACService.hasPermission(viewerReadOnly, 'export_data')).toBe(true);
        // even if a write slug was somehow stored, a viewer cannot use it
        expect(RBACService.hasPermission(viewerWithWrite, 'manage_roles')).toBe(false);
    });

    test('non-admin users never hold admin permissions', () => {
        expect(RBACService.hasPermission(employee, 'manage_roles')).toBe(false);
        expect(RBACService.hasPermission(null, 'manage_roles')).toBe(false);
    });
});
