'use strict';

/**
 * seed-demo — a believable demo dataset for screenshots and sales, and an EXACT
 * way to take it away again.
 *
 *   node scripts/seed-demo.js --seed     populate
 *   node scripts/seed-demo.js --status   report what is currently planted
 *   node scripts/seed-demo.js --clean    remove every trace
 *
 * ---------------------------------------------------------------------------
 * SAFETY CONTRACT — read this before changing anything here.
 *
 * 1. REFUSES TO RUN IN PRODUCTION.
 *    NODE_ENV=production is a hard stop for --seed. There is no override flag,
 *    no environment variable that unlocks it, and --clean is the only verb that
 *    stays available (you must always be able to remove demo data).
 *
 * 2. EVERYTHING IT WRITES IS NAMESPACED.
 *    Every row this script creates is tagged with the marker below, in a column
 *    that is part of the row's own identity:
 *      - role_criticality.rationale        starts with the marker
 *      - succession_plans.notes            starts with the marker
 *      - kpi_snapshots.scope_label         starts with the marker
 *    Nothing is written to employees, skills, roles, assessments or any table
 *    that carries real workforce data. The demo makes the EXISTING people look
 *    like a live deployment; it does not invent people.
 *
 * 3. CLEANUP IS EXACT AND VERIFIED.
 *    --clean deletes strictly by the marker and then re-counts, printing a
 *    non-zero exit code if anything survived. --seed always runs a clean first,
 *    so re-seeding cannot double up.
 *
 * WHY THIS MATTERS OPERATIONALLY
 *    Build-Package.ps1 regenerates a pg_dump of the app database INTO the
 *    installer. Anything left in the database at package time ships to
 *    customers. Leave the database clean.
 * ---------------------------------------------------------------------------
 */

// Capture NODE_ENV BEFORE .env is loaded. dotenv does not override an existing
// variable, but a .env saying `NODE_ENV=development` on a box where the real
// environment never set NODE_ENV at all would otherwise be able to talk this
// script into seeding. The guard below trips if EITHER the pre-.env process
// environment or the post-.env value says production, so .env can only ever
// make the refusal more likely, never less.
const NODE_ENV_BEFORE_DOTENV = process.env.NODE_ENV;

// Same entry-point convention as scripts/migrate.js: load .env so the script
// can be run standalone.
require('dotenv').config();

const MARKER = '[DEMO-SEED]';

// Tables touched, with the marker column used to identify demo rows. Cleanup
// iterates this list, so adding a table here is the ONLY thing needed to keep
// --clean exact.
const NAMESPACED = [
    { table: 'succession_plans', column: 'notes' },
    { table: 'role_criticality', column: 'rationale' },
    { table: 'kpi_snapshots', column: 'scope_label' },
];

function isProduction() {
    const isProd = (v) => String(v || '').toLowerCase() === 'production';
    return isProd(NODE_ENV_BEFORE_DOTENV) || isProd(process.env.NODE_ENV);
}

