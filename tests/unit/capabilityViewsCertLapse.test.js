'use strict';

/**
 * R1 — a lapsed certificate still made someone a domain "expert".
 *
 * v_domain_capability and v_subdomain_capability took ra.level straight from
 * v_resolved_assessments with no certification-lapse degrade, while every sibling
 * view degrades a lapse to 0. getTeamExperts lists everyone at level >= 4, so a
 * person rated 4 whose certificate expired would be named an expert on a skill
 * they may not perform today; the capability averages had the same blind spot.
 *
 * Migrations 139/140 apply the lapse degrade to both views, consistent with
 * v_employee_skill_gaps and v_requirement_provenance.
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

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the capability views degrade a lapsed certificate to 0', () => {
    test('a lapsed (employee, skill) reads level 0 in BOTH capability views', async () => {
        const lapsed = await db.all(`SELECT employee_id, skill_id FROM v_certification_lapsed`);
        expect(lapsed.length).toBeGreaterThan(0); // fixture guard
        for (const l of lapsed) {
            for (const v of ['v_domain_capability', 'v_subdomain_capability']) {
                const row = await db.get(
                    `SELECT level FROM ${v} WHERE employee_id = ? AND skill_id = ?`,
                    [l.employeeId, l.skillId]
                );
                if (row) expect(Number(row.level)).toBe(0);
            }
        }
    });

    test('no expert-level row (>=4) coincides with a lapsed certificate', async () => {
        for (const v of ['v_domain_capability', 'v_subdomain_capability']) {
            const bad = await db.all(
                `SELECT c.employee_id, c.skill_id, c.level
                   FROM ${v} c
                   JOIN v_certification_lapsed cl
                     ON cl.employee_id = c.employee_id AND cl.skill_id = c.skill_id
                  WHERE c.level >= 4`
            );
            expect(bad).toEqual([]);
        }
    });

    test('a non-lapsed level-4 assessment is unaffected', async () => {
        const hi = await db.get(
            `SELECT c.level FROM v_domain_capability c
               LEFT JOIN v_certification_lapsed cl
                 ON cl.employee_id = c.employee_id AND cl.skill_id = c.skill_id
              WHERE c.level >= 4 AND cl.employee_id IS NULL LIMIT 1`
        );
        // the dev set has genuine experts; if present, they still read >= 4
        if (hi) expect(Number(hi.level)).toBeGreaterThanOrEqual(4);
    });

    test('getTeamExperts never names a lapsed skill among the experts', async () => {
        const DashboardModel = require('../../src/models/DashboardModel');
        const experts = await DashboardModel.getTeamExperts({});
        expect(Array.isArray(experts)).toBe(true);
        // Cross-check: none of the listed skills is a lapsed certificate for that person.
        const lapsed = new Set(
            (
                await db.all(
                    `SELECT employee_id, skill_id, (SELECT name FROM skills WHERE id = skill_id) AS skill_name FROM v_certification_lapsed`
                )
            ).map((l) => String(l.employeeId) + '::' + l.skillName)
        );
        for (const e of experts) {
            const names = String(e.skills || '')
                .split(',')
                .map((s) => s.trim());
            for (const n of names) {
                expect(lapsed.has(String(e.employeeId) + '::' + n)).toBe(false);
            }
        }
    });
});

describe('the migrations carry the lapse join', () => {
    test('139 and 140 degrade on v_certification_lapsed with 0::smallint', () => {
        for (const f of [
            'db/postgres/139_domain_capability_cert_lapse.sql',
            'db/postgres/140_subdomain_capability_cert_lapse.sql',
        ]) {
            const sql = read(f);
            expect(sql).toMatch(/LEFT JOIN v_certification_lapsed cl/);
            expect(sql).toMatch(
                /CASE WHEN cl\.employee_id IS NOT NULL THEN 0::smallint ELSE ra\.level END AS level/
            );
        }
    });
});
