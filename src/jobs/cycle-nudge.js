'use strict';

/**
 * cycle-nudge — assessment-campaign reminders & escalations.
 *
 * Hourly tick over RUNNING assessment cycles:
 *
 *   Roster self-heal (every running cycle): enrol joiners (open only), excuse
 *   deactivated / erased subjects with a system category, put back whoever's
 *   time-boxed exclusion has expired (CycleService.reconcileParticipants).
 *
 *   OPEN cycles
 *     cycle.not_started : weekly roster nudge to everyone who never started,
 *                         from day one (reminder_log, per week)
 *     reminder_7 / 2    : unsubmitted rows ≤7 / ≤2 days before close (nudge_log)
 *     escalation_3      : reviews pending ≤3 days before close (nudge_log)
 *     escalation_overdue: reviews pending past close (nudge_log)
 *
 *   LOCKED cycles — the review phase, which used to be totally silent
 *     cycle.review_pending : weekly reminder to every reviewer still holding
 *                            submissions (reminder_log, per week)
 *
 *   Escalations go to whoever holds the review NOW: the reviewer explicitly
 *   assigned on the campaign console, else the live reporting line, else the
 *   launch-time snapshot (3.23.17 — see pendingReviewers).
 *
 * Exactly-once per (cycle, target, kind) via the nudge_log UNIQUE ledger —
 * the ON CONFLICT DO NOTHING insert is the claim; the notification only goes
 * out when the claim inserted a row, so a crash can't double-send and a
 * re-run can't re-nudge. Delivery via NotificationService (in-app always,
 * email rides on the master switch, category 'workflow').
 */

const db = require('../config/database');

/** Claim (cycle,target,kind) in the ledger. True when WE inserted it. */
async function claim(cycleId, targetType, targetId, kind) {
    const r = await db.get(
        `INSERT INTO nudge_log (cycle_id, target_type, target_id, kind)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (cycle_id, target_type, target_id, kind) DO NOTHING
         RETURNING id`,
        [cycleId, targetType, targetId, kind]
    );
    return !!r;
}

/**
 * Hand a claim back when the notification did not land.
 *
 * The ledger insert is the claim, and it happens BEFORE the send so a crash cannot
 * double-notify. But `notify` returns `inapp:'error'` without throwing, and the
 * claim was kept regardless — so one failed delivery meant that reminder was never
 * sent and never retried, while the job counted it. Releasing turns a permanent
 * loss back into a retry on the next tick; the duplicate-protection is unaffected,
 * because a claim is only released when nothing was delivered.
 */
async function release(cycleId, targetType, targetId, kind) {
    try {
        await db.run(
            'DELETE FROM nudge_log WHERE cycle_id = ? AND target_type = ? AND target_id = ? AND kind = ?',
            [cycleId, targetType, targetId, kind]
        );
    } catch (e) {
        console.error('[cycle-nudge] could not release the claim', kind, targetId, e && e.message);
    }
}

/**
 * Reviewers holding submissions for a cycle — whoever HOLDS the review NOW
 * (3.23.17, F2): an explicit assignment made on the campaign console, else the
 * LIVE reporting line, else the launch-time snapshot as a last resort. The
 * snapshot used to come first, so after a manager change mid-campaign the
 * reminders kept going to the previous reviewer. One rule, shared with the
 * manual chase: CycleService.REVIEWER_TARGET_LATERAL.
 * Rows: { targetType: 'employee'|'admin', targetId, firstName, n }.
 */
async function pendingReviewers(cycleId) {
    const { REVIEWER_TARGET_LATERAL } = require('../services/CycleService');
    return db.all(
        `SELECT m.target_type AS "targetType", m.target_id AS "targetId",
                COALESCE(mgr.first_name, adm.username) AS "firstName", COUNT(*)::int AS n
           FROM (
                SELECT sa.id, rv.target_type, rv.target_id
                  FROM self_assessments sa
                  JOIN employees e ON e.id = sa.employee_id AND e.is_active AND e.erased_at IS NULL
                  LEFT JOIN cycle_participants p ON p.cycle_id = sa.cycle_id AND p.employee_id = sa.employee_id
                  ${REVIEWER_TARGET_LATERAL}
                 WHERE sa.cycle_id = ? AND sa.workflow_state IN ('submitted', 'under_review')
                   AND (p.employee_id IS NULL OR p.excluded_at IS NULL)
           ) m
           LEFT JOIN employees mgr ON mgr.id = m.target_id AND m.target_type = 'employee' AND mgr.is_active
           LEFT JOIN admins adm ON adm.id = m.target_id AND m.target_type = 'admin' AND COALESCE(adm.is_active, true)
          WHERE m.target_id IS NOT NULL AND (mgr.id IS NOT NULL OR adm.id IS NOT NULL)
          GROUP BY m.target_type, m.target_id, mgr.first_name, adm.username`,
        [cycleId]
    );
}

