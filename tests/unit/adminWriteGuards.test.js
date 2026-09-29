'use strict';

// This suite lazily requires RBACService (→ config/database), which refuses to
// load without DATABASE_URL. It used to inherit the value from whichever OTHER
// test file jest happened to run first in the same worker process, so it passed
// or failed purely on file distribution. Set it here — the same idiom the other
// db-touching suites use — so the suite stands on its own.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Regression guard for the authorization bypass found in the access-scalability
 * review: several admin-reachable WRITE routes were gated on ROLE SHAPE only
 * (`requireAdmin` / `requireManagerOrAdmin`), never on a permission slug. The
 * practical effect was measured on the live install: a read-only Viewer and all
 * 25 zero-permission local admins could approve 9-box placements, bulk-approve
 * self-assessments, finalize calibrations, decide mobility applications and
 * cancellations, and run engagement surveys — while `hasPermission()` said no.
 *
 * These tests fail if:
 *   (a) any of those specific decision routes loses its permission-bearing guard, or
 *   (b) a role-shape-only guard admits a principal that holds no capability, or
 *   (c) a retired role tier becomes assignable again.
 */

const { PERMISSIONS, ALL_SLUGS, WRITE_SLUGS, isWrite } = require('../../src/config/permissions');

// The four decision slugs introduced to close the gap.
const DECISION_SLUGS = [
    'approve_assessments',
    'manage_talent_reviews',
    'manage_mobility',
    'manage_surveys',
];

describe('permission catalogue — decision rights exist and are write-typed', () => {
    test.each(DECISION_SLUGS)('%s is defined and marked as a write capability', (slug) => {
        expect(ALL_SLUGS).toContain(slug);
        expect(WRITE_SLUGS.has(slug)).toBe(true);
        expect(isWrite(slug)).toBe(true);
    });

    test('every catalogue entry is fully specified (slug/label/group/description)', () => {
        for (const p of PERMISSIONS) {
            expect(typeof p.slug).toBe('string');
            expect(p.slug.length).toBeGreaterThan(0);
            expect(typeof p.label).toBe('string');
            expect(typeof p.group).toBe('string');
            expect(typeof p.description).toBe('string');
        }
    });

    test('any `implies` target is itself a real slug (no dangling implication)', () => {
        for (const p of PERMISSIONS) {
            for (const t of p.implies || []) expect(ALL_SLUGS).toContain(t);
        }
    });
});

describe('the decision routes carry a permission-bearing guard', () => {
    // Read the route sources and assert the guard on each specific path. This is a
    // source-level assertion on purpose: it pins the exact routes that were bypassed
    // and reads clearly in a security review.
    const fs = require('fs');
    const path = require('path');
    const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

    const CASES = [
        [
            'src/routes/index.js',
            '/api/self-assessment/employee/:employeeId/approve-all',
            'approve_assessments',
        ],
        ['src/routes/index.js', '/api/ninebox/:id/approve', 'manage_talent_reviews'],
        ['src/routes/index.js', '/cancellations/:id/decide', 'manage_mobility'],
        ['src/routes/index.js', '/reviews/post-approval/:id/decide', 'approve_assessments'],
        ['src/routes/v2-capability.js', '/calibration/:id/finalize', 'manage_talent_reviews'],
        ['src/routes/v2-capability.js', '/calibration/:id/adjust', 'manage_talent_reviews'],
        ['src/routes/v2-capability.js', '/opportunity/application/:id/decide', 'manage_mobility'],
        ['src/routes/v2-capability.js', '/survey/:id/open', 'manage_surveys'],
        ['src/routes/v2-capability.js', '/survey/:id/close', 'manage_surveys'],
    ];

    // The REGISTRATION of a route — its path and its guard list — however it is
    // laid out. Reading "the line containing the path" assumed the whole
    // registration fits on one line; prettier breaks it across several as soon
    // as it overflows, and the guards then live on lines of their own. The
    // guard list always ends where the handler begins, so cut there.
    const registration = (src, route) => {
        const lit = src.indexOf(`'${route}'`);
        if (lit < 0) return undefined;
        const start = src.lastIndexOf('router.', lit);
        if (start < 0) return undefined;
        const candidates = [src.indexOf('=>', lit), src.indexOf(';', lit)].filter((i) => i > -1);
        const end = candidates.length ? Math.min(...candidates) : lit + 400;
        return src.slice(start, end);
    };

    test.each(CASES)('%s %s is gated on %s', (file, route, slug) => {
        const src = read(file);
        const line = registration(src, route);
        expect(line).toBeDefined();
        // Must reference the slug, and must NOT fall back to a role-shape-only guard.
        expect(line).toContain(slug);
        expect(line).not.toMatch(/requireManagerOrAdmin\s*,/);
        expect(line).not.toMatch(/requireAdmin\s*,/);
    });
});

