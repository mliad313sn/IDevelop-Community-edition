'use strict';

/**
 * fit-history — daily snapshot of per-role benchmark fit (org truth, unscoped)
 * into benchmark_fit_history. Idempotent per day via ON CONFLICT DO NOTHING, so
 * the tick can run hourly and only the first run of the day writes. Powers the
 * fit-trend chart on the benchmark role drill-through.
 *
 * NEVER PERSISTS AN ABSENCE OF MEASUREMENT AS A RESULT
 *   getFit derives fit from v_employee_skill_gaps, where an unassessed skill
 *   carries actual_level 0. For a role whose occupants have never been assessed
 *   that arithmetic yields fit=0 / critical_fit=0 — a *fabricated* result, and
 *   one that is written into a trend history, so it is permanent.
 *   Coverage is the honest signal: it is the share of required skills actually
 *   assessed, so coverage = 0 means "nothing measured". In that case fit and
 *   critical_fit are stored as NULL (the schema documents NULL = no data, and
 *   the trend chart uses spanGaps so a NULL renders as a gap, not as a floor).
 *   Coverage itself is kept as 0 — that IS a measurement, and it is how the
 *   unmeasured state is reported explicitly rather than deleted.
 *   Same contract as jobs/kpi-snapshot.js.
 */

const db = require('../config/database');

/** null-safe numeric coercion: null/undefined/'' stay null, never become 0. */
function num(v) {
    return v == null || v === '' ? null : Number(v);
}

async function tick() {
    const BenchmarkModel = require('../models/BenchmarkModel');
    const fit = await BenchmarkModel.getFit({}); // unscoped = org truth
    const roles = (fit || []).filter((f) => f.roleId);
    if (!roles.length) return { snapped: 0, skipped: 'no_roles' };

    // COMPLETENESS, not existence (kpi-snapshot's isDayComplete). The old guard
    // skipped the whole tick when ANY row existed for today, so a run that wrote
    // some roles and then failed on one left a PERMANENT hole in the trend: every
    // retry saw a row, said "already_today", and never healed the missing roles.
    // Skip only when EVERY role getFit returns is already snapped today; otherwise
    // fill exactly the ones still missing.
    const existing = new Set(
        (
            await db.all(
                'SELECT role_id FROM benchmark_fit_history WHERE snapshot_date = CURRENT_DATE'
            )
        ).map((r) => Number(r.roleId ?? r.role_id))
    );
    if (roles.every((f) => existing.has(Number(f.roleId)))) {
        return { snapped: 0, skipped: 'already_today' };
    }

    let snapped = 0;
    let unmeasured = 0;
    const failed = [];
    for (const f of roles) {
        if (existing.has(Number(f.roleId))) continue; // already snapped — heal the rest
        const coverage = num(f.coverage);
        // Nothing assessed for this role's occupants → there is no fit to state.
        const measured = coverage != null && coverage > 0;
        // Per-role try/catch: one bad role must not abort the pass and lock the
        // day. A returned `failed` list is surfaced by JobRunService (a run where
        // every role failed raises ops.job_failed instead of reporting a clean run).
        try {
            await db.run(
                `INSERT INTO benchmark_fit_history (snapshot_date, role_id, occupants, fit, coverage, critical_fit)
                 VALUES (CURRENT_DATE, ?, ?, ?, ?, ?)
                 ON CONFLICT (snapshot_date, role_id) DO NOTHING`,
                [
                    Number(f.roleId),
                    Number(f.occupants) || 0,
                    measured ? num(f.benchmarkFit) : null,
                    coverage,
                    measured ? num(f.criticalFit) : null,
                ]
            );
            snapped++;
            if (!measured) unmeasured++;
        } catch (e) {
            failed.push({
                roleId: Number(f.roleId),
                error: String((e && e.message) || e).slice(0, 200),
            });
            console.error(`[fit-history] role ${f.roleId} snapshot failed:`, e && e.message);
        }
    }
    return failed.length ? { snapped, unmeasured, failed } : { snapped, unmeasured };
}

module.exports = { tick };
