'use strict';

/**
 * R2 — "supervisor rated you 0" for someone whose certificate merely lapsed.
 *
 * Migration 136 degraded v_requirement_provenance.assessed_level to 0 on a
 * lapsed certificate (correct for the EFFECTIVE level and the coverage math),
 * but that made a genuine supervisor rating of 0 indistinguishable from a rating
 * of N whose certificate expired. The employee-profile card read the degraded 0
 * as "Assessed and rated 0 — real data" for employee 87, skill 318, whom a
 * supervisor actually rated 1.
 *
 * Migration 138 keeps assessed_level as the effective level (0 on lapse) and adds
 * two columns: rated_level (the raw rating) and cert_lapsed (the flag). The
 * profile now shows "Certificate lapsed (rated N)" instead of a scored 0, and the
 * coverage math is untouched.
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

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('provenance distinguishes a lapsed certificate from a rated 0', () => {
    test('the view carries rated_level and cert_lapsed (migration 138)', async () => {
        const cols = await db.all(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'v_requirement_provenance'
                AND column_name IN ('rated_level','cert_lapsed','assessed_level')`
        );
        const names = cols.map((c) => c.columnName).sort();
        expect(names).toEqual(['assessed_level', 'cert_lapsed', 'rated_level']);
    });

    test('a lapsed cert: effective level 0, raw rating preserved, flag true', async () => {
        // find any lapsed-cert requirement; the dev set has employee 87 / skill 318
        const row = await db.get(
            `SELECT p.employee_id, p.skill_id, p.assessed_level, p.rated_level, p.cert_lapsed, p.assessment_status
               FROM v_requirement_provenance p
              WHERE p.cert_lapsed = true LIMIT 1`
        );
        expect(row).toBeTruthy(); // fixture guard
        expect(row.certLapsed).toBe(true);
        expect(Number(row.assessedLevel)).toBe(0); // effective — 136's degrade holds
        expect(row.ratedLevel).not.toBeNull();
        expect(Number(row.ratedLevel)).toBeGreaterThan(0); // the real rating survives
        expect(row.assessmentStatus).toBe('assessed');
    });

    test('a genuine rated-0 is NOT flagged lapsed (no false positive)', async () => {
        const row = await db.get(
            `SELECT assessed_level, rated_level, cert_lapsed
               FROM v_requirement_provenance
              WHERE cert_lapsed = false AND assessed_level = 0 AND is_assessed = 1 LIMIT 1`
        );
        if (row) {
            expect(row.certLapsed).toBe(false);
            expect(Number(row.ratedLevel)).toBe(0); // truly rated 0
        }
    });

    test('the profile chain stamps certLapsed and ratedLevel on the skill', async () => {
        const lap = await db.get(
            `SELECT employee_id, skill_id FROM v_requirement_provenance WHERE cert_lapsed = true LIMIT 1`
        );
        const DashboardService = require('../../src/services/DashboardService');
        const prof = await DashboardService.getEmployeeProfile(Number(lap.employeeId), {});
        let s = null;
        for (const g of prof.domainGroups)
            for (const sk of g.skills) if (String(sk.skillId) === String(lap.skillId)) s = sk;
        expect(s).toBeTruthy();
        expect(s.certLapsed).toBe(true);
        expect(s.ratedLevel).not.toBeNull();
        expect(Number(s.assessedLevel)).toBe(0);
    });

    test('the report metric lapsedCount executes and counts the lapse', async () => {
        const R = require('../../src/services/ReportDataService');
        const user = { id: 1, userType: 'admin', role: 'superadmin' };
        for (const source of ['v_employee_skill_gaps', 'v_requirement_provenance']) {
            const out = await R.getSectionData(
                {
                    source,
                    dimension: 'site',
                    metric: 'lapsedCount',
                    aggregation: 'sum',
                    chartType: 'bar',
                },
                user,
                null
            );
            expect(out.error).toBeUndefined();
            const total = (out.data || []).reduce((a, b) => a + (Number(b) || 0), 0);
            expect(total).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('the skill card renders a lapse as its own state, never a scored 0', () => {
    const js = norm('public/js/dashboard.js');

    test('renderSkillCard branches on certLapsed and uses the lapse label', () => {
        expect(js).toMatch(/const lapsed = s\.certLapsed === true;/);
        expect(js).toMatch(/else if \(lapsed\) \{/);
        expect(js).toMatch(/I18N\.provCertLapsed \|\|/);
        // the raw rating feeds the caption, not a fabricated 0
        expect(js).toMatch(/provCertLapsedTitle/);
        expect(js).toMatch(/s\.ratedLevel/);
    });

    test('the lapse branch is evaluated before the assessed-zero branch', () => {
        const lapsedAt = js.indexOf('else if (lapsed)');
        const zeroAt = js.indexOf('provAssessedZero');
        expect(lapsedAt).toBeGreaterThan(-1);
        expect(zeroAt).toBeGreaterThan(-1);
        expect(lapsedAt).toBeLessThan(zeroAt);
    });

    test('both locales define the lapse strings', () => {
        const en = require('../../locales/en/dash.json');
        const fr = require('../../locales/fr/dash.json');
        expect(en.prov_cert_lapsed).toBeTruthy();
        expect(en.prov_cert_lapsed_title).toMatch(/\{0\}/);
        expect(fr.prov_cert_lapsed).toBeTruthy();
        expect(fr.prov_cert_lapsed_title).toMatch(/\{0\}/);
    });
});
