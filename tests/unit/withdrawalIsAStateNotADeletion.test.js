'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/house-rule]: « Le retrait d'une
 * candidature à une opportunité est une SUPPRESSION physique de la ligne,
 * sans état ni motif ».
 *
 * `withdraw()` ran `DELETE FROM opportunity_applications`. That is against
 * the rule the rest of the product follows — a cancellation carries a state
 * and an actor, and nothing is erased (the maintenance panel, the dispute
 * ladder and the lifecycle register all work this way). The physical delete
 * left no trace that the person had ever applied or changed their mind: the
 * poster watched an applicant count drop by one, and nobody could answer who
 * withdrew, or when.
 *
 * Turning a delete into a state is only safe if EVERY reader agrees, so the
 * readers moved with it — otherwise a withdrawn application keeps counting as
 * an applicant and the applicant's own page keeps saying "applied".
 *
 * PROVEN BY EXECUTION on the dev database in a rolled-back transaction
 * (scratchpad/probe-withdraw.js, 15/15) across the whole life cycle: apply →
 * withdraw → re-apply → decide → re-apply. Mutation — writing 'applied'
 * instead of 'withdrawn' — reddens three of those assertions.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
}));

const Mobility = require('../../src/services/MobilityService');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockResolvedValue([]);
});

describe('withdrawing records a state; it never deletes the row', () => {
    test('the statement is an UPDATE, not a DELETE', async () => {
        await Mobility.withdraw(5, 42);
        const sql = String(mockDb.run.mock.calls[0][0]);
        expect(sql).toMatch(/UPDATE opportunity_applications/);
        expect(sql).not.toMatch(/DELETE/i);
    });

    test('it writes the state, the moment, and WHO withdrew', async () => {
        await Mobility.withdraw(5, 42);
        const [sql, params] = mockDb.run.mock.calls[0];
        expect(String(sql)).toMatch(/status = 'withdrawn'/);
        expect(String(sql)).toMatch(/decided_at = now\(\)/);
        expect(String(sql)).toMatch(/actor_employee_id = \?/);
        // The actor is the applicant; nobody DECIDED this.
        expect(params[0]).toBe(42);
        expect(String(sql)).not.toMatch(/decided_by_admin_id\s*=\s*\?/);
    });

    test('only a still-pending application can be withdrawn', async () => {
        await Mobility.withdraw(5, 42);
        expect(String(mockDb.run.mock.calls[0][0])).toMatch(/status = 'applied'/);
    });
});

describe('re-applying revives a withdrawal, and only a withdrawal', () => {
    test('the upsert resets a withdrawn row back to pending', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM opportunities WHERE id/.test(sql) ? { state: 'open' } : { id: 1 }
        );
        await Mobility.apply(5, 42, 'note');
        const insert = mockDb.get.mock.calls
            .map((c) => String(c[0]))
            .find((s) => /INSERT INTO opportunity_applications/.test(s));
        expect(insert).toBeDefined();
        expect(insert).toMatch(/status = CASE WHEN opportunity_applications\.status = 'withdrawn'/);
        expect(insert).toMatch(/THEN 'applied' ELSE opportunity_applications\.status END/);
        // …and the pending-ness is restored with it.
        expect(insert).toMatch(
            /decided_at = CASE WHEN opportunity_applications\.status = 'withdrawn'/
        );
    });

    test('a decision somebody else made is left alone', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM opportunities WHERE id/.test(sql) ? { state: 'open' } : { id: 1 }
        );
        await Mobility.apply(5, 42, 'note');
        const insert = mockDb.get.mock.calls
            .map((c) => String(c[0]))
            .find((s) => /INSERT INTO opportunity_applications/.test(s));
        // The ELSE arms keep the existing value — a new application must never
        // quietly erase an accepted/declined decision.
        expect(insert).toMatch(/ELSE opportunity_applications\.status END/);
        expect(insert).toMatch(/ELSE opportunity_applications\.decided_at END/);
        expect(insert).not.toMatch(/status = 'applied',/);
    });
});

describe('every reader agrees a withdrawal is not an application', () => {
    test('the applicant count excludes it', () => {
        const src = read('src/services/MobilityService.js');
        const count = src.slice(src.indexOf('AS applicants') - 400, src.indexOf('AS applicants'));
        expect(count).toMatch(/status <> 'withdrawn'/);
    });

    test('the applicant\'s own page no longer says "applied"', () => {
        const src = read('src/controllers/EmployeeGrowthController.js');
        expect(src).toMatch(
            /SELECT opportunity_id FROM opportunity_applications WHERE employee_id = \? AND status <> 'withdrawn'/
        );
    });

    test('a withdrawn application cannot then be decided', () => {
        // decideApplication only touches a row still at 'applied', so the
        // withdrawal takes it out of the queue by itself.
        const src = read('src/services/MobilityService.js');
        const dec = src.slice(
            src.indexOf('async decideApplication'),
            src.indexOf('async setAspirations')
        );
        expect(dec).toMatch(/WHERE id = \? AND status = 'applied'/);
    });

    test('the department brief stops counting it as undecided', () => {
        // `decided_at` is stamped on withdrawal, and the brief counts rows
        // where it IS NULL — so the exclusion comes for free rather than
        // needing a second list of statuses to keep in step.
        const brief = read('src/services/DeptBriefService.js');
        expect(brief).toMatch(/FROM opportunity_applications o[\s\S]{0,200}?decided_at IS NULL/);
        const src = read('src/services/MobilityService.js');
        const w = src.slice(src.indexOf('async withdraw('), src.indexOf('async setAspirations'));
        expect(w).toMatch(/decided_at = now\(\)/);
    });
});
