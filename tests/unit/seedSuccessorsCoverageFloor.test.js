'use strict';

/**
 * T1 — the succession bench was seeded and ranked on fit alone, ignoring how
 * much of the role was actually measured.
 *
 * seedSuccessors sorted the candidate pool by pct (readiness over the ASSESSED
 * requirements) and cut it at `limit`. pct says nothing about coverage, so on
 * role 87 (63 requirements) candidates measured on FOUR of them scored 100 % and
 * seated near the top, pushing fully-evidenced Ready-Now candidates off the bench
 * at the `limit` cut. Its sibling BenchmarkModel.getRoleCandidates had already
 * been made coverage-aware; the bench had not.
 *
 * seedSuccessors now ranks exactly as getRoleCandidates does: candidates at/above
 * the ready-now coverage floor first, then fit, then coverage as the tie-break.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const norm = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let Cont;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    Cont = require('../../src/services/ContinuityService');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const LIMIT = 10;
const GATE = 50;

// Seed a throwaway plan on `roleId` over the whole active pool, read the bench
// with each seated candidate's coverage, and independently count the pool's
// at-floor qualifiers (pct >= gate AND coverage >= floor). Roll everything back.
async function seedAndRead(roleId) {
    const emps = await db.all(
        'SELECT id FROM employees WHERE is_active = true AND role_id IS NOT NULL'
    );
    const ids = emps.map((e) => Number(e.id));
    const bench = [];
    let poolAtFloor = 0;
    await db
        .runTransaction(async () => {
            const plan = await db.get(
                `INSERT INTO succession_plans (position_role_id, status, created_at)
                 VALUES (?, 'active', now()) RETURNING id`,
                [roleId]
            );
            await Cont.seedSuccessors(plan.id, ids, { floorPct: GATE, limit: LIMIT });
            const rows = await db.all(
                'SELECT bench_rank, candidate_employee_id FROM successors WHERE plan_id = ? ORDER BY bench_rank',
                [plan.id]
            );
            for (const r of rows) {
                const rd = await Cont.readinessForRole(r.candidateEmployeeId, roleId);
                bench.push({ rank: Number(r.benchRank), coverage: rd.coveragePct, pct: rd.pct });
            }
            // Independent pool census: who is eligible AND adequately measured.
            for (const id of ids) {
                const rd = await Cont.readinessForRole(id, roleId);
                if (
                    rd.pct != null &&
                    rd.pct >= GATE &&
                    rd.coveragePct != null &&
                    rd.coveragePct >= Cont.READY_NOW_COVERAGE_FLOOR
                ) {
                    poolAtFloor++;
                }
            }
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return { bench, poolAtFloor };
}

suite('the succession bench ranks on coverage, not fit alone (role 87)', () => {
    let bench;
    let poolAtFloor;
    const FLOOR = () => Cont.READY_NOW_COVERAGE_FLOOR;

    beforeAll(async () => {
        ({ bench, poolAtFloor } = await seedAndRead(87));
    });

    test('the bench was actually seeded (guards against a vacuous test)', () => {
        expect(bench.length).toBeGreaterThan(2);
        expect(poolAtFloor).toBeGreaterThan(2); // role 87 has several well-measured candidates
    });

    test('no candidate below the coverage floor is ranked above one at/above it', () => {
        for (let i = 0; i < bench.length; i++) {
            for (let j = i + 1; j < bench.length; j++) {
                const above = bench[i];
                const below = bench[j];
                const aboveBelowFloor = above.coverage == null || above.coverage < FLOOR();
                const belowAtFloor = below.coverage != null && below.coverage >= FLOOR();
                expect(aboveBelowFloor && belowAtFloor).toBe(false);
            }
        }
    });

    test('the top seats go to the at-floor candidates — none is pushed off by a thin one', () => {
        // The decisive property: with N at-floor qualifiers in the pool, the first
        // min(N, limit) seats must ALL be at-floor. Ranking on fit alone let
        // pct-100 / 6-of-63 candidates take those seats and pushed the
        // well-measured ones off the limit-10 bench.
        const expectedAtFloorSeats = Math.min(poolAtFloor, LIMIT);
        for (let i = 0; i < expectedAtFloorSeats; i++) {
            expect(bench[i].coverage).not.toBeNull();
            expect(bench[i].coverage).toBeGreaterThanOrEqual(FLOOR());
        }
    });
});

describe('the seed ranking is coverage-aware in source', () => {
    const src = norm('src/services/ContinuityService.js');

    test('it sorts by the coverage floor before fit, not fit alone', () => {
        // the new sort names the coverage floor
        expect(src).toMatch(
            /const meetsFloor = \(c\) => c\.coveragePct != null && c\.coveragePct >= READY_NOW_COVERAGE_FLOOR/
        );
        // the old fit-only sort is gone
        expect(src).not.toMatch(/scored\.sort\(\(a, b\) => b\.pct - a\.pct\)/);
    });
});
