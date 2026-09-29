'use strict';
// Satisfy the presence check in src/config/database.js WITHOUT connecting — the
// helpers under test never touch the DB (connection is lazy, on db.connect()).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/testdummy';
/**
 * Regression tests for the pre-production deep-review fixes (DB-free).
 * Each `describe` pins a specific bug that was fixed so it cannot silently
 * regress. DB-dependent fixes are covered by scripts/verify-preprod-fixes.js.
 */

describe('rewriteRowKeys — leading-underscore alias survives (v3.18.4 pager-NaN root cause)', () => {
    const { rewriteRowKeys } = require('../../src/database/PostgresDatabase');

    test('a `_total` alias is NOT folded to `Total`', () => {
        const out = rewriteRowKeys({ _total: 42, site_id: 7 });
        expect(out._total).toBe(42);
        expect(out.Total).toBeUndefined();
        expect(out.siteId).toBe(7); // normal snake_case still camelCases
    });

    test('internal snake_case still folds', () => {
        const out = rewriteRowKeys({ workflow_state: 'x', manager_id: 3, _foo_bar: 1 });
        expect(out.workflowState).toBe('x');
        expect(out.managerId).toBe(3);
        expect(out._fooBar).toBe(1); // leading underscore kept, rest folds
    });
});

describe('NotificationService._inQuietHours — camelCased pref keys are honoured', () => {
    const NotificationService = require('../../src/services/NotificationService');

    test('camelCase pref inside the window returns true', () => {
        // Force a fixed "now" inside 00:00–23:59 by choosing a window that always contains it.
        const pref = { quietHoursStart: '00:00', quietHoursEnd: '23:59' };
        expect(NotificationService._inQuietHours(pref)).toBe(true);
    });

    test('missing window returns false', () => {
        expect(NotificationService._inQuietHours({})).toBe(false);
        expect(NotificationService._inQuietHours(null)).toBe(false);
    });

    test('snake_case shape still accepted (back-compat)', () => {
        const pref = { quiet_hours_start: '00:00', quiet_hours_end: '23:59' };
        expect(NotificationService._inQuietHours(pref)).toBe(true);
    });
});

describe('ReportBuilderService — SELECT/GROUP lists whitelist client fields', () => {
    const svc = require('../../src/services/ReportBuilderService');
    const mapping = { firstName: 'e.firstName', siteName: 's.name' };

    test('unknown fields are dropped from the SELECT list (no raw alias injection)', () => {
        const out = svc.buildSelectList(['firstName', 'evil AS x; DROP', 'siteName'], mapping);
        expect(out).toBe('e.firstName AS "firstName", s.name AS "siteName"');
        expect(out).not.toMatch(/DROP/);
    });

    test('aliases are double-quoted so they round-trip to the field key', () => {
        expect(svc.buildSelectList(['firstName'], mapping)).toBe('e.firstName AS "firstName"');
    });

    test('groupBy list drops unknown fields', () => {
        expect(svc.buildGroupList(['siteName', 'bogus'], mapping)).toBe('s.name');
        expect(svc.buildGroupList([], mapping)).toBe('');
    });
});
