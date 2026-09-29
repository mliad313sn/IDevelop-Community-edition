'use strict';
/**
 * WAVE 3 — migration 80: the readiness view stack must stay SCOPE-AWARE and LIVE.
 *
 * v_resolved_assessments resolves "latest level per (employee, skill)" with a
 * window function. A window function blocks join pushdown, so a site-scoped
 * dashboard query materialised and full-sorted the WHOLE org's assessment
 * history — ~10 times per page load. Migration 80 keeps that view as the
 * reference implementation and rewrites the two hot consumers
 * (v_requirement_provenance, v_employee_skill_gaps) as LEFT JOIN LATERAL
 * lookups onto the base tables, so the scope predicate reaches the base scan.
 *
 * These are contract tests on the migration text. They cannot prove the plan —
 * that is what scripts/loadtest-readiness.js measures — but they DO stop the
 * three ways this change could quietly become wrong later:
 *
 *   1. someone turns it into a MATERIALIZED VIEW and forgets the refresh job,
 *      leaving readiness silently stale (worse than slow);
 *   2. someone DROP ... CASCADEs a view instead of CREATE OR REPLACE, silently
 *      deleting dependents and changing the column contract Wave 2 relies on;
 *   3. someone drops the drift assertions that prove the LATERAL resolves
 *      identically to v_resolved_assessments.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'postgres');
const FILE = path.join(MIGRATIONS_DIR, '80_materialized_readiness.sql');
const sql = fs.readFileSync(FILE, 'utf8');

// Comments carry the rationale; the ASSERTIONS must look at executable SQL only.
const code = sql.replace(/--[^\n]*/g, '');

describe('migration 80 — file hygiene', () => {
    test('exists, is transactional and stamps schema_meta idempotently', () => {
        expect(code).toMatch(/^\s*BEGIN;/);
        expect(code.trim()).toMatch(/COMMIT;$/);
        expect(code).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('80_materialized_readiness'/
        );
        expect(code).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    });

    test('80 does not collide with another migration number', () => {
        // Was also asserting `max(others) < 80`, i.e. that 80 is the HIGHEST
        // migration. That is a fact about the calendar, not about migration 80:
        // it broke the moment 81 landed. Not colliding with another file is the
        // property that actually matters (two files sharing a number means one
        // of them is skipped by the runner), and it stays true over time.
        const others = fs
            .readdirSync(MIGRATIONS_DIR)
            .filter((f) => /^\d+_.*\.sql$/.test(f) && !/_down\.sql$/i.test(f))
            .filter((f) => f !== '80_materialized_readiness.sql')
            .map((f) => Number(f.split('_')[0]));
        expect(others).not.toContain(80);
    });
});

describe('freshness — a stale readiness number is worse than a slow one', () => {
    test('no MATERIALIZED VIEW is created, so no refresh schedule is owed', () => {
        expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW/i);
        expect(code).not.toMatch(/REFRESH\s+MATERIALIZED\s+VIEW/i);
    });

    test('IF a future edit materialises it, a refresh tick MUST be registered', () => {
        // The guard, not a tautology: this test fails the moment someone adds a
        // MATERIALIZED VIEW here without also adding the tick that keeps it fresh.
        if (!/CREATE\s+MATERIALIZED\s+VIEW/i.test(code)) return;
        const jobs = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'jobs', 'index.js'),
            'utf8'
        );
        expect(jobs).toMatch(/refresh/i);
        expect(jobs).toMatch(/readiness/i);
    });
});

describe('output contract — Wave 2 canonical numbers must not move', () => {
    test('both hot views are CREATE OR REPLACE, never DROP ... CASCADE', () => {
        expect(code).toMatch(/CREATE OR REPLACE VIEW v_requirement_provenance AS/);
        expect(code).toMatch(/CREATE OR REPLACE VIEW v_employee_skill_gaps AS/);
        expect(code).not.toMatch(/DROP\s+VIEW/i);
        expect(code).not.toMatch(/CASCADE/i);
    });

    test('v_resolved_assessments is left untouched — it is the reference implementation', () => {
        expect(code).not.toMatch(/(CREATE|DROP|ALTER)[^;]*\bv_resolved_assessments\b/i);
        // ...and is still READ, by the drift assertions.
        expect(code).toMatch(/FROM v_resolved_assessments|JOIN v_resolved_assessments/);
    });

    test('v_employee_assessment_coverage / v_employee_readiness are not redefined here', () => {
        expect(code).not.toMatch(/CREATE[^;]*VIEW\s+v_employee_assessment_coverage/i);
        expect(code).not.toMatch(/CREATE[^;]*VIEW\s+v_employee_readiness/i);
    });

    test('the resolution rule is unchanged: latest wins, supervisor vs approved self', () => {
        expect(code).toMatch(/'supervisor_validated'::text/);
        expect(code).toMatch(/'self_approved'::text/);
        expect(code).toMatch(/'assessed'::text/);
        expect(code).toMatch(/'self_only'::text/);
        expect(code).toMatch(/COALESCE\(ra\.assessment_status, 'never_assessed'\)/);
        // approved self-ratings only — a draft or rejected one is not a rating
        expect(code).toMatch(/sf\.status = 'approved'/);
    });

    test('assessed_level is still NOT coalesced in the provenance view', () => {
        // "never assessed" must stay distinguishable from an earned zero.
        expect(code).toMatch(/ra\.level AS assessed_level/);
    });
});

