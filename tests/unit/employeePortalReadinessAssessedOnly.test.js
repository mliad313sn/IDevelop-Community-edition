'use strict';

/**
 * A6 — the employee portal showed a different readiness than the manager.
 *
 * The portal tile read v_employee_readiness.readiness, the ALL-REQUIREMENTS
 * figure (an unassessed requirement counts as not-met), while the dashboard, the
 * reports and the manager's view of the same person all use
 * readiness_assessed_only (readiness over the assessed requirements). A partially
 * assessed employee therefore saw a LOWER number than their manager — measured on
 * idevelop: 8 employees, up to 17 points apart (e.g. 88 % on the portal for someone
 * the manager sees at 100 %) — and the same page listed the unmeasured skills as
 * "—" while the headline silently folded them back in as failures.
 *
 * The portal now publishes readiness_assessed_only (the org's figure) and carries
 * coverage so the partial assessment is shown, not hidden in a lowered percent.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let ctrl;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    ctrl = require('../../src/controllers/EmployeePortalController');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function dashboardSnapshot(employeeId) {
    let snapshot = null;
    const req = { user: { id: employeeId }, t: (k) => k };
    const res = {
        render: (_v, data) => {
            snapshot = data.snapshot;
        },
    };
    await ctrl.dashboard(req, res);
    return snapshot;
}

suite('the employee portal shows the same readiness the manager sees', () => {
    test('a partially-assessed employee sees readiness_assessed_only, with coverage', async () => {
        const partial = await db.all(
            `SELECT employee_id, ROUND(readiness_assessed_only) AS r, assessed_skills, expected_skills
               FROM v_employee_assessment_coverage
              WHERE assessed_skills > 0 AND assessed_skills < expected_skills LIMIT 5`
        );
        expect(partial.length).toBeGreaterThan(0); // fixture guard
        for (const p of partial) {
            const snap = await dashboardSnapshot(Number(p.employeeId));
            expect(snap).toBeTruthy();
            expect(Number(snap.readiness)).toBe(Number(p.r)); // matches the org/manager figure
            expect(snap.coverage.assessedSkills).toBe(Number(p.assessedSkills));
            expect(snap.coverage.expectedSkills).toBe(Number(p.expectedSkills));
        }
    });

    test('the portal never disagrees with the coverage view for anyone assessed', async () => {
        const rows = await db.all(
            `SELECT employee_id, ROUND(readiness_assessed_only) AS r
               FROM v_employee_assessment_coverage WHERE assessed_skills > 0
              ORDER BY employee_id LIMIT 25`
        );
        for (const row of rows) {
            const snap = await dashboardSnapshot(Number(row.employeeId));
            expect(Number(snap.readiness)).toBe(Number(row.r));
        }
    });

    test('nobody assessed → readiness null (first-run state preserved)', async () => {
        const none = await db.get(
            `SELECT employee_id FROM v_employee_assessment_coverage WHERE assessed_skills = 0 LIMIT 1`
        );
        if (none) {
            const snap = await dashboardSnapshot(Number(none.employeeId));
            expect(snap.readiness).toBeNull();
        }
    });
});

describe('the portal reads the assessed-only figure, not the all-requirements one', () => {
    const src = read('src/controllers/EmployeePortalController.js');

    test('readiness comes from readiness_assessed_only in the coverage view', () => {
        expect(src).toMatch(
            /readiness_assessed_only, assessed_skills, expected_skills\s*\n?\s*FROM v_employee_assessment_coverage/
        );
        expect(src).toMatch(/readinessAssessedOnly/);
        // it must no longer read the all-requirements readiness for the tile
        expect(src).not.toMatch(/SELECT readiness, assessed_required FROM v_employee_readiness/);
    });
});
