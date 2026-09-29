'use strict';

/**
 *  scripts/loadtest-readiness.js — 4 000-user readiness/dashboard load test.
 *
 *  WHAT IT DOES
 *    Seeds N synthetic employees plus a realistic assessment history INSIDE ONE
 *    TRANSACTION, ANALYZEs, measures p50/p95 of the dashboard's hot read paths
 *    at both an org-wide scope (superadmin) and a single-site scope (a site
 *    director — the case the view stack used to punish), then ROLLS THE WHOLE
 *    THING BACK. Nothing is committed, ever: the seed lives and dies inside the
 *    transaction, and the script re-reads the row counts afterwards and fails
 *    loudly if any of them moved.
 *
 *  WHERE IT MAY RUN — TWO INDEPENDENT GUARDS, BOTH BEFORE ANY POOL IS OPENED
 *    1. NODE_ENV must not be 'production'. No flag overrides this.
 *    2. The DB name in DATABASE_URL must match DEV_DB_PATTERN below (*_dev,
 *       *_test, *_fixtures). The installed instance's database does NOT
 *       match and the script refuses to start — a load test that seeds 160 000
 *       assessment rows must never point at the DB the running app is using,
 *       even inside a transaction (the write locks and the bloat are real even
 *       when the rows are not).
 *
 *  WHAT IT WRITES, AND HOW IT IS REMOVED
 *    Everything it creates lives in ONE clearly marked synthetic namespace:
 *    employees whose employee_number starts with `LT-` (first/last name
 *    Load / TestN), and the assessment rows hanging off those employees.
 *    Nothing else is ever touched.
 *
 *    Removal is primary, not a fallback: the seed and the measurements run
 *    inside a single transaction that ALWAYS ends in ROLLBACK, and the script
 *    re-reads the row counts afterwards and exits non-zero if any of them moved.
 *    Nothing is ever committed, so nothing can reach the installer's pg_dump.
 *    `--cleanup` is the belt-and-braces second path: it deletes the whole `LT-`
 *    namespace outright (for a machine where a run was killed mid-transaction
 *    or somebody hand-seeded), and `--check` just reports the footprint.
 *
 *  USAGE
 *    node scripts/loadtest-readiness.js
 *    node scripts/loadtest-readiness.js --employees 4000 --runs 9 --assessed-pct 60
 *    node scripts/loadtest-readiness.js --employees 4000 --ab           # A/B vs the pre-80 views
 *    node scripts/loadtest-readiness.js --employees 4000 --skip-seed   # measure live data
 *    node scripts/loadtest-readiness.js --check     # report synthetic rows, change nothing
 *    node scripts/loadtest-readiness.js --cleanup   # delete every LT- row and exit
 *
 *  NOTE ON THE NUMBERS
 *    Everything runs on ONE pg client (that is what a transaction is), so the
 *    ~7 aggregates inside getExecutiveData are SERIALISED here where production
 *    runs them via Promise.all. The end-to-end figure is therefore a pessimistic
 *    upper bound; the per-query figures are exact.
 */

require('dotenv').config();

// ---------------------------------------------------------------------------
// Guards FIRST — before anything opens a pool.
// ---------------------------------------------------------------------------

// GUARD 1: never in production, whatever the database is called. No flag,
// env var or argument overrides this — it is the first statement that runs.
if (
    String(process.env.NODE_ENV || '')
        .trim()
        .toLowerCase() === 'production'
) {
    console.error(
        `\nREFUSING TO RUN.\n` +
            `  NODE_ENV=production.\n` +
            `  This is a load-GENERATION script: it inserts a synthetic employee\n` +
            `  population and its assessment history. It is a development tool and\n` +
            `  has no production mode.\n`
    );
    process.exit(1);
}

// GUARD 2: dev database names only.
// Matched by SUFFIX, not by a hard-coded database name. A literal name here is
// both a brand token and a fragile guard: rename a development database and the
// allow-list silently stops matching. Suffixes keep the property that matters --
// the installed instance's database does not end in _dev/_test/_fixtures, so it can
// never match, and neither can a '..._prod' variant of it.
const DEV_DB_PATTERN = /(_dev|_test|_fixtures)$/i;