async function counts(db) {
    const out = {};
    for (const { table, column } of NAMESPACED) {
        try {
            const row = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`, [
                MARKER + '%',
            ]);
            out[table] = Number(row ? row.n : 0);
        } catch (e) {
            out[table] = `unavailable (${e.message})`;
        }
    }
    return out;
}

async function clean(db, { quiet } = {}) {
    for (const { table, column } of NAMESPACED) {
        try {
            await db.run(`DELETE FROM ${table} WHERE ${column} LIKE ?`, [MARKER + '%']);
        } catch (e) {
            console.error(`  ! ${table}: ${e.message}`);
        }
    }
    // Verify, do not assume: re-count after deleting and report survivors.
    const left = await counts(db);
    const survivors = Object.entries(left).filter(([, n]) => typeof n === 'number' && n > 0);
    for (const [t, n] of Object.entries(left)) {
        if (!quiet) console.log(`  ${t}: ${n} demo row(s) remaining`);
    }
    if (survivors.length) {
        console.error('\n✗ CLEANUP INCOMPLETE — demo rows survived:', survivors);
        return false;
    }
    if (!quiet) console.log('\n✓ Database clean — no demo rows remain.');
    return true;
}

async function seed(db) {
    // Always start from clean so re-running cannot accumulate.
    console.log('Removing any previous demo data first...');
    if (!(await clean(db, { quiet: true }))) {
        throw new Error('refusing to seed on top of demo data that could not be removed');
    }

    // --- 1. Critical-role designations -------------------------------------
    // role_criticality is empty on a fresh install, which makes the whole
    // succession module look dormant in a demo. Score the roles that carry the
    // most people, so the coverage table has something real to show.
    const roles = await db.all(
        `SELECT r.id AS "id", r.name AS "name", COUNT(e.id) AS "occupants"
           FROM roles r
           JOIN employees e ON e.role_id = r.id AND e.is_active = true
          GROUP BY r.id, r.name
          HAVING COUNT(e.id) > 0
          ORDER BY COUNT(e.id) DESC
          LIMIT 8`
    );

    const RISK = ['high', 'medium', 'high', 'medium', 'low'];
    let designated = 0;
    let preserved = 0;
    for (let i = 0; i < roles.length; i++) {
        const r = roles[i];

        // NEVER overwrite a REAL criticality designation. This used to be an
        // unconditional ON CONFLICT DO UPDATE, which on a customer database would
        // (1) replace the department's own scoring with demo values and (2) stamp
        // the demo MARKER into `rationale` — so the subsequent --clean, which
        // deletes strictly by marker, would DELETE the real row it had just
        // overwritten. Seed-then-clean destroyed department-designed data.
        // Same rule the succession_plans block below already follows: a row that
        // is not ours is left completely alone.
        const existing = await db.get(
            'SELECT role_id, rationale FROM role_criticality WHERE role_id = ?',
            [r.id]
        );
        if (existing && !String(existing.rationale || '').startsWith(MARKER)) {
            preserved++;
            continue;
        }

        const score = Math.max(1, Math.min(5, 5 - Math.floor(i / 2)));
        await db.run(
            `INSERT INTO role_criticality
               (role_id, criticality_score, business_impact, vacancy_risk, time_to_fill_days, rationale)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (role_id) DO UPDATE SET
               criticality_score = EXCLUDED.criticality_score,
               business_impact   = EXCLUDED.business_impact,
               vacancy_risk      = EXCLUDED.vacancy_risk,
               time_to_fill_days = EXCLUDED.time_to_fill_days,
               rationale         = EXCLUDED.rationale,
               updated_at        = now()`,
            [
                r.id,
                score,
                `${MARKER} Interruption directe de la production si le poste reste vacant.`,
                RISK[i % RISK.length],
                30 + i * 15,
                `${MARKER} Cotation de démonstration — ${r.occupants} titulaire(s).`,
            ]
        );
        designated++;
    }
    console.log(
        `  role_criticality: ${designated} role(s) designated` +
            (preserved ? `, ${preserved} real designation(s) left untouched` : '')
    );

    // --- 2. Succession plans ------------------------------------------------
    // One open plan per designated role, with the current occupant as incumbent
    // so the bench/coverage view has an anchor.
    let plans = 0;
    for (const r of roles.slice(0, 5)) {
        const occ = await db.get(
            `SELECT id FROM employees WHERE role_id = ? AND is_active = true ORDER BY id LIMIT 1`,
            [r.id]
        );
        // The partial unique index allows one non-archived plan per role, so a
        // pre-existing REAL plan must not be disturbed.
        const existing = await db.get(
            `SELECT id, notes FROM succession_plans WHERE position_role_id = ? AND status <> 'archived'`,
            [r.id]
        );
        if (existing) continue;
        await db.run(
            `INSERT INTO succession_plans
               (position_role_id, incumbent_employee_id, status, review_due, notes)
             VALUES (?, ?, 'active', CURRENT_DATE + 90, ?)`,
            [r.id, occ ? occ.id : null, `${MARKER} Plan de démonstration.`]
        );
        plans++;
    }
    console.log(`  succession_plans: ${plans} plan(s) opened`);

    // --- 3. KPI history -----------------------------------------------------
    // A dashboard delta needs a prior snapshot. Backdate a short, MONOTONIC-ish
    // org series so "+x since" has something honest to compare against in a
    // screenshot. Real values are used as the endpoint so the demo agrees with
    // the live KPI strip.
    const DashboardModel = require('../src/models/DashboardModel');
    const now = await DashboardModel.getOverviewKPIs({});
    const endReadiness = now && now.avgReadiness != null ? Number(now.avgReadiness) : null;
    const endCoverage =
        now && now.assessmentCoverage != null ? Number(now.assessmentCoverage) : null;

    let snaps = 0;
    if (endReadiness !== null) {
        // 3 monthly points BEFORE today, walking up to (but not including) the
        // real current value. Today's row is left to the real job.
        const steps = [
            { days: 90, drop: 4.2 },
            { days: 60, drop: 2.7 },
            { days: 30, drop: 1.3 },
        ];
        for (const s of steps) {
            await db.run(
                `INSERT INTO kpi_snapshots
                   (snapshot_date, scope_type, scope_id, scope_label,
                    avg_readiness, assessment_coverage)
                 VALUES (CURRENT_DATE - ?::int, 'org', 0, ?, ?, ?)
                 ON CONFLICT (snapshot_date, scope_type, scope_id) DO NOTHING`,
                [
                    s.days,
                    `${MARKER} org`,
                    Math.round((endReadiness - s.drop) * 10) / 10,
                    endCoverage === null
                        ? null
                        : Math.round((endCoverage - s.drop * 1.5) * 10) / 10,
                ]
            );
            snaps++;
        }
    } else {
        console.log('  kpi_snapshots: skipped — no measured readiness to anchor a series to');
    }
    console.log(`  kpi_snapshots: ${snaps} backdated point(s)`);

    console.log('\n✓ Demo data seeded.');
    console.log(`  Remove it with:  node scripts/seed-demo.js --clean`);
    console.log('  IMPORTANT: run --clean before building an installer package —');
    console.log('  Build-Package.ps1 dumps this database into the installer.');
}

async function main() {
    const argv = process.argv.slice(2);
    const wants = (f) => argv.includes(f);
    const mode = wants('--clean')
        ? 'clean'
        : wants('--status')
          ? 'status'
          : wants('--seed')
            ? 'seed'
            : null;

    if (!mode) {
        console.log('Usage: node scripts/seed-demo.js --seed | --status | --clean');
        console.log('\nDemo/sales dataset for a DEVELOPMENT database. Refuses to seed when');
        console.log('NODE_ENV=production. Everything it writes is tagged "' + MARKER + '"');
        console.log('and --clean removes exactly those rows.');
        process.exit(2);
    }

    // HARD STOP. No flag overrides this.
    if (mode === 'seed' && isProduction()) {
        console.error('✗ REFUSING TO SEED: NODE_ENV=production.');
        console.error('  This script plants demo data and must never touch a production database.');
        console.error('  (--clean and --status remain available.)');
        process.exit(1);
    }

    const db = require('../src/config/database');
    await db.connect();
    try {
        if (mode === 'status') {
            const c = await counts(db);
            console.log(`Demo rows tagged "${MARKER}":`);
            for (const [t, n] of Object.entries(c)) console.log(`  ${t}: ${n}`);
            const dirty = Object.values(c).some((n) => typeof n === 'number' && n > 0);
            console.log(
                dirty
                    ? '\n⚠ Demo data IS present. Run --clean before packaging.'
                    : '\n✓ No demo data present.'
            );
            process.exitCode = dirty ? 3 : 0;
        } else if (mode === 'clean') {
            console.log(`Removing rows tagged "${MARKER}"...`);
            const ok = await clean(db);
            process.exitCode = ok ? 0 : 1;
        } else {
            console.log(`Seeding demo data (NODE_ENV=${process.env.NODE_ENV || 'development'})...`);
            await seed(db);
        }
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error('✗', e.message);
        process.exit(1);
    });
}

module.exports = { MARKER, NAMESPACED, isProduction };
