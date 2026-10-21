'use strict';

/**
 * kpi-alerts — the daily threshold-alert pass (migration 186). The engine is
 * KpiAlertService.run(); this tick only decides WHEN.
 *
 * Registered hourly, self-gated to ONE pass per server day at or after
 * KPI_ALERTS_HOUR (default 6, after the kpi-snapshot of the night): the
 * indicators are daily facts, and an hourly re-evaluation would only page
 * people about intra-day noise. The day is CLAIMED atomically in
 * kpi_alert_states (rule_key '__run__'), so two runtimes (BullMQ and the
 * in-process scheduler) never both run it. A pass that throws releases
 * nothing: the transitions it stored are final, the recipients not told yet
 * are retried by the next pass.
 */

const db = require('../config/database');

function runHour() {
    const n = parseInt(process.env.KPI_ALERTS_HOUR || '6', 10);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 6;
}

function dayKey(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Claim today's pass; true only for the first caller of the day. */
async function claimDay(day) {
    const row = await db.get(
        `INSERT INTO kpi_alert_states (rule_key, scope_key, kpi_id, state, level, peak_level, updated_at)
         VALUES ('__run__', 'daily', '-', ?, 0, 0, now())
         ON CONFLICT (rule_key, scope_key) DO UPDATE
            SET state = EXCLUDED.state, updated_at = now()
          WHERE kpi_alert_states.state IS DISTINCT FROM EXCLUDED.state
         RETURNING 1 AS "claimed"`,
        [day]
    );
    return !!row;
}

async function tick({ now = new Date(), force = false } = {}) {
    if (!force && now.getHours() < runHour()) return { skipped: 'too_early' };
    const day = dayKey(now);
    if (!(await claimDay(day))) return { skipped: 'already_today' };
    return require('../services/KpiAlertService').run({ today: day });
}

module.exports = { tick, __test: { claimDay, runHour, dayKey } };
