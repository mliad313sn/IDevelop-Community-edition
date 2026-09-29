'use strict';

/**
 * A5 — the "Role-Ready N / M" KPI mixed populations.
 *
 * The numerator (roleReadyCount = is_role_ready = 1) requires EVERY requirement
 * to be met, so a partially-assessed person can never be role-ready. But the
 * denominator was measuredEmployees (>= 1 requirement assessed), which INCLUDES
 * partially-assessed people — so they were reported as "not ready" when they are
 * only not-yet-fully-assessed (the unmeasured-as-a-result trap). On the dev set
 * that inflated the denominator from 63 to 71 (48 / 71 instead of 48 / 63).
 *
 * The denominator is now fullyMeasuredEmployees (coverage 100%), the only
 * population is_role_ready can actually judge; roleReadyCount is a subset of it.
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
let M;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    M = require('../../src/models/DashboardModel');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('Role-Ready is judged over fully-assessed employees', () => {
    let k;
    beforeAll(async () => {
        k = await M.getOverviewKPIs({});
    });

    test('the model exposes fullyMeasuredEmployees', () => {
        expect(k.fullyMeasuredEmployees).not.toBeUndefined();
        expect(Number(k.fullyMeasuredEmployees)).toBeGreaterThan(0);
    });

    test('roleReadyCount is a subset of the fully-assessed (numerator <= denominator)', () => {
        expect(Number(k.roleReadyCount)).toBeLessThanOrEqual(Number(k.fullyMeasuredEmployees));
    });

    test('fully-assessed equals an independent coverage-100% count', async () => {
        const r = await db.get(
            `SELECT COUNT(*)::int AS n FROM v_employee_assessment_coverage
              WHERE expected_skills > 0 AND never_assessed_skills = 0`
        );
        expect(Number(k.fullyMeasuredEmployees)).toBe(Number(r.n));
    });

    test('the fix bites: fully-assessed is below the >=1-assessed count when partial data exists', async () => {
        // If some employees are partially assessed, the honest denominator is
        // strictly smaller than measuredEmployees — the old inflated basis.
        const partial = await db.get(
            `SELECT COUNT(*)::int AS n FROM v_employee_assessment_coverage
              WHERE readiness_assessed_only IS NOT NULL AND assessed_skills < expected_skills`
        );
        if (Number(partial.n) > 0) {
            expect(Number(k.fullyMeasuredEmployees)).toBeLessThan(Number(k.measuredEmployees));
        }
    });
});

describe('the Role-Ready card uses the fully-assessed denominator', () => {
    const js = norm('public/js/dashboard.js');
    test('the card divides roleReadyCount by fullyMeasured, not measured', () => {
        expect(js).toMatch(/const fullyMeasured = num\(kpis\.fullyMeasuredEmployees, 0\)/);
        expect(js).toMatch(/value: `\$\{kpis\.roleReadyCount\} \/ \$\{fullyMeasured\}`/);
        expect(js).not.toMatch(/value: `\$\{kpis\.roleReadyCount\} \/ \$\{measured\}`/);
    });
});