// The ONE synthetic namespace. Every row this script creates is reachable from
// an employee whose employee_number starts with this prefix; --cleanup deletes
// exactly that set and nothing else.
const SYNTHETIC_PREFIX = 'LT-';

function dbNameFromUrl(url) {
    if (!url) return null;
    try {
        // pg accepts postgres:// and postgresql://; the path is /<dbname>
        const u = new URL(url.replace(/^postgres:\/\//, 'postgresql://'));
        return decodeURIComponent(u.pathname.replace(/^\//, '')) || null;
    } catch {
        const m = /\/([^/?#]+)(?:[?#]|$)/.exec(url);
        return m ? m[1] : null;
    }
}

const DB_NAME = dbNameFromUrl(process.env.DATABASE_URL);
if (!DB_NAME || !DEV_DB_PATTERN.test(DB_NAME)) {
    console.error(
        `\nREFUSING TO RUN.\n` +
            `  DATABASE_URL points at database: ${DB_NAME || '(unparseable)'}\n` +
            `  This load test seeds tens of thousands of rows and may only run against a\n` +
            `  development database whose name matches ${DEV_DB_PATTERN} (e.g. a development database, x_dev, x_test).\n` +
            `  It will NOT run against an installed instance's database.\n`
    );
    process.exit(1);
}

// The pool ships a 30 s statement/query timeout — the right guard for a request
// path, and exactly the wrong one for a bulk seed (and for MEASURING a path that
// is currently slower than 30 s: a timeout would report an error where we need a
// number). Raised for this process only, before the pool is constructed.
process.env.PG_STATEMENT_TIMEOUT_MS = process.env.LOADTEST_STATEMENT_TIMEOUT_MS || '600000';
process.env.PG_QUERY_TIMEOUT_MS = process.env.LOADTEST_STATEMENT_TIMEOUT_MS || '600000';

const db = require('../src/config/database');
const DashboardModel = require('../src/models/DashboardModel');
const DashboardService = require('../src/services/DashboardService');

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return dflt;
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) return true;
    return v;
}
const TARGET_EMPLOYEES = Number(arg('employees', 4000));
const RUNS = Number(arg('runs', 9));
const ASSESSED_PCT = Number(arg('assessed-pct', 60));
const SELF_PCT = Number(arg('self-pct', 10));
const SKIP_SEED = arg('skip-seed', false) === true;
const CHECK_ONLY = arg('check', false) === true;
const CLEANUP = arg('cleanup', false) === true;
// --ab also installs the PRE-migration-80 view shape inside the same rollback
// transaction and re-measures, so BEFORE/AFTER is one seed on one machine state.
const AB = arg('ab', false) === true;

if (!(TARGET_EMPLOYEES > 0) || !(RUNS > 0) || !(ASSESSED_PCT >= 0 && ASSESSED_PCT <= 100)) {
    console.error('Invalid arguments.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}
const ms = (n) => (n === null ? '      n/a' : `${n.toFixed(1).padStart(10)}`);

async function timeIt(label, fn, results, warmups = 0) {
    const samples = [];
    let rows = null;
    for (let i = 0; i < warmups; i++) await fn(); // never time a cold cache as if it were a hit
    for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint();
        const out = await fn();
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
        if (i === 0) rows = Array.isArray(out) ? out.length : out ? 1 : 0;
    }
    samples.sort((a, b) => a - b);
    results.push({
        label,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        min: samples[0],
        max: samples[samples.length - 1],
        rows,
    });
}

function report(title, results) {
    console.log(`\n  ${title}`);
    console.log('  ' + '-'.repeat(74));
    console.log('  ' + 'hot path'.padEnd(42) + '       p50       p95       max');
    console.log('  ' + '-'.repeat(74));
    for (const r of results) {
        console.log('  ' + r.label.padEnd(42) + ms(r.p50) + ms(r.p95) + ms(r.max));
    }
    console.log('  ' + '-'.repeat(74));
}

// ---------------------------------------------------------------------------
// seeding — all inside the caller's transaction
//
// The seed statements go to the driver RAW (db._client is the transaction's
// pg client). db.run/db.all route through the SQLite-compatibility
// translator, which rewrites GROUP BY ordinals and `?` placeholders and is not
// built for INSERT ... SELECT with window functions. The MEASURED paths below
// deliberately still go through the normal db API, so what is timed is exactly
// what the app executes.
// ---------------------------------------------------------------------------
const raw = (sql, params = []) => db._client().query(sql, params);

async function seed(counts) {
    const existing = Number(counts.employees);
    const toAdd = Math.max(0, TARGET_EMPLOYEES - existing);
    console.log(
        `  seeding ${toAdd} synthetic employees (target ${TARGET_EMPLOYEES}, existing ${existing}) ...`
    );
    if (toAdd === 0) return;

    // Reuse REAL org placements so v_employee_details joins exactly as in prod
    // and the site/department scopes stay meaningful.
    const placements = (
        await raw(
            `SELECT site_id, department_id, service_id, role_id
           FROM employees WHERE is_active = true
          GROUP BY 1,2,3,4`
        )
    ).rows;
    if (!placements.length)
        throw new Error('no existing active employees to derive placements from');

    const admin = (await raw('SELECT id FROM admins ORDER BY id LIMIT 1')).rows[0];
    if (!admin) throw new Error('no admin row to attribute assessments to');

    const t0 = Date.now();
    // Employees: generate_series driven, placements round-robined.
    await raw(
        `INSERT INTO employees
             (employee_number, first_name, last_name, site_id, department_id, service_id, role_id, is_active)
         SELECT '${SYNTHETIC_PREFIX}' || lpad(g::text, 7, '0'),
                'Load', 'Test' || g,
                p.site_id, p.department_id, p.service_id, p.role_id,
                true
           FROM generate_series(1, $1) g
           JOIN LATERAL (
                SELECT site_id, department_id, service_id, role_id
                  FROM (SELECT site_id, department_id, service_id, role_id,
                               row_number() OVER (ORDER BY site_id, department_id, service_id, role_id) - 1 AS n
                          FROM employees WHERE is_active = true
                         GROUP BY 1,2,3,4) q
                 WHERE q.n = g % $2
           ) p ON TRUE`,
        [toAdd, placements.length]
    );

    console.log(`    employees inserted in ${Date.now() - t0} ms`);

    // Supervisor-validated assessments on ASSESSED_PCT of each synthetic
    // employee's FULL required-skill catalogue. hashtext gives a stable,
    // uniform pseudo-random spread without a per-row random re-plan.
    const t1 = Date.now();
    await raw(
        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, assessed_at, notes)
         SELECT e.id, rsr.skill_id,
                (abs(hashtext(e.id::text || ':' || rsr.skill_id::text)) % 5)::smallint,
                $1,
                now() - ((abs(hashtext(e.id::text)) % 300) || ' days')::interval,
                'loadtest'
           FROM employees e
           JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id AND rsr.required_level > 0
          WHERE e.employee_number LIKE '${SYNTHETIC_PREFIX}%'
            AND (abs(hashtext('a' || e.id::text || ':' || rsr.skill_id::text)) % 100) < $2
         ON CONFLICT (employee_id, skill_id) DO NOTHING`,
        [admin.id, ASSESSED_PCT]
    );
    console.log(`    skill_assessments inserted in ${Date.now() - t1} ms`);

    // Approved self-ratings on a further slice — the second UNION branch of the
    // resolution, and the branch that makes 'self_only' a real state.
    const t2 = Date.now();
    await raw(
        // `approved_by_ref = 'unknown'` : migration 116 exige que toute ligne
        // approuvée nomme son auteur. Ces lignes sont SYNTHÉTIQUES — personne ne
        // les a approuvées — donc elles portent la marque « auteur inconnu », qui
        // est la vérité, plutôt qu'un nom inventé.
        `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, created_at, updated_at, workflow_state, approved_by_ref)
         SELECT e.id, rsr.skill_id,
                (abs(hashtext('s' || e.id::text || ':' || rsr.skill_id::text)) % 5)::smallint,
                'approved',
                now() - ((abs(hashtext('t' || e.id::text)) % 300) || ' days')::interval,
                now(),
                'approved',
                'unknown'
           FROM employees e
           JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id AND rsr.required_level > 0
          WHERE e.employee_number LIKE '${SYNTHETIC_PREFIX}%'
            AND (abs(hashtext('b' || e.id::text || ':' || rsr.skill_id::text)) % 100) < $1`,
        [SELF_PCT]
    );
    console.log(`    self_assessments inserted in ${Date.now() - t2} ms`);

    const t3 = Date.now();
    await raw('ANALYZE employees');
    await raw('ANALYZE skill_assessments');
    await raw('ANALYZE self_assessments');
    await raw('ANALYZE role_skill_requirements');
    console.log(`    ANALYZE in ${Date.now() - t3} ms`);
}

// ---------------------------------------------------------------------------
// Synthetic-namespace footprint and removal.
//
// The measured run never commits, so this exists for the case the primary
// mechanism could not run to completion (a killed process mid-transaction on a
// machine somebody then dumps) — and so that "can it remove everything it
// created?" has an answer that is executable rather than argued.
// ---------------------------------------------------------------------------
async function syntheticFootprint() {
    const like = `${SYNTHETIC_PREFIX}%`;
    return (
        await raw(
            `SELECT (SELECT COUNT(*) FROM employees WHERE employee_number LIKE $1)::int AS "employees",
                (SELECT COUNT(*) FROM skill_assessments a
                   JOIN employees e ON e.id = a.employee_id
                  WHERE e.employee_number LIKE $1)::int AS "skillAssessments",
                (SELECT COUNT(*) FROM self_assessments a
                   JOIN employees e ON e.id = a.employee_id
                  WHERE e.employee_number LIKE $1)::int AS "selfAssessments",
                (SELECT COUNT(*) FROM assessment_history h
                   JOIN employees e ON e.id = h.employee_id
                  WHERE e.employee_number LIKE $1)::int AS "assessmentHistory"`,
            [like]
        )
    ).rows[0];
}

/**
 * Delete the whole synthetic namespace. One transaction, so it is all-or-nothing.
 *
 * assessment_history / system_logs / review_signatures carry BEFORE DELETE
 * block_mutation triggers; a DELETE against them raises and poisons the whole
 * PostgreSQL transaction. The rest of the codebase handles that by disabling
 * those triggers for the duration of a destructive operation inside a
 * transaction (see DatabaseCleanupService) — ALTER TABLE is transactional, so a
 * rollback restores them, and they are re-enabled explicitly on the way out.
 * Only rows belonging to `LT-` employees are ever reachable here: real audit
 * history is untouched.
 */
async function cleanupSynthetic() {
    const like = `${SYNTHETIC_PREFIX}%`;
    const before = await syntheticFootprint();
    console.log(
        `  synthetic rows found: employees=${before.employees} ` +
            `skill_assessments=${before.skillAssessments} self_assessments=${before.selfAssessments} ` +
            `assessment_history=${before.assessmentHistory}`
    );
    if (!before.employees && !before.assessmentHistory) {
        console.log('  nothing to remove.\n');
        return;
    }
    await db.runTransaction(async () => {
        const toggled = (
            await raw(
                `SELECT c.relname AS tbl, t.tgname AS tgname
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE n.nspname = 'public' AND NOT t.tgisinternal
                AND p.proname = 'block_mutation'`
            )
        ).rows;
        for (const { tbl, tgname } of toggled) {
            await raw(`ALTER TABLE public."${tbl}" DISABLE TRIGGER "${tgname}"`);
        }
        // employees is the parent; skill_assessments / self_assessments /
        // assessment_history all cascade from it.
        await raw(`DELETE FROM employees WHERE employee_number LIKE $1`, [like]);
        for (const { tbl, tgname } of toggled) {
            await raw(`ALTER TABLE public."${tbl}" ENABLE TRIGGER "${tgname}"`);
        }
    });
    const after = await syntheticFootprint();
    const clean = ['employees', 'skillAssessments', 'selfAssessments', 'assessmentHistory'].every(
        (k) => Number(after[k]) === 0
    );
    console.log(
        `  after cleanup      : employees=${after.employees} ` +
            `skill_assessments=${after.skillAssessments} self_assessments=${after.selfAssessments} ` +
            `assessment_history=${after.assessmentHistory}`
    );
    if (!clean) {
        console.error('  !! synthetic rows REMAIN — cleanup did not complete.');
        process.exitCode = 1;
    } else {
        console.log('  OK — the synthetic namespace is gone.\n');
    }
}

async function tableCounts() {
    return (
        await raw(
            `SELECT (SELECT COUNT(*) FROM employees)          AS "employees",
                (SELECT COUNT(*) FROM skill_assessments)  AS "skillAssessments",
                (SELECT COUNT(*) FROM self_assessments)   AS "selfAssessments",
                (SELECT COUNT(*) FROM assessment_history) AS "assessmentHistory"`
        )
    ).rows[0];
}

/** BEFORE vs AFTER, per scope, per hot path — p50 and p95 side by side. */
function deltaReport(beforeRes, afterRes) {
    for (const scope of Object.keys(afterRes)) {
        console.log(`\n  DELTA — ${scope}`);
        console.log('  ' + '-'.repeat(88));
        console.log(
            '  ' +
                'hot path'.padEnd(42) +
                'before p50'.padStart(11) +
                'after p50'.padStart(11) +
                'before p95'.padStart(11) +
                'after p95'.padStart(11) +
                '   change'
        );
        console.log('  ' + '-'.repeat(88));
        const b = new Map((beforeRes[scope] || []).map((r) => [r.label, r]));
        for (const a of afterRes[scope]) {
            const bb = b.get(a.label);
            if (!bb) continue;
            const factor = a.p50 > 0 ? bb.p50 / a.p50 : null;
            const change =
                factor === null
                    ? ''
                    : factor >= 1
                      ? `${factor.toFixed(1)}x faster`
                      : `${(1 / factor).toFixed(1)}x SLOWER`;
            console.log(
                '  ' +
                    a.label.padEnd(42) +
                    bb.p50.toFixed(1).padStart(11) +
                    a.p50.toFixed(1).padStart(11) +
                    bb.p95.toFixed(1).padStart(11) +
                    a.p95.toFixed(1).padStart(11) +
                    '   ' +
                    change
            );
        }
        console.log('  ' + '-'.repeat(88));
    }
}

// ---------------------------------------------------------------------------
// the measured hot paths
// ---------------------------------------------------------------------------
async function measure(scopeLabel, filters) {
    const results = [];
    await timeIt(
        'DashboardModel.getOverviewKPIs',
        () => DashboardModel.getOverviewKPIs(filters),
        results
    );
    await timeIt(
        'DashboardService.getAssessmentProvenance',
        () => DashboardService.getAssessmentProvenance(filters),
        results
    );
    await timeIt(
        'DashboardModel.getReadinessByGroup(site)',
        () => DashboardModel.getReadinessByGroup('site', filters),
        results
    );
    await timeIt(
        'DashboardModel.getReadinessByGroup(service)',
        () => DashboardModel.getReadinessByGroup('service', filters),
        results
    );
    await timeIt(
        'DashboardModel.getReadinessDistribution',
        () => DashboardModel.getReadinessDistribution(filters),
        results
    );
    await timeIt(
        'DashboardModel.getRoleStaffing',
        () => DashboardModel.getRoleStaffing(filters),
        results
    );
    await timeIt(
        'DashboardModel.getSkillGaps(20)',
        () => DashboardModel.getSkillGaps(filters, 20),
        results
    );
    await timeIt(
        'getExecutiveData  (UNCACHED, end-to-end)',
        () => DashboardService.getExecutiveData(filters, { cache: false }),
        results
    );
    await timeIt(
        'getExecutiveData  (cached, end-to-end)',
        () => DashboardService.getExecutiveData(filters, { cache: true }),
        results,
        1
    );
    report(scopeLabel, results);
    return results;
}

// ---------------------------------------------------------------------------
// A/B: the PRE-migration-80 view shape.
//
// Comparing two separate runs compares two machine states as much as two view
// definitions. DDL is transactional in PostgreSQL, so the honest way to measure
// the change is to install the OLD definitions INSIDE the same transaction, on
// the same seed, in the same process — and roll both back.
//
// These are verbatim the definitions migration 80 replaced: both consumers
// joining v_resolved_assessments, whose ROW_NUMBER window blocks the scope
// predicate from reaching the base scan. Kept here and nowhere else; the
// migration is the source of truth for the CURRENT shape.
// ---------------------------------------------------------------------------
const PRE80_VIEWS = `
CREATE OR REPLACE VIEW v_requirement_provenance AS
SELECT e.employee_id, e.site_id, e.site_name, e.department_id, e.department_name,
       e.service_id, e.service_name, e.role_id, e.role_name,
       s.id AS skill_id, s.name AS skill_name, dom.id AS domain_id, dom.name AS domain_name,
       rsr.required_level, rsr.is_critical,
       ra.level AS assessed_level, ra.source, ra.assessed_at,
       COALESCE(ra.assessment_status, 'never_assessed') AS assessment_status,
       CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s   ON s.id  = rsr.skill_id
JOIN domains dom ON dom.id = s.domain_id
LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.employee_id AND ra.skill_id = rsr.skill_id
WHERE rsr.required_level > 0;

CREATE OR REPLACE VIEW v_employee_skill_gaps AS
SELECT e.employee_id, e.site_id, e.site_name, e.department_id, e.department_name,
       e.service_id, e.service_name, e.role_id, e.role_name,
       s.id AS skill_id, s.name AS skill_name, dom.id AS domain_id, dom.name AS domain_name,
       rsr.required_level,
       CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE COALESCE(ra.level::integer, 0) END AS actual_level,
       rsr.required_level - CASE WHEN cl.employee_id IS NOT NULL THEN 0
                                 ELSE COALESCE(ra.level::integer, 0) END AS gap,
       rsr.is_critical,
       CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed,
       CASE WHEN CASE WHEN cl.employee_id IS NOT NULL THEN 0
                      ELSE COALESCE(ra.level::integer, 0) END >= rsr.required_level
            THEN 1 ELSE 0 END AS is_met,
       COALESCE(ra.level::integer, 0) AS assessed_level,
       cl.employee_id IS NOT NULL AS cert_lapsed
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s   ON s.id  = rsr.skill_id
JOIN domains dom ON dom.id = s.domain_id
LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.employee_id AND ra.skill_id = rsr.skill_id
LEFT JOIN v_certification_lapsed cl ON cl.employee_id = e.employee_id AND cl.skill_id = rsr.skill_id
WHERE rsr.required_level > 0;
`;

/**
 * Prove the A and B shapes answer the question identically before timing them.
 *
 * Excludes the (employee, skill) pairs whose candidate rows tie EXACTLY on the
 * latest timestamp. The pre-80 ROW_NUMBER had no tie-break, so on those pairs
 * it had no defined answer to preserve — migration 80 resolves them to the
 * supervisor-validated row on purpose. They are counted and printed, never
 * silently dropped. (This synthetic seed manufactures a handful because now
 * is the transaction timestamp; the real dev dataset has none.)
 */
const AMBIGUOUS_CTE = `
    WITH cand AS (
        SELECT employee_id, skill_id, assessed_at AS ts FROM skill_assessments
        UNION ALL
        SELECT employee_id, skill_id, created_at    FROM self_assessments WHERE status='approved'),
    amb AS (
        SELECT employee_id, skill_id FROM (
            SELECT employee_id, skill_id,
                   RANK() OVER (PARTITION BY employee_id, skill_id ORDER BY ts DESC) rk
              FROM cand) x
         WHERE rk = 1 GROUP BY employee_id, skill_id HAVING COUNT(*) > 1)`;

async function assertNoDrift(label) {
    const { rows } = await raw(`${AMBIGUOUS_CTE}
        SELECT (SELECT COUNT(*) FROM amb)::int AS "ambiguousPairs",
               (SELECT COUNT(*) FROM v_requirement_provenance p
                  LEFT JOIN v_resolved_assessments ra
                         ON ra.employee_id = p.employee_id AND ra.skill_id = p.skill_id
                 WHERE NOT EXISTS (SELECT 1 FROM amb a
                                    WHERE a.employee_id = p.employee_id AND a.skill_id = p.skill_id)
                   AND (p.assessed_level IS DISTINCT FROM ra.level
                    OR  p.assessment_status IS DISTINCT FROM COALESCE(ra.assessment_status,'never_assessed'))
               )::int AS "provenanceDrift",
               (SELECT COUNT(*) FROM v_employee_skill_gaps g
                  LEFT JOIN v_resolved_assessments ra
                         ON ra.employee_id = g.employee_id AND ra.skill_id = g.skill_id
                 WHERE NOT EXISTS (SELECT 1 FROM amb a
                                    WHERE a.employee_id = g.employee_id AND a.skill_id = g.skill_id)
                   AND g.assessed_level IS DISTINCT FROM COALESCE(ra.level::integer, 0)
               )::int AS "gapDrift",
               (SELECT ROUND(AVG(readiness_assessed_only),2) FROM v_employee_assessment_coverage
               ) AS "orgReadiness",
               (SELECT SUM(assessed_skills)::int FROM v_employee_assessment_coverage) AS "assessed",
               (SELECT SUM(expected_skills)::int FROM v_employee_assessment_coverage) AS "expected"`);
    const r = rows[0];
    console.log(
        `  [${label}] drift prov=${r.provenanceDrift} gaps=${r.gapDrift} ` +
            `(ambiguous ties excluded: ${r.ambiguousPairs}) | ` +
            `org readiness_assessed_only=${r.orgReadiness} assessed=${r.assessed}/${r.expected}`
    );
    if (r.provenanceDrift !== 0 || r.gapDrift !== 0) {
        throw new Error(`[${label}] view drift detected — the shapes do not agree`);
    }
    return r;
}

// ---------------------------------------------------------------------------
(async () => {
    await db.connect();

    if (CHECK_ONLY || CLEANUP) {
        console.log(`\n  IDevelop readiness load test — ${CLEANUP ? 'CLEANUP' : 'CHECK'}`);
        console.log(`  database        : ${DB_NAME}`);
        console.log(`  namespace       : employee_number LIKE '${SYNTHETIC_PREFIX}%'`);
        if (CLEANUP) {
            await cleanupSynthetic();
        } else {
            const f = await syntheticFootprint();
            console.log(
                `  synthetic rows  : employees=${f.employees} skill_assessments=${f.skillAssessments} ` +
                    `self_assessments=${f.selfAssessments} assessment_history=${f.assessmentHistory}`
            );
            console.log(
                f.employees || f.assessmentHistory
                    ? '  → run with --cleanup to remove them.\n'
                    : '  → clean.\n'
            );
        }
        await db.close();
        return;
    }

    const before = await tableCounts();

    console.log(`\n  IDevelop readiness load test`);
    console.log(`  database        : ${DB_NAME}`);
    console.log(`  target employees: ${TARGET_EMPLOYEES}`);
    console.log(`  runs per path   : ${RUNS}`);
    console.log(
        `  baseline rows   : employees=${before.employees} skill_assessments=${before.skillAssessments} self_assessments=${before.selfAssessments}`
    );

    let scopeSite = null;
    try {
        await db.runTransaction(async () => {
            if (!SKIP_SEED) await seed(before);

            const seeded = await tableCounts();
            console.log(
                `  seeded rows     : employees=${seeded.employees} skill_assessments=${seeded.skillAssessments} self_assessments=${seeded.selfAssessments}`
            );

            // Biggest site = a director's scope; smallest = the case the window
            // function punished hardest (a tiny scope still paying for the whole
            // org's assessment history).
            scopeSite = (
                await raw(
                    `SELECT site_id AS "siteId", site_name AS "siteName", COUNT(*)::int AS n
                   FROM v_employee_details GROUP BY 1,2 ORDER BY 3 DESC LIMIT 1`
                )
            ).rows[0];
            const smallSite = (
                await raw(
                    `SELECT site_id AS "siteId", site_name AS "siteName", COUNT(*)::int AS n
                   FROM v_employee_details GROUP BY 1,2 ORDER BY 3 ASC LIMIT 1`
                )
            ).rows[0];

            const scopes = [
                [`ORG-WIDE (superadmin, no filters) — ${seeded.employees} employees`, {}],
                [
                    `SITE (director of "${scopeSite.siteName}", ${scopeSite.n} employees)`,
                    { siteIds: [scopeSite.siteId] },
                ],
                [
                    `SMALL SITE (manager of "${smallSite.siteName}", ${smallSite.n} employees)`,
                    { siteIds: [smallSite.siteId] },
                ],
            ];

            const runAll = async (shape) => {
                const out = {};
                for (const [label, filters] of scopes) {
                    DashboardService.invalidate(); // never measure a cache as if it were the DB
                    out[label] = await measure(`${shape} — ${label}`, filters);
                }
                return out;
            };

            const afterRef = await assertNoDrift('AFTER  (migration 80, LATERAL)');
            const after = await runAll('AFTER  (migration 80, LATERAL)');

            let beforeRes = null;
            if (AB) {
                console.log('\n  installing the PRE-80 view shape inside the transaction ...');
                await raw(PRE80_VIEWS);
                const beforeRef = await assertNoDrift('BEFORE (pre-80, window join)');
                // The whole point: same seed, same numbers, different plan. The
                // coverage counts must match EXACTLY (a tie changes which row
                // wins, never whether one exists); org readiness is allowed the
                // hair's breadth those `ambiguousPairs` can move it.
                const readinessGap = Math.abs(
                    Number(beforeRef.orgReadiness) - Number(afterRef.orgReadiness)
                );
                if (
                    beforeRef.assessed !== afterRef.assessed ||
                    beforeRef.expected !== afterRef.expected ||
                    readinessGap > 0.05
                ) {
                    throw new Error(
                        `A/B invalid: the two shapes report DIFFERENT numbers ` +
                            `(assessed ${beforeRef.assessed}/${afterRef.assessed}, ` +
                            `expected ${beforeRef.expected}/${afterRef.expected}, ` +
                            `readiness ${beforeRef.orgReadiness}/${afterRef.orgReadiness})`
                    );
                }
                beforeRes = await runAll('BEFORE (pre-80, window join)');
                deltaReport(beforeRes, after);
            }

            // Roll the whole seed AND the DDL back. The ONLY exit from the tx.
            throw new Error('__ROLLBACK__');
        });
    } catch (e) {
        if (e.message !== '__ROLLBACK__') {
            console.error(e);
            process.exitCode = 1;
        }
    }

    DashboardService.invalidate();
    const after = await tableCounts();
    const same = ['employees', 'skillAssessments', 'selfAssessments', 'assessmentHistory'].every(
        (k) => String(before[k]) === String(after[k])
    );
    console.log(
        `\n  rollback verified: employees=${after.employees} skill_assessments=${after.skillAssessments} ` +
            `self_assessments=${after.selfAssessments} assessment_history=${after.assessmentHistory}`
    );
    // Belt and braces: prove the synthetic namespace is empty, not merely that
    // the totals match. A count that happens to balance is not the same fact.
    const residue = await syntheticFootprint();
    const noResidue = [
        'employees',
        'skillAssessments',
        'selfAssessments',
        'assessmentHistory',
    ].every((k) => Number(residue[k]) === 0);
    console.log(
        `  synthetic residue: employees=${residue.employees} skill_assessments=${residue.skillAssessments} ` +
            `self_assessments=${residue.selfAssessments} assessment_history=${residue.assessmentHistory}`
    );

    if (!same || !noResidue) {
        if (!same)
            console.error('  !! ROW COUNTS MOVED — the transaction did not roll back cleanly.');
        if (!noResidue)
            console.error(
                `  !! SYNTHETIC ROWS SURVIVED — run: node scripts/loadtest-readiness.js --cleanup`
            );
        process.exitCode = 1;
    } else {
        console.log('  OK — nothing was committed.\n');
    }

    await db.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
