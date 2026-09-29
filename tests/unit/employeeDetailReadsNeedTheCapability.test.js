'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/security]: « Un administrateur borné à qui
 * l'on a REFUSÉ view_employees lit quand même les évaluations, l'historique, le
 * développement, la chronologie et la progression ».
 *
 * Real. `GET /employees/:id` carried BOTH gates — `requireEmployeeRead` (the
 * view_employees capability) and `checkEmployeeAccess` (scope). Six sibling
 * reads carried only the second:
 *
 *     router.get('/employees/:id/assessments', requireNumericParam('id'),
 *                checkEmployeeAccess, …)
 *
 * checkEmployeeAccess answers "may you see THIS person". It never answers "may
 * you see employee data at all" — that is what the capability is for. So an
 * admin whose view_employees had been deliberately withheld still read the
 * rating history, development record, timeline and progression of everyone
 * inside their scope. The withheld capability bought nothing.
 *
 * Audited across the router rather than fixed one at a time: 8 GET routes sit
 * under /employees/:id, 1 was correctly gated, 1 (`/edit`) is gated on
 * edit_employees — which IMPLIES view_employees — and the other 6 had nothing.
 * All six now carry the same gate, placed FIRST so a principal with no
 * capability is refused before an id is even parsed.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const SRC = read('src/routes/index.js');

/** The guard list of a GET registration: path → where the handler begins. */
const guardsOf = (route) => {
    const re = new RegExp(`router\\.get\\(\\s*'${route.replace(/[/:]/g, '\\$&')}',`);
    const i = SRC.search(re);
    expect(i).toBeGreaterThan(-1);
    const ends = [SRC.indexOf('=>', i), SRC.indexOf(';', i)].filter((n) => n > -1);
    return SRC.slice(i, ends.length ? Math.min(...ends) : i + 400);
};

const DETAIL_READS = [
    '/employees/:id/assessments',
    '/employees/:id/assessments/history',
    '/employees/:id/assessments/history/:skillId',
    '/employees/:id/development',
    '/employees/:id/timeline',
    '/employees/:id/progress',
];

describe('every employee-detail read needs the capability, not just the scope', () => {
    test.each(DETAIL_READS)('%s carries requireEmployeeRead', (route) => {
        expect(guardsOf(route)).toMatch(/requireEmployeeRead/);
    });

    test.each(DETAIL_READS)('%s still carries the scope check too', (route) => {
        // The capability must ADD to the scope check, never replace it:
        // holding view_employees does not make everyone visible.
        expect(guardsOf(route)).toMatch(/checkEmployeeAccess/);
    });

    test('the capability is checked BEFORE the id is parsed', () => {
        for (const route of DETAIL_READS) {
            const g = guardsOf(route);
            expect(g.indexOf('requireEmployeeRead')).toBeLessThan(g.indexOf('requireNumericParam'));
        }
    });

    test('the record itself was already right, and stays right', () => {
        const g = guardsOf('/employees/:id');
        expect(g).toMatch(/requireEmployeeRead/);
        // The read variant (3.23.15) still runs the scope check first.
        expect(g).toMatch(/checkEmployee(Read)?Access/);
    });
});

describe('the gate it uses actually withholds from a capability-less admin', () => {
    const RBACService = require('../../src/services/RBACService');

    test('an admin with no permissions does not hold view_employees', () => {
        const bare = { id: 9, userType: 'admin', role: 'localadmin', permissions: [] };
        expect(RBACService.hasPermission(bare, 'view_employees')).toBe(false);
    });

    test('edit_employees IMPLIES it — /edit is gated correctly by the stronger slug', () => {
        const P = require('../../src/config/permissions');
        expect(P.expandSlugs(['edit_employees'])).toContain('view_employees');
        expect(guardsOf('/employees/:id/edit')).toMatch(/edit_employees/);
    });

    test('an employee or manager is not blocked — they must reach their own record', () => {
        // requireEmployeeRead lets those user types through to checkEmployeeAccess,
        // which is what restricts a plain employee to themselves.
        const def = SRC.slice(
            SRC.indexOf('const requireEmployeeRead'),
            SRC.indexOf('router.get', SRC.indexOf('const requireEmployeeRead'))
        );
        expect(def).toMatch(/'employee' \|\| t === 'manager'/);
        expect(def).toMatch(/return next\(\)/);
    });
});