describe('the scope predicate can now reach the base scan', () => {
    test('both rewritten views resolve via LEFT JOIN LATERAL onto the base tables', () => {
        const laterals = code.match(/LEFT JOIN LATERAL/g) || [];
        expect(laterals.length).toBe(2);
        expect(code).toMatch(
            /FROM skill_assessments sa\s+WHERE sa\.employee_id = e\.employee_id AND sa\.skill_id = rsr\.skill_id/
        );
        expect(code).toMatch(
            /FROM self_assessments sf\s+WHERE sf\.employee_id = e\.employee_id AND sf\.skill_id = rsr\.skill_id/
        );
    });

    test('neither hot view still joins the window-function view', () => {
        // The view BODY only — the COMMENT ON statement that follows it
        // legitimately names v_resolved_assessments as the reference.
        const body = (name) => {
            const start = code.indexOf(`CREATE OR REPLACE VIEW ${name} AS`);
            expect(start).toBeGreaterThan(-1);
            return code.slice(start, code.indexOf(';', start));
        };
        expect(body('v_requirement_provenance')).not.toMatch(/v_resolved_assessments/);
        expect(body('v_employee_skill_gaps')).not.toMatch(/v_resolved_assessments/);
    });

    test('the tie-break is deterministic (supervisor wins an exact timestamp tie)', () => {
        expect((code.match(/ORDER BY c\.assessed_at DESC, c\.branch/g) || []).length).toBe(2);
    });
});

describe('the migration proves its own correctness before it commits', () => {
    test('drift assertions cover provenance, gaps, the 79 invariant and the requirement count', () => {
        expect(code).toMatch(/RAISE EXCEPTION/);
        // 4 distinct assertions, each raising rather than warning
        expect((code.match(/RAISE EXCEPTION/g) || []).length).toBe(4);
        expect(code).toMatch(/v_requirement_provenance disagrees with v_resolved_assessments/);
        expect(code).toMatch(/v_employee_skill_gaps disagrees with v_resolved_assessments/);
        expect(code).toMatch(
            /v_employee_skill_gaps\.is_assessed disagrees with v_requirement_provenance/
        );
        expect(code).toMatch(/no longer equals the department-designed count/);
    });

    test('exact-timestamp ties are EXCLUDED from the drift checks, not silently ignored', () => {
        // The pre-80 ROW_NUMBER had no tie-break, so on a pair whose candidate
        // rows tie on the latest timestamp it had NO defined answer to preserve.
        // Failing the migration over those would abort a deploy over noise; not
        // mentioning them would hide a real (deliberate) behaviour change.
        expect(code).toMatch(/CREATE TEMP TABLE _m80_ambiguous ON COMMIT DROP/);
        expect(code).toMatch(
            /RANK\(\) OVER \(PARTITION BY employee_id, skill_id ORDER BY ts DESC\)/
        );
        expect(code).toMatch(/HAVING COUNT\(\*\) > 1/);
        expect(code).toMatch(/RAISE NOTICE/);
        // both value-drift checks exclude them...
        expect((code.match(/NOT EXISTS \(SELECT 1 FROM _m80_ambiguous a/g) || []).length).toBe(2);
        // ...and the is_assessed invariant does NOT, because a tie changes which
        // row wins, never whether one exists.
        const invariant = code.slice(code.indexOf('-- 3c'), code.indexOf('-- 3d'));
        expect(invariant).not.toMatch(/_m80_ambiguous/);
    });

    test('HARD CONSTRAINT: the requirement count per employee is asserted to be the FULL designed count', () => {
        expect(code).toMatch(
            /role_skill_requirements r\s+WHERE r\.role_id = e\.role_id AND r\.required_level > 0/
        );
        expect(code).toMatch(/t\.designed <> t\.exposed/);
        // and the only requirement filter anywhere is the pre-existing one
        const filters = code.match(/required_level > 0/g) || [];
        expect(filters.length).toBeGreaterThanOrEqual(3);
        expect(code).not.toMatch(/LIMIT\s+\d+\s*\)?\s*(AS)?\s*rsr/i); // no sampling of requirements
    });
});

describe('the load-test harness refuses to run outside a dev database', () => {
    const script = fs.readFileSync(
        path.join(__dirname, '..', '..', 'scripts', 'loadtest-readiness.js'),
        'utf8'
    );

    test('the dev-DB guard exists and rejects the installed instance', () => {
        const m = /const DEV_DB_PATTERN = (\/.*\/i?);/.exec(script);
        expect(m).toBeTruthy();
        // eslint-disable-next-line no-eval
        const pattern = eval(m[1]);
        expect(pattern.test('idevelop_dev')).toBe(true);
        expect(pattern.test('anything_dev')).toBe(true);
        expect(pattern.test('anything_test')).toBe(true);
        // the installed instance — must NEVER match
        expect(pattern.test('idevelop')).toBe(false);
        expect(pattern.test('postgres')).toBe(false);
        expect(pattern.test('idevelop_prod')).toBe(false);
    });

    test('the guard runs before the pool is opened, and exits rather than continuing', () => {
        const guardAt = script.indexOf('DEV_DB_PATTERN.test(DB_NAME)');
        const requireAt = script.indexOf("require('../src/config/database')");
        expect(guardAt).toBeGreaterThan(-1);
        expect(requireAt).toBeGreaterThan(guardAt);
        expect(script).toMatch(/REFUSING TO RUN/);
        expect(script).toMatch(/process\.exit\(1\)/);
    });

    test('the seed is rolled back, and the rollback is verified against real counts', () => {
        expect(script).toMatch(/db\.runTransaction/);
        expect(script).toMatch(/__ROLLBACK__/);
        expect(script).toMatch(/rollback verified/);
        expect(script).not.toMatch(/\bCOMMIT\b/);
    });
});
