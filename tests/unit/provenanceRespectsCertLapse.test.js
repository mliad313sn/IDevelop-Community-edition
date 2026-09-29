'use strict';

/**
 * A lapsed certificate was still credited by the canonical coverage figure.
 *
 * `v_employee_skill_gaps` joins `v_certification_lapsed` and degrades the
 * effective level to 0 when a held certificate has expired or been revoked —
 * the person may not perform that task today. Its sibling
 * `v_requirement_provenance`, which `v_employee_assessment_coverage` reads,
 * never got the same join.
 *
 * Employee 87, skill 318, certificate expired 2026-09-14:
 *
 *   v_employee_skill_gaps      actual_level 0    is_assessed 1   (correct)
 *   v_requirement_provenance   assessed_level 1  is_assessed 1   (credits it)
 *   ReadinessService           57.8 %                            (reads gaps)
 *   coverage view              58.8 %                            (reads provenance)
 *
 * Migration 136 adds the join. A lapse degrades the LEVEL, never the fact of
 * measurement, so is_assessed stays 1 and coverage / the department-designed
 * requirement count are untouched (43 of 44, before and after).
 *
 * The assertion below is the invariant rather than the single row: the two
 * views must never disagree about an assessed level. 3283 rows, 0 disagreeing.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const ReadinessService = HAS_DB ? require('../../src/services/ReadinessService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the two readiness views agree about a lapsed certificate', () => {
    test('the fixture we rely on still exists (guards against a vacuous suite)', async () => {
        // If nothing has lapsed, every assertion below passes without
        // exercising the join at all.
        const n = await db.get('SELECT COUNT(*)::int AS n FROM v_certification_lapsed');
        expect(Number(n.n)).toBeGreaterThan(0);
    });

    test('provenance degrades the level, exactly like its sibling', async () => {
        const rows = await db.all(
            `SELECT p.employee_id, p.skill_id, p.assessed_level, p.is_assessed
               FROM v_requirement_provenance p
               JOIN v_certification_lapsed cl
                 ON cl.employee_id = p.employee_id AND cl.skill_id = p.skill_id`
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            expect(Number(r.assessedLevel)).toBe(0);
            // the measurement still happened — only the level is degraded
            expect(Number(r.isAssessed)).toBe(1);
        }
    });

    test('no row anywhere disagrees with v_employee_skill_gaps about the level', async () => {
        const d = await db.get(
            `SELECT COUNT(*)::int AS n
               FROM v_requirement_provenance p
               JOIN v_employee_skill_gaps g
                 ON g.employee_id = p.employee_id AND g.skill_id = p.skill_id
              WHERE COALESCE(p.assessed_level, -1) <> COALESCE(g.actual_level, -1)
                AND p.is_assessed = 1`
        );
        expect(Number(d.n)).toBe(0);
    });

    test('ReadinessService and the coverage view now report the same number', async () => {
        const lapsed = await db.get('SELECT employee_id FROM v_certification_lapsed LIMIT 1');
        const rs = await ReadinessService.calculateReadiness(lapsed.employeeId);
        const v = await db.get(
            `SELECT readiness_assessed_only AS rao, assessed_skills AS a, expected_skills AS e
               FROM v_employee_assessment_coverage WHERE employee_id = ?`,
            [lapsed.employeeId]
        );
        expect(Math.abs(Number(rs.readinessPercent) - Number(v.rao))).toBeLessThan(0.05);
        // coverage is unchanged by a lapse
        expect(Number(rs.assessedRequired)).toBe(Number(v.a));
        expect(Number(rs.totalRequired)).toBe(Number(v.e));
    });

    test('redefining the view re-bound it to the VIEW self_assessments, not the table', async () => {
        // Migration 113 renamed self_assessments to self_assessment_rounds and
        // PostgreSQL binds views by OID, so six pre-113 views silently followed
        // the table; migration 122 re-bound them. Redefining this view here
        // rebinds it to whatever `self_assessments` resolves to NOW — which
        // must be the view. Getting this wrong would reintroduce the exact bug
        // 122 exists to fix, invisibly.
        const bound = await db.all(
            `SELECT DISTINCT src.relname AS reads
               FROM pg_depend pd
               JOIN pg_rewrite r ON r.oid = pd.objid
               JOIN pg_class dependent ON dependent.oid = r.ev_class
               JOIN pg_class src ON src.oid = pd.refobjid
              WHERE dependent.relname = 'v_requirement_provenance'
                AND src.relname IN ('self_assessments', 'self_assessment_rounds')`
        );
        expect(bound.map((r) => r.reads)).toEqual(['self_assessments']);

        // and nothing anywhere is left on the table
        const stray = await db.all(
            `SELECT DISTINCT dependent.relname AS v
               FROM pg_depend pd
               JOIN pg_rewrite r ON r.oid = pd.objid
               JOIN pg_class dependent ON dependent.oid = r.ev_class
               JOIN pg_class src ON src.oid = pd.refobjid
              WHERE src.relname = 'self_assessment_rounds'
                AND dependent.relkind = 'v'
                AND dependent.relname <> 'self_assessments'`
        );
        expect(stray).toEqual([]);
    });

    test('the column kept its type — the view really was replaced', async () => {
        // CREATE OR REPLACE VIEW refuses a column type change with 42P16, and
        // the migration runner SWALLOWS that and stamps the file as applied.
        // An untyped 0 in the CASE promoted smallint to integer and did exactly
        // that on the first attempt, leaving the view unchanged and the
        // migration recorded as done.
        const c = await db.get(
            `SELECT data_type FROM information_schema.columns
              WHERE table_name = 'v_requirement_provenance' AND column_name = 'assessed_level'`
        );
        expect(c.dataType).toBe('smallint');

        const applied = await db.get(
            "SELECT value FROM schema_meta WHERE key = '136_provenance_respects_cert_lapse'"
        );
        expect(applied).toBeTruthy();
        expect(applied.value).not.toBe('pre-existing');
    });
});