describe('decision services are catalogue-driven, not role-shape-driven', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

    test.each([
        ['src/services/CancellationService.js', 'manage_mobility'],
        ['src/services/PostApprovalReviewService.js', 'approve_assessments'],
    ])('%s decides via hasPermission(%s)', (file, slug) => {
        const src = read(file);
        expect(src).toContain(`hasPermission(user, '${slug}')`);
        // The old OR-over-role-names admitted read-only viewers and the dead hr_bp role.
        expect(src).not.toMatch(/\[\s*'superadmin',\s*'localadmin',\s*'hr_bp'\s*\]/);
    });

    test('org-wide PIP overview no longer keys off the retired hr_bp role name', () => {
        const src = read('src/controllers/DashboardV2Controller.js');
        expect(src).not.toContain("req.user.role !== 'hr_bp'");
        expect(src).toContain('arbitrate_disputes');
    });
});

describe('a principal with no capability cannot pass a catalogue check', () => {
    const RBACService = require('../../src/services/RBACService');

    const viewer = { id: 99, userType: 'admin', role: 'viewer', permissions: [] };
    const powerlessLocalAdmin = { id: 98, userType: 'admin', role: 'localadmin', permissions: [] };

    test.each(DECISION_SLUGS)('read-only viewer is denied %s', (slug) => {
        expect(RBACService.hasPermission(viewer, slug)).toBe(false);
    });

    test.each(DECISION_SLUGS)('zero-permission local admin is denied %s', (slug) => {
        expect(RBACService.hasPermission(powerlessLocalAdmin, slug)).toBe(false);
    });

    test('a viewer can never hold a write slug even if one is somehow granted', () => {
        const rogue = {
            id: 97,
            userType: 'admin',
            role: 'viewer',
            permissions: [...DECISION_SLUGS],
        };
        for (const slug of DECISION_SLUGS)
            expect(RBACService.hasPermission(rogue, slug)).toBe(false);
    });

    test('a superadmin implicitly holds the new decision rights', () => {
        const su = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };
        for (const slug of DECISION_SLUGS) expect(RBACService.hasPermission(su, slug)).toBe(true);
    });

    test('a correctly granted local admin does hold the right', () => {
        const granted = {
            id: 96,
            userType: 'admin',
            role: 'localadmin',
            permissions: ['manage_mobility'],
        };
        expect(RBACService.hasPermission(granted, 'manage_mobility')).toBe(true);
        expect(RBACService.hasPermission(granted, 'manage_surveys')).toBe(false);
    });
});

describe('retired role tiers are not assignable', () => {
    const AdminModel = require('../../src/models/AdminModel');

    test.each(['regional_admin', 'country_admin', 'site_admin', 'hr_bp'])(
        'creating an admin with role %s is refused',
        async (role) => {
            await expect(AdminModel.create({ username: 'x', role })).rejects.toThrow(
                /Unsupported admin role/
            );
        }
    );

    test.each(['superadmin', 'localadmin', 'viewer'])('role %s passes validation', (role) => {
        expect(() => AdminModel._assertRole({ role })).not.toThrow();
    });

    test('an update that does not touch role is unaffected', () => {
        expect(() => AdminModel._assertRole({ email: 'a@b.c' })).not.toThrow();
    });
});
