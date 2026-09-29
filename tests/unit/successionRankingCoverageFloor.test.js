'use strict';

/**
 * Succession ranked the least-measured candidate near the top.
 *
 * `getRoleCandidates` computes `fit` over the ASSESSED requirements only —
 * which is correct, and was itself a fix: folding never-assessed requirements
 * in as level 0 used to publish a candidate rated on one skill at 1 % fit with
 * 161 gaps. But an assessed-only fit says nothing about HOW MUCH of the role
 * was measured, and the ranking was `ORDER BY fit DESC` alone.
 *
 * Measured on idevelop, role 87 (ERP Specialist, 63 requirements), as published:
 *
 *    1. emp 90   fit 100  assessed 25/63
 *    2. emp 94   fit 100  assessed 25/63
 *    3. emp 125  fit 100  assessed  4/63   <- measured on four requirements
 *    ...
 *    emp 155     fit  99  assessed 54/63   <- buried below all of them
 *
 * A planner reading "who is ready to move up" top-down met the candidate with
 * the thinnest evidence third, and the one candidate actually measured against
 * most of the role not at all. The page's own table already prints "4 / 63"
 * under the fit bar, so the display was honest — the ORDER BY was not.
 *
 * Ranking now puts candidates who clear the coverage floor first, using the
 * SAME 80 % threshold the succession bench applies
 * (ContinuityService.READY_NOW_COVERAGE_FLOOR), so the two surfaces cannot
 * disagree about who counts as measured enough. Within a band the better fit
 * wins; coverage breaks a fit tie.
 *
 * After: emp 155 (99 %, 86 % coverage) first, emp 125 tenth.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const BenchmarkModel = HAS_DB ? require('../../src/models/BenchmarkModel') : null;
const ContinuityService = require('../../src/services/ContinuityService');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

describe('the two surfaces share one definition of "measured enough"', () => {
    test('the bench floor is 80 and the candidate query uses the same number', () => {
        expect(ContinuityService.READY_NOW_COVERAGE_FLOOR).toBe(80);
        const src = require('fs').readFileSync(
            path.join(__dirname, '../../src/models/BenchmarkModel.js'),
            'utf8'
        );
        // The SQL cannot import the constant, so the number is asserted here:
        // if one moves without the other, this fails.
        expect(src).toMatch(/NULLIF\(COUNT\(\*\), 0\) >= 80\) AS meets_coverage_floor/);
    });
});

suite('a thinly measured candidate cannot outrank a well measured one', () => {
    const ROLE = 87;
    let rows = null;
    beforeAll(async () => {
        rows = await BenchmarkModel.getRoleCandidates(ROLE);
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        expect(rows.length).toBeGreaterThan(1);
        // there must be BOTH kinds of candidate, or the ordering is untested
        expect(rows.some((r) => r.meetsCoverageFloor === true)).toBe(true);
        expect(rows.some((r) => r.meetsCoverageFloor === false)).toBe(true);
    });

    test('every candidate clearing the coverage floor is listed before every one that does not', () => {
        const flags = rows.map((r) => Boolean(r.meetsCoverageFloor));
        const firstFalse = flags.indexOf(false);
        const lastTrue = flags.lastIndexOf(true);
        expect(lastTrue).toBeLessThan(firstFalse);
    });

    test('coverage travels with every row, so a fit can never be read alone', () => {
        for (const r of rows) {
            expect(r.coverage).not.toBeUndefined();
            expect(Number(r.assessedSkills)).toBeGreaterThanOrEqual(0);
            expect(Number(r.reqSkills)).toBeGreaterThan(0);
            expect(Number(r.assessedSkills) + Number(r.unmeasuredSkills)).toBe(Number(r.reqSkills));
        }
    });

    test('within the unmeasured band, a 6% candidate ranks below a 40% one of equal fit', () => {
        const at = (id) => rows.findIndex((r) => Number(r.employeeId) === id);
        const thin = at(125); // 4/63
        const thick = at(90); // 25/63
        expect(thin).toBeGreaterThan(-1);
        expect(thick).toBeGreaterThan(-1);
        // equal fit, so coverage must decide
        expect(Number(rows[thin].fit)).toBe(Number(rows[thick].fit));
        expect(thin).toBeGreaterThan(thick);
    });

    test('the best-evidenced candidate is no longer buried', () => {
        // emp 155: fit 99 over 54 of 63 requirements. Under `ORDER BY fit DESC`
        // alone, eight candidates at fit 100 on 25/63 stood in front.
        expect(Number(rows[0].employeeId)).toBe(155);
        expect(Number(rows[0].coverage)).toBeGreaterThanOrEqual(80);
    });

    test('a well-measured mediocre fit outranks an unverifiable perfect one, deliberately', () => {
        // This is the intended trade: fit 50 on 81 % coverage is a judgement a
        // planner can act on; fit 100 on 6 % coverage is not yet a finding.
        const floorers = rows.filter((r) => r.meetsCoverageFloor);
        const others = rows.filter((r) => !r.meetsCoverageFloor);
        expect(floorers.length).toBeGreaterThan(0);
        expect(others.some((r) => Number(r.fit) > Number(floorers[floorers.length - 1].fit))).toBe(
            true
        );
    });
});
