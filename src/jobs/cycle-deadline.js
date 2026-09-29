'use strict';

/**
 * cycle-deadline — advances an assessment campaign past its OWN deadline.
 *
 * THE DEFECT THIS CLOSES
 *   `closes_at` was a date the application printed and nothing ever acted on.
 *   Locking and closing were reachable ONLY from the admin console, so an open
 *   campaign that sailed past its deadline stayed `open` for ever. Because
 *   IDPService.generateDrafts is driven by the 'cycle.closed' event, and that
 *   event is emitted only by the campaign close itself, the consequence was total:
 *   on this instance cycle 9 ("2026-Q3") was open and overdue and NOT ONE
 *   development plan had ever been generated from a campaign. The whole
 *   assess → gap → IDP loop terminated at the deadline and silently stopped.
 *
 * WHAT IT DOES — three steps, deliberately separated
 *   1. LOCK    an `open` cycle once closes_at has passed. This is exactly what
 *              the deadline means: no new self-assessments. It finalises nothing
 *              and destroys nothing; supervisors keep reviewing.
 *   2. FLAG    a RUNNING cycle that is past its deadline, EVERY WEEK, to the
 *              superadmins — not once and then silence.
 *   3. PROPOSE a closure once the cycle has been overdue for
 *              `cycleClosureProposalDays` days (21 by default). A PROPOSAL, not a
 *              closure: `cycle_closure_proposals` gets a row with the shortfall
 *              at that moment, and a superadmin accepts it (the honest close,
 *              which emits 'cycle.closed' → IDP drafts) or declines it with a
 *              written reason.
 *
 * ARBITRAGE A8 — « Clôture automatique après
 * échéance : proposition après 21 jours, JAMAIS automatique. » This job therefore
 * never closes a campaign. It used to: step 2 called closeWithDisposition as soon
 * as `cycleAutoCloseGraceDays` was positive. That path is gone. The old setting is
 * kept (nothing is deleted) and now only advances the PROPOSAL when
 * cycleClosureProposalDays is unset.
 *
 * SETTINGS (App Settings, no restart needed)
 *   cycleAutoLock              boolean, default true — step 1 on/off
 *   cycleClosureProposalDays   number,  default 21   — days overdue before a
 *                                                      closure is PROPOSED.
 *                                                      -1 = never propose.
 *   cycleAutoCloseGraceDays    OBSOLETE — no longer closes anything; read only as
 *                                        the fallback proposal delay.
 *
 * NEVER SILENT
 *   The lock and the closure proposal notify the superadmins once per cycle per
 *   transition through the shared reminder_log ledger — claim-before-send, and the
 *   claim is RELEASED when nothing was delivered (the A2 contract). The overdue
 *   FLAG is claimed per ISO week instead, because "still overdue" is news every
 *   week until somebody acts.
 *
 * The tick is idempotent: the UPDATEs are guarded on the current status and the
 * proposal has a unique partial index on (cycle_id) WHERE state = 'open', so a
 * second run in the same hour, a restart, or a second app instance is a no-op.
 */

const db = require('../config/database');
const { claim, release, weekBucket } = require('./reminders');

/** Superadmins — the people who own campaign governance. */
async function superadminIds() {
    try {
        const rows = await db.all(
            "SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true ORDER BY id"
        );
        return rows.map((r) => Number(r.id)).filter(Boolean);
    } catch (_) {
        return [];
    }
}

/**
 * One notification per superadmin per (cycle, transition), claim-before-send.
 * `period` carries the cycle id so the claim is one-shot for that campaign —
 * except the weekly overdue flag, which passes its own ISO-week period.
 */
async function announce(N, ledgerKind, notifyKind, cycle, payload, periodOverride) {
    const period = periodOverride || `cycle:${Number(cycle.id)}`;
    for (const adminId of await superadminIds()) {
        if (!(await claim(ledgerKind, 'admin', adminId, Number(cycle.id), period))) continue;
        let r = null;
        try {
            // Deliberately an EXISTING notification kind: a kind with no KIND_META
            // entry renders in the notification centre with its raw string as the
            // title. 'cycle.escalation' ("Revues à finaliser") is exactly what a
            // lock means — the employee window is shut, the reviews are what is
            // left; 'cycle.closed' is exactly what a close means.
            // Deep-link to THIS campaign's console.
            r = await N.notify({
                userType: 'admin',
                userId: adminId,
                kind: notifyKind,
                category: 'workflow',
                payload: {
                    link: `/cycles/${Number(cycle.id)}`,
                    cycleId: Number(cycle.id),
                    cycle: cycle.code,
                    ...payload,
                },
            });
        } catch (_) {
            r = null;
        }
        if (!r || r.inapp === 'error')
            await release(ledgerKind, 'admin', adminId, Number(cycle.id), period);
    }
}

