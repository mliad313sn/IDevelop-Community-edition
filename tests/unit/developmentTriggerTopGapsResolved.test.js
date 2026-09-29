'use strict';

/**
 * T4 — the IDP/PIP objective generator wrote gaps the rest of the system disowns.
 *
 * DevelopmentTriggerService._topGaps built the development objectives an employee
 * signs by reading RAW skill_assessments, blind to two things every other surface
 * honours through v_resolved_assessments + v_certification_lapsed:
 *
 *   - an APPROVED self-assessment that meets the requirement: raw has no row, so
 *     the plan proposed an objective the canonical view calls "met";
 *   - a LAPSED certificate: raw still shows the pre-lapse rating, so the plan
 *     MISSED a critical skill the person can no longer perform.
 *
 * On the dev set the lapse direction bit: employee 87's skill 318 (Budget & Cost
 * Control, required 1, supervisor-rated 1 but the certificate expired) was NOT
 * flagged as a development need, though the effective level is 0. _topGaps now
 * reads the resolved view and degrades a lapse to 0, so its objectives agree with
 * the profile/readiness everyone else sees.
 *
 * The objective wording still shows an unmeasured requirement as current = NULL,
 * never a fabricated 0 (the earlier fix, preserved here).
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
let svc;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    svc = require('../../src/services/DevelopmentTriggerService');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('development objectives agree with the canonical resolved+lapse view', () => {
    test('a lapsed critical cert becomes a development need (emp 87, skill 318)', async () => {
        const lap = await db.get(
            `SELECT cl.employee_id AS employee_id, cl.skill_id AS skill_id
               FROM v_certification_lapsed cl
               JOIN role_skill_requirements rsr
                 ON rsr.skill_id = cl.skill_id
                AND rsr.role_id = (SELECT role_id FROM employees WHERE id = cl.employee_id)
              WHERE rsr.required_level > 0 LIMIT 1`
        );
        expect(lap).toBeTruthy(); // fixture guard: a lapsed cert on a required skill
        const gaps = await svc._topGaps(Number(lap.employeeId), 200);
        const row = gaps.find((g) => String(g.skillId) === String(lap.skillId));
        expect(row).toBeTruthy(); // the lapse is now flagged
        expect(Number(row.current)).toBe(0); // effective level, not the pre-lapse rating
    });

    test('a never-assessed requirement carries current = null, not a fabricated 0', async () => {
        const gaps = await svc._topGaps(87, 200);
        const never = gaps.find((g) => g.current === null);
        expect(never).toBeTruthy();
    });

    test('every flagged gap, and only those, matches the resolved+lapse truth', async () => {
        // The core of T4: _topGaps must agree with what the profile/readiness show.
        // Recompute the truth independently from the resolved view and the lapse
        // view, and require an exact match on which required skills are gaps.
        const emps = await db.all(
            'SELECT id FROM employees WHERE is_active = true ORDER BY id LIMIT 25'
        );
        let checked = 0;
        for (const e of emps) {
            const gaps = await svc._topGaps(e.id, 500);
            const flagged = new Set(gaps.map((g) => String(g.skillId)));
            const truth = await db.all(
                `SELECT rsr.skill_id,
                        (rsr.required_level > COALESCE(CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE ra.level END, 0)) AS should_gap
                   FROM employees e
                   JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
                   LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.id AND ra.skill_id = rsr.skill_id
                   LEFT JOIN v_certification_lapsed cl ON cl.employee_id = e.id AND cl.skill_id = rsr.skill_id
                  WHERE e.id = ? AND rsr.required_level > 0`,
                [e.id]
            );
            for (const t of truth) {
                expect(flagged.has(String(t.skillId))).toBe(t.shouldGap === true);
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(100); // guards against a vacuous sweep
    });

    test('the query reads the resolved view + lapse, not raw skill_assessments', () => {
        const src = norm('src/services/DevelopmentTriggerService.js');
        // isolate the _topGaps method body
        const start = src.indexOf('async _topGaps(');
        const seg = src.slice(start, start + 2600);
        expect(seg).toMatch(/LEFT JOIN v_resolved_assessments ra/);
        expect(seg).toMatch(/LEFT JOIN v_certification_lapsed cl/);
        expect(seg).toMatch(/CASE WHEN cl\.employee_id IS NOT NULL THEN 0 ELSE ra\.level END/);
        // the raw-table join is gone from this method
        expect(seg).not.toMatch(/LEFT JOIN skill_assessments sa/);
    });
});