async function tick() {
    const NotificationService = require('../services/NotificationService');
    const esc = (s) =>
        String(s == null ? '' : s).replace(
            /[&<>]/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]
        );

    // EVERY running cycle — open (people submit) and locked (reviewers finish).
    // Not only those inside the 7-day deadline horizon: a campaign opened six
    // weeks out used to stay silent for five weeks and then make FIRST contact
    // with a deadline warning. The deadline stages below still only fire inside
    // their own windows; the roster-driven "you have not started" nudge runs
    // from day one, and the review backlog is chased through the locked phase.
    const cycles = await db.all(
        `SELECT id, code, label, status, closes_at AS "closesAt",
                EXTRACT(EPOCH FROM (closes_at - now())) / 86400.0 AS "daysLeft"
           FROM assessment_cycles
          WHERE status IN ('open', 'locked')`
    );
    if (!cycles.length)
        return {
            cycles: 0,
            reminders: 0,
            escalations: 0,
            notStarted: 0,
            reviewPending: 0,
            reincluded: 0,
        };

    let reminders = 0,
        escalations = 0,
        notStarted = 0,
        reviewPending = 0,
        reincluded = 0;

    // Weekly cadence bucket for the recurring nudges. The 4 deadline stages
    // stay on nudge_log (one-shot by design: its UNIQUE has no period column and a
    // CHECK pins the kind list); anything recurring goes on reminder_log, whose
    // UNIQUE includes `period` — the same claim-before-send guarantee, per week.
    const _wk = (d) => {
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const day = (t.getUTCDay() + 6) % 7; // Monday = 0
        t.setUTCDate(t.getUTCDate() - day);
        return t.toISOString().slice(0, 10);
    };
    const week = _wk(new Date());
    const claimWeekly = async (kind, targetType, targetId, refId) => {
        const r = await db.get(
            `INSERT INTO reminder_log (kind, target_type, target_id, ref_id, period)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (kind, target_type, target_id, ref_id, period) DO NOTHING
             RETURNING id`,
            [kind, targetType, Number(targetId), Number(refId) || 0, week]
        );
        return !!r;
    };
    const releaseWeekly = async (kind, targetType, targetId, refId) => {
        try {
            await db.run(
                `DELETE FROM reminder_log
                  WHERE kind = ? AND target_type = ? AND target_id = ? AND ref_id = ? AND period = ?`,
                [kind, targetType, Number(targetId), Number(refId) || 0, week]
            );
        } catch (e) {
            console.error(
                '[cycle-nudge] could not release the weekly claim',
                kind,
                targetId,
                e && e.message
            );
        }
    };

    for (const cycle of cycles) {
        // Self-heal the roster before chasing anyone: joiners (open cycles),
        // deactivated / erased subjects excused with a system category (open AND
        // locked, so a close never counts a ghost as "jamais démarré"), and the
        // time-boxed exclusions that have expired put back.
        try {
            const r = await require('../services/CycleService').reconcileParticipants(cycle.id);
            reincluded += (r && r.reincluded) || 0;
        } catch (e) {
            console.error(
                '[cycle-nudge] roster reconcile failed for cycle',
                cycle.id,
                e && e.message
            );
        }

        const daysLeft = Number(cycle.daysLeft);
        // The driver returns closes_at as a Date; String(date).slice(0, 10) would
        // put "Sat Oct 31" into a French notification payload.
        const closesOn =
            cycle.closesAt instanceof Date
                ? cycle.closesAt.toISOString().slice(0, 10)
                : String(cycle.closesAt || '').slice(0, 10);

        // ---- LOCKED: the review phase. Reviewers holding submissions are reminded
        // weekly (claim-before-send per week) until the campaign is closed.
        if (cycle.status === 'locked') {
            try {
                for (const r of await pendingReviewers(cycle.id)) {
                    if (
                        !(await claimWeekly(
                            'cycle.review_pending',
                            r.targetType,
                            r.targetId,
                            cycle.id
                        ))
                    )
                        continue;
                    const res = await NotificationService.notify({
                        userType: r.targetType,
                        userId: Number(r.targetId),
                        kind: 'cycle.escalation',
                        category: 'workflow',
                        payload: {
                            cycleId: cycle.id,
                            cycle: cycle.code,
                            closesOn,
                            pending: r.n,
                            stage: 'review_pending',
                            link: `/supervisor/self-assessment-reviews?cycleId=${cycle.id}`,
                        },
                        subject: `[IDevelop] Revues à finaliser — campagne ${cycle.code} verrouillée / Reviews to finalise`,
                        html:
                            `<p>Bonjour ${esc(r.firstName)},</p>` +
                            `<p>La campagne <strong>${esc(cycle.label)}</strong> est verrouillée depuis le <strong>${closesOn}</strong> : ` +
                            `<strong>${r.n}</strong> revue(s) d'auto-évaluation de votre équipe restent à finaliser. ` +
                            `<span style="color:#888;">/ The campaign is locked since ${closesOn}; ${r.n} team review(s) are still to be finalised.</span></p>`,
                        text: `Cycle ${cycle.code} locked since ${closesOn} — ${r.n} review(s) still pending.`,
                    });
                    if (!res || res.inapp === 'error') {
                        await releaseWeekly(
                            'cycle.review_pending',
                            r.targetType,
                            r.targetId,
                            cycle.id
                        );
                        continue;
                    }
                    reviewPending++;
                }
            } catch (e) {
                console.error('[cycle-nudge] review-pending pass failed:', e.message);
            }
            continue;
        }

        // ---- NON-STARTERS: the audience every other query structurally missed ----
        // Every existing assessment nudge selects from self_assessments, so somebody
        // who never opened the page has NO row and is unreachable by the very
        // reminder whose job is to make them open it. The participant roster is
        // stamped at launch from the employee population, so it CAN address them.
        // Weekly cadence, claim-before-send, from day one of the campaign.
        try {
            const nonStarters = await db.all(
                `SELECT p.employee_id AS "employeeId", e.first_name AS "firstName", p.expected_skills AS "expected"
                   FROM cycle_participants p
                   JOIN employees e ON e.id = p.employee_id AND e.is_active AND e.erased_at IS NULL
                  WHERE p.cycle_id = ? AND p.excluded_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM self_assessments sa
                                     WHERE sa.cycle_id = p.cycle_id AND sa.employee_id = p.employee_id
                                       AND sa.self_rated_level IS NOT NULL)`,
                [cycle.id]
            );
            for (const emp of nonStarters) {
                if (!(await claimWeekly('cycle.not_started', 'employee', emp.employeeId, cycle.id)))
                    continue;
                const r = await NotificationService.notify({
                    userType: 'employee',
                    userId: emp.employeeId,
                    kind: 'cycle.reminder',
                    category: 'workflow',
                    payload: {
                        cycleId: cycle.id,
                        cycle: cycle.code,
                        closesOn,
                        expected: emp.expected,
                        stage: 'not_started',
                        link: '/employee/self-assessment',
                    },
                });
                // Only count what actually went out, and give the week back if it did not.
                if (!r || r.inapp === 'error') {
                    await releaseWeekly('cycle.not_started', 'employee', emp.employeeId, cycle.id);
                    continue;
                }
                notStarted++;
            }
        } catch (e) {
            console.error('[cycle-nudge] non-starter pass failed:', e.message);
        }

        // The remaining stages are DEADLINE-driven and keep their original windows.
        if (daysLeft > 7) continue;

        // ---- Employee reminders: unsubmitted self-assessments ----
        const reminderKind = daysLeft <= 2 ? 'reminder_2' : 'reminder_7';
        const pendingEmployees = await db.all(
            `SELECT sa.employee_id AS "employeeId", e.first_name AS "firstName", COUNT(*)::int AS n
               FROM self_assessments sa
               JOIN employees e ON e.id = sa.employee_id AND e.is_active AND e.erased_at IS NULL
              WHERE sa.cycle_id = ? AND sa.workflow_state IN ('draft', 'changes_requested')
              GROUP BY sa.employee_id, e.first_name`,
            [cycle.id]
        );
        for (const emp of pendingEmployees) {
            try {
                if (!(await claim(cycle.id, 'employee', emp.employeeId, reminderKind))) continue;
                const r = await NotificationService.notify({
                    userType: 'employee',
                    userId: emp.employeeId,
                    kind: 'cycle.reminder',
                    category: 'workflow',
                    payload: {
                        cycleId: cycle.id,
                        cycle: cycle.code,
                        closesOn,
                        pending: emp.n,
                        stage: reminderKind,
                    },
                    subject: `[IDevelop] Auto-évaluation à soumettre avant le ${closesOn} / Self-assessment due by ${closesOn}`,
                    html:
                        `<p>Bonjour ${esc(emp.firstName)},</p>` +
                        `<p>La campagne <strong>${esc(cycle.label)}</strong> ferme le <strong>${closesOn}</strong> — ` +
                        `il vous reste <strong>${emp.n}</strong> auto-évaluation(s) à soumettre. ` +
                        `<span style="color:#888;">/ The campaign closes on ${closesOn}; you still have ${emp.n} self-assessment(s) to submit.</span></p>`,
                    text: `Cycle ${cycle.code} closes ${closesOn} — ${emp.n} self-assessment(s) still unsubmitted.`,
                });
                // A claimed-but-undelivered reminder must go back on the queue: this
                // stage is one-shot, so keeping the claim loses it for good.
                if (!r || r.inapp === 'error') {
                    await release(cycle.id, 'employee', emp.employeeId, reminderKind);
                    continue;
                }
                reminders++;
            } catch (e) {
                console.error(
                    `[cycle-nudge] reminder to employee ${emp.employeeId} failed:`,
                    e.message
                );
            }
        }

        // ---- Manager escalations: reviews still pending (snapshotted reviewer first) ----
        if (daysLeft <= 3) {
            const escalationKind = daysLeft < 0 ? 'escalation_overdue' : 'escalation_3';
            // nudge_log's CHECK only knows 'employee' | 'manager' targets: an admin
            // reviewer is escalated through the weekly reminder_log ledger instead.
            for (const mgr of await pendingReviewers(cycle.id)) {
                try {
                    const overdue = escalationKind === 'escalation_overdue';
                    const claimed =
                        mgr.targetType === 'admin'
                            ? await claimWeekly(
                                  `cycle.${escalationKind}`,
                                  'admin',
                                  mgr.targetId,
                                  cycle.id
                              )
                            : await claim(cycle.id, 'manager', mgr.targetId, escalationKind);
                    if (!claimed) continue;
                    const r = await NotificationService.notify({
                        userType: mgr.targetType,
                        userId: Number(mgr.targetId),
                        kind: 'cycle.escalation',
                        category: 'workflow',
                        payload: {
                            cycleId: cycle.id,
                            cycle: cycle.code,
                            closesOn,
                            pending: mgr.n,
                            stage: escalationKind,
                            link: `/supervisor/self-assessment-reviews?cycleId=${cycle.id}`,
                        },
                        subject: overdue
                            ? `[IDevelop] URGENT — revues en retard (campagne fermée le ${closesOn}) / OVERDUE reviews`
                            : `[IDevelop] Revues à finaliser avant le ${closesOn} / Reviews due by ${closesOn}`,
                        html:
                            `<p>Bonjour ${esc(mgr.firstName)},</p>` +
                            `<p><strong>${mgr.n}</strong> revue(s) d'auto-évaluation de votre équipe ${
                                overdue
                                    ? `sont <strong>en retard</strong> — la campagne <strong>${esc(cycle.label)}</strong> a fermé le ${closesOn}`
                                    : `doivent être finalisées avant le <strong>${closesOn}</strong> (campagne <strong>${esc(cycle.label)}</strong>)`
                            }. ` +
                            `<span style="color:#888;">/ ${mgr.n} team review(s) ${overdue ? 'are OVERDUE — the campaign closed on ' + closesOn : 'must be completed by ' + closesOn}.</span></p>`,
                        text: `Cycle ${cycle.code}: ${mgr.n} review(s) ${overdue ? 'OVERDUE (closed ' + closesOn + ')' : 'due by ' + closesOn}.`,
                    });
                    if (!r || r.inapp === 'error') {
                        if (mgr.targetType === 'admin')
                            await releaseWeekly(
                                `cycle.${escalationKind}`,
                                'admin',
                                mgr.targetId,
                                cycle.id
                            );
                        else await release(cycle.id, 'manager', mgr.targetId, escalationKind);
                        continue;
                    }
                    escalations++;
                } catch (e) {
                    console.error(
                        `[cycle-nudge] escalation to reviewer ${mgr.targetId} failed:`,
                        e.message
                    );
                }
            }
        }
    }
    return { cycles: cycles.length, reminders, escalations, notStarted, reviewPending, reincluded };
}

module.exports = { tick, pendingReviewers };
