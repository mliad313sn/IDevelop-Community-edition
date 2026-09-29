'use strict';

// Lot 0 F1 (L1-05 / L3-01 / L5C-01): employee-acting writes imply the scoped
// read, and the catalogue lint refuses a write-on-employees slug without it.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const P = require('../../src/config/permissions');

describe('Lot 0 F1 — implied reads', () => {
    test.each([
        'reset_employee_password',
        'approve_assessments',
        'manage_cycles',
        'manage_onboarding',
        'manage_assessments',
    ])('%s implies view_employees (a delegate can open /employees to exercise it)', (slug) => {
        expect(P.expandSlugs([slug])).toContain('view_employees');
        expect(P.BY_SLUG[slug].actsOn).toBe('employees');
    });

    test('every employee-acting write is in EMPLOYEE_ACTING_WRITES and implies the read', () => {
        expect(P.EMPLOYEE_ACTING_WRITES).toEqual(
            expect.arrayContaining([
                'edit_employees',
                'reset_employee_password',
                'manage_employees',
                'manage_assessments',
                'manage_cycles',
                'manage_onboarding',
                'approve_assessments',
            ])
        );
        P.EMPLOYEE_ACTING_WRITES.forEach((s) =>
            expect(P.expandSlugs([s])).toContain('view_employees')
        );
    });

    test('view_employees itself is still the floor (implies nothing)', () => {
        expect(P.expandSlugs(['view_employees'])).toEqual(['view_employees']);
    });
});

describe('Lot 0 F1 — assertCatalogConsistent (lint)', () => {
    test('the shipped catalogue passes', () => {
        expect(P.assertCatalogConsistent()).toBe(true);
    });

    test('a write-on-employees slug WITHOUT its read implication is refused', () => {
        const bad = P.PERMISSIONS.map((p) =>
            p.slug === 'reset_employee_password' ? { ...p, implies: [] } : p
        );
        expect(() => P.assertCatalogConsistent(bad)).toThrow(
            /reset_employee_password.*does not imply "view_employees"/
        );
    });

    test('a transitive implication satisfies the lint (manage_employees → edit_employees → view_employees)', () => {
        const viaEdit = P.PERMISSIONS.map((p) =>
            p.slug === 'manage_employees' ? { ...p, implies: ['edit_employees'] } : p
        );
        expect(P.assertCatalogConsistent(viaEdit)).toBe(true);
    });

    test('an implies target that does not exist is refused', () => {
        const bad = P.PERMISSIONS.map((p) =>
            p.slug === 'manage_roles' ? { ...p, implies: ['view_rolez'] } : p
        );
        expect(() => P.assertCatalogConsistent(bad)).toThrow(/unknown slug "view_rolez"/);
    });

    test('an unknown actsOn subject is refused', () => {
        const bad = P.PERMISSIONS.map((p) =>
            p.slug === 'manage_surveys' ? { ...p, actsOn: 'surveys' } : p
        );
        expect(() => P.assertCatalogConsistent(bad)).toThrow(/unknown subject "surveys"/);
    });

    test('the lint runs at require time (source pin)', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/config/permissions.js'),
            'utf8'
        );
        expect(src).toMatch(/^assertCatalogConsistent\(\);/m);
    });
});

describe('Lot 0 F1 — missingReadImplications (grant-form advisory)', () => {
    test('lists employee-acting writes posted without view_employees', () => {
        expect(P.missingReadImplications(['manage_cycles', 'export_data'])).toEqual([
            'manage_cycles',
        ]);
        expect(
            P.missingReadImplications(['reset_employee_password', 'approve_assessments']).sort()
        ).toEqual(['approve_assessments', 'reset_employee_password']);
    });
    test('is empty when view_employees is part of the grant, or nothing acts on employees', () => {
        expect(P.missingReadImplications(['manage_cycles', 'view_employees'])).toEqual([]);
        expect(P.missingReadImplications(['export_data', 'manage_roles'])).toEqual([]);
        expect(P.missingReadImplications(undefined)).toEqual([]);
    });
    test('AdminController flashes the advisory on grant (source pin)', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/AdminController.js'),
            'utf8'
        );
        expect(src).toMatch(/missingReadImplications/);
        expect(src).toMatch(/perm_read_implied_warning/);
        // both create and update success paths call the helper
        expect(
            (src.match(/_warnImpliedReads\(req, grantedPerms\)/g) || []).length
        ).toBeGreaterThanOrEqual(3);
    });
    test('both locales carry the advisory text', () => {
        const fr = require('../../locales/fr/admin.json');
        const en = require('../../locales/en/admin.json');
        expect(fr.perm_read_implied_warning).toMatch(/\{\{perms\}\}/);
        expect(en.perm_read_implied_warning).toMatch(/\{\{perms\}\}/);
    });
});