async function tick() {
    const AppSettingsModel = require('../models/AppSettingsModel');
    const CycleService = require('../services/CycleService');
    const N = require('../services/NotificationService');

    let autoLock = true;
    try {
        autoLock = await AppSettingsModel.getValue('cycleAutoLock', true);
    } catch {
        /* default */
    }
    // the delay before a closure is PROPOSED. Never a delay before a closure.
    let proposalDays = CycleService.CLOSURE_PROPOSAL_DEFAULT_DAYS;
    try {
        proposalDays = Number(await CycleService.closureProposalDays());
    } catch {
        /* default */
    }
    if (!Number.isFinite(proposalDays)) proposalDays = CycleService.CLOSURE_PROPOSAL_DEFAULT_DAYS;

    // `closed` stays in the shape for the health page's history, and is now
    // always 0: A8 forbids this job from closing anything. It is not dead — it is
    // the assertion that the job closed nothing, readable in job_runs.result.
    const out = { locked: 0, closed: 0, overdueFlagged: 0, closureProposed: 0, idpDrafts: 0 };

    // ---- 1) overdue OPEN cycles → locked -----------------------------------
    if (autoLock !== false) {
        const overdue = await db.all(
            `SELECT id, code, label, to_char(closes_at, 'YYYY-MM-DD') AS closes_on
               FROM assessment_cycles
              WHERE status = 'open' AND closes_at IS NOT NULL AND closes_at < now()
              ORDER BY closes_at`
        );
        for (const c of overdue) {
            await CycleService.lock(Number(c.id));
            // Re-read: lock is guarded on status = 'open', so this is the proof
            // that THIS tick is the one that moved it (and not a concurrent run).
            const now = await db.get('SELECT status FROM assessment_cycles WHERE id = ?', [
                Number(c.id),
            ]);
            if (!now || now.status !== 'locked') continue;
            out.locked++;
            await announce(N, 'cycle.autolock', 'cycle.escalation', c, {
                stage: 'locked',
                closesOn: c.closesOn ?? c.closes_on,
            });
        }
    }

    // ---- 2/3) RUNNING cycles past their deadline: FLAG weekly, then PROPOSE ---
    //
    // never close. A campaign that sailed past its deadline used to be told
    // about exactly once, at the moment it locked, and then sat in silence — on
    // this instance campaign 9 was 13 days overdue with nothing scheduled at all.
    // Now the superadmins are reminded every week for as long as it stays late,
    // and after `proposalDays` a closure PROPOSAL is opened, which a human
    // accepts or declines with a reason.
    const overdue = await db.all(
        `SELECT id, code, label, status, to_char(closes_at, 'YYYY-MM-DD') AS closes_on,
                FLOOR(EXTRACT(EPOCH FROM (now() - closes_at)) / 86400.0)::int AS overdue_days
           FROM assessment_cycles
          WHERE status IN ('open', 'locked') AND closes_at IS NOT NULL AND closes_at < now()
          ORDER BY closes_at`
    );
    const week = weekBucket(new Date());
    for (const c of overdue) {
        const days = Number(c.overdueDays ?? c.overdue_days) || 0;
        const closesOn = c.closesOn ?? c.closes_on;

        let proposed = null;
        if (proposalDays >= 0 && days >= proposalDays) {
            try {
                proposed = await CycleService.proposeClosure(Number(c.id), { proposalDays });
            } catch (e) {
                console.error('[cycle-deadline] proposeClosure failed:', e.message);
            }
        }
        if (proposed && proposed.proposed) {
            out.closureProposed++;
            // One-shot per campaign: the proposal exists from now on, and the
            // weekly flag below keeps carrying it until somebody decides.
            await announce(N, 'cycle.closure_proposed', 'cycle.escalation', c, {
                stage: 'closure_proposed',
                closesOn,
                overdueDays: days,
                proposalDays,
                proposalId: proposed.proposalId,
                autoClosed: false,
            });
        }

        // The weekly "still overdue" flag, claimed per ISO WEEK so it repeats for
        // as long as the campaign is late (the lock announcement was one-shot).
        await announce(
            N,
            'cycle.overdue',
            'cycle.escalation',
            c,
            {
                stage: 'overdue',
                closesOn,
                overdueDays: days,
                proposalDays,
                proposalPending: proposalDays >= 0 && days >= proposalDays,
                autoClosed: false,
            },
            `cycle:${Number(c.id)}:${week}`
        );
        out.overdueFlagged++;
    }

    if (
        process.env.NODE_ENV !== 'test' &&
        (out.locked || out.closureProposed || out.overdueFlagged)
    ) {
        console.log(
            `[cycle-deadline] locked:${out.locked} overdueFlagged:${out.overdueFlagged} closureProposed:${out.closureProposed} closed:${out.closed}`
        );
    }
    return out;
}

module.exports = { tick };
