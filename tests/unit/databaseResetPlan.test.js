'use strict';
/**
 * Data Management → Reset database: the wipe order comes from the LIVE
 * foreign-key graph, never from a hand-kept list.
 *
 * Measured on the customer appliance (2026-09-09): with a single coaching
 * session on file the reset died on
 *   update or delete on table "employees" violates foreign key constraint
 *   "fk_coaching_sessions_coach" on table "coaching_sessions"
 * because the 13-table list trusted ON DELETE CASCADE for every other table and
 * seven foreign keys onto employees do not cascade. The dev database, purged of
 * test data, could not show it. DatabaseCleanupService.wipePlan pins the fix.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const fs = require('fs');
const path = require('path');
const Cleanup = require('../../src/services/DatabaseCleanupService');

/** A slice of the real graph (child -> parent), including the seven non-cascading keys. */
const EDGES = [
    ['coaching_sessions', 'employees'],
    ['coaching_sessions', 'coaching_plans'],
    ['coaching_plans', 'employees'],
    ['training_plans', 'employees'],
    ['action_evidence', 'employees'],
    ['assessment_disputes', 'supervisor_reviews'],
    ['assessment_disputes', 'employees'],
    ['supervisor_reviews', 'self_assessments'],
    ['supervisor_reviews', 'employees'],
    ['self_assessments', 'employees'],
    ['self_assessments', 'skills'],
    ['review_signatures', 'supervisor_reviews'],
    ['assessment_history', 'employees'],
    ['skill_assessments', 'employees'],
    ['skill_assessments', 'admins'],
    ['employees', 'sites'],
    ['employees', 'departments'],
    ['employees', 'roles'],
    ['skills', 'domains'],
    ['api_keys', 'admins'],
    ['system_logs', 'admins'],
    ['admins', 'employees'],
    ['admin_scopes', 'admins'],
    ['countries_regions', 'countries'], // unrelated to the reset roots — must stay untouched
];
const wire = (edges = EDGES) =>
    mockDb.all.mockResolvedValue(edges.map(([child, parent]) => ({ child, parent })));
const ROOTS = [
    'assessment_history',
    'skill_assessments',
    'employees',
    'admin_scopes',
    'sites',
    'departments',
    'roles',
    'skills',
    'domains',
];
const PRESERVED = ['system_logs', 'schema_meta', 'session', 'admins'];

beforeEach(() => {
    mockDb.all.mockReset();
    mockDb.get.mockReset();
    mockDb.run.mockReset();
});

describe('DatabaseCleanupService.wipePlan', () => {
    test('THE APPLIANCE CASE: every non-cascading dependent of employees is in the plan, before employees', async () => {
        wire();
        const p = await Cleanup.wipePlan(ROOTS, PRESERVED);
        const at = (t) => p.order.indexOf(t);
        for (const t of [
            'coaching_sessions',
            'training_plans',
            'action_evidence',
            'assessment_disputes',
            'supervisor_reviews',
            'self_assessments',
            'coaching_plans',
            'review_signatures',
        ]) {
            expect(at(t)).toBeGreaterThan(-1);
            expect(at(t)).toBeLessThan(at('employees'));
        }
        expect(p.added).toEqual(expect.arrayContaining(['coaching_sessions', 'training_plans']));
        expect(p.cycle).toEqual([]);
    });

    test('children before parents all the way up: sessions < plans < employees < sites/roles; skills < domains', async () => {
        wire();
        const p = await Cleanup.wipePlan(ROOTS, PRESERVED);
        const at = (t) => p.order.indexOf(t);
        expect(at('coaching_sessions')).toBeLessThan(at('coaching_plans'));
        expect(at('coaching_plans')).toBeLessThan(at('employees'));
        expect(at('employees')).toBeLessThan(at('sites'));
        expect(at('employees')).toBeLessThan(at('roles'));
        expect(at('skills')).toBeLessThan(at('domains'));
        expect(at('review_signatures')).toBeLessThan(at('supervisor_reviews'));
        expect(at('assessment_disputes')).toBeLessThan(at('supervisor_reviews'));
    });

    test('preserved tables are never emptied and never entered through a dependency; unrelated tables stay out', async () => {
        wire();
        const p = await Cleanup.wipePlan([...ROOTS, 'admins'], PRESERVED);
        for (const t of ['system_logs', 'schema_meta', 'session', 'admins'])
            expect(p.order).not.toContain(t);
        // admins -> employees would pull admins in as a dependent of employees: refused.
        // api_keys -> admins: admins is not in the set, so api_keys is not reached from it either.
        expect(p.order).not.toContain('countries_regions');
        expect(p.order).not.toContain('countries');
    });

    test('a table referencing admins is emptied when passed as a root (so the non-default admins can go)', async () => {
        wire();
        const p = await Cleanup.wipePlan([...ROOTS, 'api_keys'], PRESERVED);
        expect(p.order).toContain('api_keys');
        expect(p.order).not.toContain('admins');
    });

    test('a self-reference needs no ordering; a genuine cycle is appended last and reported', async () => {
        wire([
            ...EDGES,
            ['employees', 'employees'],
            ['a_tbl', 'b_tbl'],
            ['b_tbl', 'a_tbl'],
            ['a_tbl', 'employees'],
        ]);
        const p = await Cleanup.wipePlan(ROOTS, PRESERVED);
        const at = (t) => p.order.indexOf(t);
        expect(p.order).toContain('employees');
        // the cycle is broken at ONE member (a_tbl, name order on the tie) and
        // reported; the rest of the graph keeps children-before-parents.
        expect(p.cycle).toEqual(['a_tbl']);
        expect(at('a_tbl')).toBeLessThan(at('b_tbl'));
        expect(at('b_tbl')).toBeLessThan(at('employees'));
        expect(at('employees')).toBeLessThan(at('sites'));
    });

    test('names come back normalised whether or not regclass quoted them', async () => {
        wire([
            ['"session"', 'employees'],
            ['public.coaching_sessions', 'public.employees'],
        ]);
        const p = await Cleanup.wipePlan(['employees'], PRESERVED);
        expect(p.order).toEqual(['coaching_sessions', 'employees']);
    });
});

describe('the reset controller uses the plan, not the list', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/controllers/DataManagementController.js'),
        'utf8'
    );
    test('deletes follow plan.order over quoted real names, with admin dependents as extra roots', () => {
        // \s* on purpose: prettier wraps this call, and pinning the layout would
        // turn a harmless reformat into a red suite. The claim is that both
        // root sets and the preserved list reach wipePlan — not their spacing.
        expect(src).toMatch(
            /DatabaseCleanupService\.wipePlan\(\s*\[\.\.\.roots,\s*\.\.\.adminDependents\],\s*PRESERVED_TABLES\s*\)/
        );
        expect(src).toMatch(/for \(const table of plan\.order\)/);
        expect(src).toMatch(/DELETE FROM public\."\$\{table\}"/);
        expect(src).not.toMatch(/for \(const table of RESET_ORDER\)/);
    });
    test('the preserved set is explicit and the audit line names what the graph added', () => {
        expect(src).toMatch(
            /PRESERVED_TABLES = \['system_logs', 'schema_meta', 'session', 'admins'\]/
        );
        expect(src).toMatch(/Dependents added from the live FK graph/);
    });
});
