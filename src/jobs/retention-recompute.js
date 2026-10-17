'use strict';

/**
 * retention-recompute — the nightly risk-of-loss sweep.
 *
 * RetentionRiskService.computeFor was invoked from exactly ONE place: the
 * single-employee "recompute" button on /v2/continuity. Nobody presses that
 * 4000 times, so `retention_risk` stayed empty, and the incumbent-risk columns
 * of v_continuity_coverage (incumbent_flight_risk / incumbent_impact_of_loss)
 * were blank for every row — the coverage heat-map shipped with a permanently
 * empty column. This tick fills it, every night, for the whole active
 * population.
 *
 * Cadence: hourly tick, self-gated to one pass per day at/after
 * `retentionRecomputeHour` (default 02:00). The day is claimed via a date setting
 * AFTER the sweep runs to completion, not before: computeFor upserts
 * retention_risk in place and every crossing notification is guarded by its own
 * (manager, employee, month) claim, so a re-run is idempotent and never
 * double-notifies. Claiming after completion means a sweep that FAILS outright
 * (e.g. the population query throws) is retried on the next hourly tick instead
 * of the day being burned and last night's flight-risk left on the heat-map as if
 * it were tonight's. If the box was off at 02:00 the first tick after start-up
 * still runs the day's pass — the gate is "at or after", never "exactly at".
 *
 * CROSSING detection: the effective flight_risk (the manager's override wins,
 * exactly as computeFor stores it) is read BEFORE the recompute and compared
 * with the result. Only a transition into 'high' notifies — a person who is
 * already high produces nothing, which is why this cannot become a nightly
 * drip. The claim-before-send ledger is the second belt: one claim per
 * (manager, employee, month).
 *
 * Delivery: IN-APP ONLY, via enqueue rather than notify. retention_risk
 * carries a `restricted` confidentiality tier in the schema (24_continuity.sql);
 * notify would fan the event out to external webhooks before any policy check
 * ran. The payload is a COUNT and a deep link — never a name, never a band.
 * The daily personal digest still rolls it into one courteous email.
 */

const db = require('../config/database');
const { claim, release, monthBucket } = require('./reminders');
const { dayKey } = require('../utils/dayKey');

const ENV_HOUR = Number(process.env.RETENTION_RECOMPUTE_HOUR) || 2;

async function tick() {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');

    let hour = ENV_HOUR;
    try {
        hour = Number(await AppSettingsModel.getValue('retentionRecomputeHour', ENV_HOUR));
    } catch {
        /* default */
    }
    if (!Number.isFinite(hour)) hour = ENV_HOUR;
    if (now.getHours() < hour) return { computed: 0, skipped: 'not_due' };

    const today = dayKey(now); // LOCAL day — matches the getHours() gate above (J12)
    let last = null;
    try {
        last = await AppSettingsModel.getValue('retentionRecomputeLastRunOn', null);
    } catch {
        /* proceed */
    }
    if (last === today) return { computed: 0, skipped: 'already_today' };

    const RetentionRiskService = require('../services/RetentionRiskService');
    const N = require('../services/NotificationService');
    const mo = monthBucket(now);
    const out = { computed: 0, failed: 0, crossedToHigh: 0, notified: 0 };

    // The whole active population, plus each person's manager and the band the
    // row held BEFORE tonight — one query instead of two per employee.
    // The recipient is the EFFECTIVE reviewer (3.23.18 R2): ACTIVE supervisor →
    // ACTIVE employee-manager → ACTIVE admin-manager. Before, an inactive
    // supervisor made the join miss and the crossing reached nobody, and an
    // admin manager was never reachable.
    const RL = require('../services/ReportingLineService');
    const people = await db.all(
        `SELECT e.id,
                rl.id AS mgr_id, rl.kind AS mgr_type,
                rr.flight_risk AS prior_band
           FROM employees e
           ${RL.effectiveReviewerJoinSql('e', 'rl')}
           LEFT JOIN retention_risk rr ON rr.employee_id = e.id
          WHERE e.is_active = true
          ORDER BY e.id`
    );

    // Managers whose team gained a newly-high risk tonight → count per manager.
    const byManager = new Map();

    // Objection to profiling (GDPR art. 21): people who objected are SKIPPED,
    // never scored, and their stored automated verdict stays withdrawn ("not
    // computed: objection", never a low score). Read ONCE, before the loop, and
    // FAIL CLOSED: if the objections cannot be read the sweep throws, the day is
    // not claimed, and the next hourly tick retries.
    const objectors = await require('../services/PrivacyService').activeObjectorIds();
    out.skippedObjection = 0;

    for (const p of people) {
        const empId = Number(p.id);
        const prior = p.priorBand ?? p.prior_band ?? null;
        if (objectors.has(empId)) {
            out.skippedObjection++;
            try {
                await RetentionRiskService.suppressForObjection(empId);
            } catch (_) {
                /* idempotent; retried tomorrow, and the person is still not scored */
            }
            continue;
        }
        let row;
        try {
            row = await RetentionRiskService.computeFor(empId);
            out.computed++;
        } catch (_) {
            out.failed++; // one bad row never aborts the sweep
            continue;
        }
        const band = row ? (row.flightRisk ?? row.flight_risk) : null;
        if (band !== 'high' || prior === 'high') continue; // no crossing
        out.crossedToHigh++;

        const mgr = Number(p.mgrId ?? p.mgr_id) || null;
        const mgrType = (p.mgrType ?? p.mgr_type) === 'admin' ? 'admin' : 'employee';
        if (!mgr) continue; // nobody to tell; the row is still on /v2/continuity
        // Claim-before-send at ROW granularity so tonight's crossing can never
        // re-fire tomorrow night, then aggregate the survivors into ONE
        // notification per manager.
        if (!(await claim('retention.high', mgrType, mgr, empId, mo))) continue;
        const key = `${mgrType}:${mgr}`;
        const cur = byManager.get(key) || { userType: mgrType, userId: mgr, empIds: [] };
        cur.empIds.push(empId); // remember WHICH claims this manager's notification carries
        byManager.set(key, cur);
    }

    for (const { userType, userId: mgr, empIds } of byManager.values()) {
        const count = empIds.length;
        try {
            await N.enqueue({
                userType,
                userId: mgr,
                channel: 'inapp',
                kind: 'retention.risk_high',
                payload: { link: '/v2/continuity', count },
            });
            out.notified++;
        } catch (_) {
            // Nothing was delivered, and the claims were taken per crossing BEFORE
            // this aggregate send: keeping them would lose tonight's crossings for
            // the whole MONTH (the claim period), with no retry and no trace.
            // Hand every claim behind this notification back.
            for (const empId of empIds) await release('retention.high', userType, mgr, empId, mo);
        }
    }

    // The sweep ran to completion (per-row computeFor failures were counted, not
    // thrown, and never abort the pass). Claim the day now so it does not re-run
    // until tomorrow. Had the population query or another systemic step thrown, we
    // would never reach here and the next hourly tick would retry — the point of
    // claiming AFTER rather than before.
    try {
        await AppSettingsModel.setValue(
            'retentionRecomputeLastRunOn',
            today,
            'string',
            'Last retention-risk recompute date',
            'jobs'
        );
    } catch {
        /* best-effort; a missed claim only costs an idempotent re-run */
    }

    if (process.env.NODE_ENV !== 'test') {
        console.log(
            `[retention-recompute] computed:${out.computed} failed:${out.failed} objection:${out.skippedObjection} crossed:${out.crossedToHigh} notified:${out.notified}`
        );
    }
    return out;
}

module.exports = { tick };
