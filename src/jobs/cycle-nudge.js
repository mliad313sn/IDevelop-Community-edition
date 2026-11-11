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
 *   OPEN cycles — the PERSON's ladder, at most 4 mails per campaign:
 *     launch            : cycle.opened, sent by CycleService (not here)
 *     D+3               : « not started yet », only to those who have not
 *                         started (reminder_log, once): it stops on start
 *     D-7, D-2          : deadline reminders to everyone not yet SUBMITTED
 *                         (nudge_log), with the deadline .ics
 *     A campaign shorter than 10 days gets launch + D-2 only. The former
 *     cadence (a weekly « not started » mail from day one, then D-7 and D-2:
 *     about 8 mails on a six-week campaign) is gone; the mails it already sent
 *     count towards the ceiling.
 *     escalation_3      : reviews pending ≤3 days before close (nudge_log)
 *     escalation_overdue: reviews pending past close (nudge_log)
 *
 *     D-7 (line)        : the effective reviewer of the people who have NOT
 *                         STARTED learns how many they are (cycle.team_reminder,
 *                         once per reviewer and campaign, reminder_log): one
 *                         count, never a name. It goes to the line, so it counts
 *                         against nobody's four-mail ceiling.
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
 * email rides on the master switch, category 'workflow'), each mail written in
 * the recipient's language (`content`), counts and dates only, a deep link in
 * every mail. `tick({ now })` takes an injectable clock (tests replay a whole
 * campaign).
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

const DAY = 86400000;
/** Below this many days from launch to close, the ladder is launch + D-2 only. */
const SHORT_CAMPAIGN_DAYS = 10;
/** Ceiling per person per campaign, the launch announcement included. */
const MAX_PER_PERSON = 4;
/** reminder_log kind and period of the D+3 « not started » mail. */
const LADDER_KIND = 'cycle.not_started';
const D3_PERIOD = 'd+3';
/** reminder_log kind and period of the D-7 line message (one per reviewer and campaign). */
const TEAM_KIND = 'cycle.team_d7';
const TEAM_PERIOD = 'd-7';

/**
 * Which step of the person's ladder is due now, or null:
 *   D+3 : 3 days after launch, while more than 7 days remain (long campaigns)
 *   D-7 : 7 to 2 days before close (long campaigns)
 *   D-2 : the last 2 days (and once past the deadline while still open)
 * A step whose window has passed is skipped, never sent late on top of the next.
 */
function ladderStage({ sinceOpenDays, daysLeft, durationDays }) {
    const short = Number.isFinite(durationDays) && durationDays < SHORT_CAMPAIGN_DAYS;
    if (daysLeft <= 2) return 'reminder_2';
    if (short) return null;
    if (daysLeft <= 7) return 'reminder_7';
    if (sinceOpenDays >= 3) return 'd+3';
    return null;
}

/**
 * The person's own mail for a ladder step, written for any language (B =
 * emailTemplate.blocks(lang) in the recipient's language). The campaign, its
 * date and the count are in the body; the subject is the catalogue's.
 * `done` (the skills the person already rated) says where they stand on D-7
 * and D-2; every step says why the assessment matters.
 */
function ladderMail(cycle, stage, closesOn, expected, done) {
    const { fmtDate } = require('../utils/dateFormat');
    const date = closesOn ? fmtDate(closesOn) : null;
    const name = cycle.label || cycle.code;
    const n = Number(expected);
    const d = Number(done);
    const started = Number.isFinite(d) && d > 0;
    return (B) => {
        const fmt = (v) => require('../utils/emailTemplate').fmtNum(v, 0, B.lang);
        const rows = [[B.pick('Campagne', 'Campaign'), name]];
        if (date) rows.push([B.pick('À faire avant le', 'To do by'), date]);
        if (Number.isFinite(n) && n > 0)
            rows.push([
                B.pick('Compétences à évaluer', 'Skills to assess'),
                require('../utils/emailTemplate').fmtNum(n, 0, B.lang),
            ]);
        let intro;
        if (stage === 'd+3')
            intro = B.pick(
                `La campagne ${name} est ouverte et votre auto-évaluation n’est pas encore commencée.`,
                `The ${name} campaign is open and your self-assessment has not been started yet.`
            );
        else if (stage === 'reminder_7')
            intro = B.pick(
                `Il reste une semaine pour soumettre votre auto-évaluation de la campagne ${name}.`,
                `One week is left to submit your self-assessment for the ${name} campaign.`
            );
        else
            intro = B.pick(
                `Dernier rappel : votre auto-évaluation de la campagne ${name} n’est pas encore soumise.`,
                `Last reminder: your self-assessment for the ${name} campaign has not been submitted yet.`
            );
        const blocks = [{ type: 'kv', rows }];
        if (stage !== 'd+3' && started && Number.isFinite(n) && n > 0) {
            const k = Math.min(d, n);
            blocks.push(
                B.para(
                    `Vous avez déjà évalué ${fmt(k)} ${k > 1 ? 'compétences' : 'compétence'} sur ${fmt(n)}.`,
                    `You have already rated ${fmt(k)} of ${fmt(n)} ${n > 1 ? 'skills' : 'skill'}.`
                )
            );
        }
        blocks.push(
            B.para(
                'Votre auto-évaluation sert de base à l’échange avec votre responsable et à votre plan de développement.',
                'Your self-assessment is the starting point of the conversation with your manager and of your development plan.'
            )
        );
        return {
            intro,
            blocks: [
                ...blocks,
                B.notice(
                    stage === 'd+3'
                        ? 'Vous pouvez la faire en plusieurs fois. Dès qu’elle est commencée, ce rappel s’arrête.'
                        : 'Vous pouvez la faire en plusieurs fois. Dès qu’elle est soumise, ces rappels s’arrêtent.',
                    stage === 'd+3'
                        ? 'You can do it in several sittings. As soon as it is started, this reminder stops.'
                        : 'You can do it in several sittings. As soon as it is submitted, these reminders stop.',
                    stage === 'reminder_2' ? 'warning' : 'info'
                ),
            ],
            ctaLabel:
                stage === 'd+3' || !started
                    ? B.pick('Commencer mon auto-évaluation', 'Start my self-assessment')
                    : B.pick('Ouvrir mon auto-évaluation', 'Open my self-assessment'),
            ctaUrl: '/employee/self-assessment',
            preheader: date ? B.pick(`À faire avant le ${date}`, `To do by ${date}`) : undefined,
        };
    };
}

/** A reviewer's mail — counts only, no names; for any language. */
function reviewerMail(cycle, { stage, pending, closesOn }) {
    const { fmtDate } = require('../utils/dateFormat');
    const date = closesOn ? fmtDate(closesOn) : '—';
    const name = cycle.label || cycle.code;
    const n = Number(pending) || 0;
    return (B) => {
        const N = require('../utils/emailTemplate').fmtNum(n, 0, B.lang);
        let intro;
        if (stage === 'review_pending')
            intro = B.pick(
                `La campagne ${name} est verrouillée depuis le ${date} : ${N} ${n > 1 ? 'revues de votre équipe restent' : 'revue de votre équipe reste'} à finaliser.`,
                `The ${name} campaign has been locked since ${date}: ${N} ${n > 1 ? 'team reviews are' : 'team review is'} still to be finalised.`
            );
        else if (stage === 'escalation_overdue')
            intro = B.pick(
                `${N} ${n > 1 ? 'revues de votre équipe sont' : 'revue de votre équipe est'} en retard : la campagne ${name} a fermé le ${date}.`,
                `${N} team ${n > 1 ? 'reviews are' : 'review is'} overdue: the ${name} campaign closed on ${date}.`
            );
        else
            intro = B.pick(
                `${N} ${n > 1 ? 'revues de votre équipe sont' : 'revue de votre équipe est'} à finaliser avant le ${date} (campagne ${name}).`,
                `${N} team ${n > 1 ? 'reviews' : 'review'} to finalise by ${date} (${name} campaign).`
            );
        return {
            intro,
            blocks: [
                {
                    type: 'kv',
                    rows: [
                        [B.pick('Campagne', 'Campaign'), name],
                        [B.pick('Revues à finaliser', 'Reviews to finalise'), N],
                        [
                            stage === 'escalation_3'
                                ? B.pick('Échéance', 'Deadline')
                                : B.pick('Fermée le', 'Closed on'),
                            date,
                        ],
                    ],
                },
                B.notice(
                    'Validez ou renvoyez chaque auto-évaluation soumise depuis la liste des revues.',
                    'Approve or send back each submitted self-assessment from the review list.',
                    stage === 'escalation_overdue' ? 'warning' : 'info'
                ),
            ],
            ctaLabel: B.pick('Ouvrir les revues', 'Open the reviews'),
        };
    };
}

/**
 * The D-7 line message: ONE count of the people of the reviewer's line who
 * have not started, never a name; for any language.
 */
function teamMail(cycle, count, closesOn) {
    const { fmtDate } = require('../utils/dateFormat');
    const date = closesOn ? fmtDate(closesOn) : null;
    const name = cycle.label || cycle.code;
    const k = Number(count) || 0;
    return (B) => {
        const N = require('../utils/emailTemplate').fmtNum(k, 0, B.lang);
        const rows = [
            [B.pick('Campagne', 'Campaign'), name],
            [B.pick('Pas encore commencé', 'Not started yet'), N],
        ];
        if (date) rows.push([B.pick('Clôture le', 'Closes on'), date]);
        return {
            intro: B.pick(
                `${N} ${k > 1 ? 'personnes de votre équipe n’ont' : 'personne de votre équipe n’a'} pas encore commencé ${k > 1 ? 'leur' : 'son'} auto-évaluation de la campagne ${name}.`,
                `${N} ${k > 1 ? 'people in your team have' : 'person in your team has'} not started the self-assessment of the ${name} campaign yet.`
            ),
            blocks: [
                { type: 'kv', rows },
                B.notice(
                    'L’auto-évaluation sert de base à leur plan de développement : un mot de votre part aide souvent. Ce message ne nomme personne ; la liste est dans l’application.',
                    'The self-assessment is the basis of their development plan: a word from you often helps. This message names nobody; the list is in the app.',
                    'info'
                ),
            ],
            ctaLabel: B.pick('Ouvrir le tableau de bord', 'Open the dashboard'),
        };
    };
}

/**
 * D-7: count the participants of an OPEN campaign who have not started (the
 * D+3 predicate: no started_at, no rated row, not submitted, not excluded,
 * active) and tell each of their effective reviewers ONE count. Claimed once
 * per (reviewer, campaign) in reminder_log; a claim that did not land is
 * handed back.
 */
async function remindLines(cycle, closesOn, NotificationService, { claimPeriod, releasePeriod }) {
    const rows = await db.all(
        `SELECT p.employee_id AS "employeeId"
           FROM cycle_participants p
           JOIN employees e ON e.id = p.employee_id AND e.is_active AND e.erased_at IS NULL
          WHERE p.cycle_id = ? AND p.excluded_at IS NULL AND p.submitted_at IS NULL
            AND p.started_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM self_assessments sa
                             WHERE sa.cycle_id = p.cycle_id AND sa.employee_id = p.employee_id
                               AND (sa.self_rated_level IS NOT NULL
                                    OR sa.workflow_state NOT IN ('draft', 'changes_requested')))`,
        [cycle.id]
    );
    const ids = (rows || []).map((r) => Number(r.employeeId)).filter((x) => x > 0);
    if (!ids.length) return 0;
    const lines = await require('../services/ReportingLineService').lineRecipientsMany(ids, {
        includeManager: false,
    });
    const per = new Map();
    for (const id of ids) {
        for (const r of lines.get(id) || []) {
            if (r.userType !== 'employee' && r.userType !== 'admin') continue;
            const key = `${r.userType}:${Number(r.id)}`;
            const cur = per.get(key) || { userType: r.userType, id: Number(r.id), n: 0 };
            cur.n++;
            per.set(key, cur);
        }
    }
    let sent = 0;
    for (const r of per.values()) {
        try {
            if (!(await claimPeriod(TEAM_KIND, r.userType, r.id, cycle.id, TEAM_PERIOD))) continue;
            const res = await NotificationService.notify({
                userType: r.userType,
                userId: r.id,
                kind: 'cycle.team_reminder',
                category: 'workflow',
                payload: {
                    cycleId: cycle.id,
                    cycle: cycle.code,
                    closesOn,
                    count: r.n,
                    link: '/dashboard',
                },
                content: teamMail(cycle, r.n, closesOn),
                ctaUrl: '/dashboard',
            });
            if (!res || res.inapp === 'error') {
                await releasePeriod(TEAM_KIND, r.userType, r.id, cycle.id, TEAM_PERIOD);
                continue;
            }
            sent++;
        } catch (e) {
            console.error(
                `[cycle-nudge] team reminder to ${r.userType} ${Number(r.id)} failed:`,
                e && e.message
            );
        }
    }
    return sent;
}

async function tick({ now: nowArg } = {}) {
    const NotificationService = require('../services/NotificationService');
    const { sqlDateIso, appDayIso } = require('../utils/dateFormat');
    const now = nowArg instanceof Date ? nowArg : new Date();

    // EVERY running cycle — open (people submit) and locked (reviewers finish).
    const cycles = await db.all(
        `SELECT id, code, label, status, closes_at AS "closesAt",
                COALESCE(opened_at, created_at) AS "openedAt"
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
            teamReminders: 0,
        };

    let teamReminders = 0;
    let reminders = 0,
        escalations = 0,
        notStarted = 0,
        reviewPending = 0,
        reincluded = 0;

    // Weekly bucket for the reviewer reminders of a LOCKED campaign and for the
    // admin-reviewer escalations (nudge_log's CHECK only knows employee|manager).
    // reminder_log's UNIQUE includes `period`: the same claim-before-send
    // guarantee, per week (or once, for the D+3 step).
    const _wk = (d) => {
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const day = (t.getUTCDay() + 6) % 7; // Monday = 0
        t.setUTCDate(t.getUTCDate() - day);
        return t.toISOString().slice(0, 10);
    };
    const week = _wk(now);
    const claimPeriod = async (kind, targetType, targetId, refId, period) => {
        const r = await db.get(
            `INSERT INTO reminder_log (kind, target_type, target_id, ref_id, period)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (kind, target_type, target_id, ref_id, period) DO NOTHING
             RETURNING id`,
            [kind, targetType, Number(targetId), Number(refId) || 0, period]
        );
        return !!r;
    };
    const releasePeriod = async (kind, targetType, targetId, refId, period) => {
        try {
            await db.run(
                `DELETE FROM reminder_log
                  WHERE kind = ? AND target_type = ? AND target_id = ? AND ref_id = ? AND period = ?`,
                [kind, targetType, Number(targetId), Number(refId) || 0, period]
            );
        } catch (e) {
            console.error(
                '[cycle-nudge] could not release the claim',
                kind,
                targetId,
                e && e.message
            );
        }
    };
    const claimWeekly = (kind, t, id, ref) => claimPeriod(kind, t, id, ref, week);
    const releaseWeekly = (kind, t, id, ref) => releasePeriod(kind, t, id, ref, week);

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

        const closesAt = cycle.closesAt ? new Date(cycle.closesAt) : null;
        const openedAt = cycle.openedAt ? new Date(cycle.openedAt) : null;
        const daysLeft = closesAt ? (closesAt - now) / DAY : Infinity;
        const sinceOpenDays = openedAt ? (now - openedAt) / DAY : 0;
        const durationDays = closesAt && openedAt ? (closesAt - openedAt) / DAY : NaN;
        // A calendar day in the app's zone ('YYYY-MM-DD'), never a Date in a
        // payload and never a UTC-shifted ISO day.
        const closesOn = closesAt ? appDayIso(closesAt) || sqlDateIso(closesAt) : null;
        const reviewsLink = `/supervisor/self-assessment-reviews?cycleId=${cycle.id}`;

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
                            link: reviewsLink,
                        },
                        content: reviewerMail(cycle, {
                            stage: 'review_pending',
                            pending: r.n,
                            closesOn,
                        }),
                        ctaUrl: reviewsLink,
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

        // ---- The person's ladder: D+3, D-7, D-2, at most 4 mails per campaign ----
        // The roster is stamped at launch, so somebody who never opened the page
        // is addressable. D+3 goes to NON-STARTERS only (« started » = the roster
        // stamped started_at, or a rated row): it stops on start. D-7 and D-2 are
        // deadline reminders and go to everyone NOT YET SUBMITTED (« submitted »
        // = the roster stamped submitted_at, or a row past draft /
        // changes_requested): a person who started but did not submit still gets
        // them, and nothing once submitted. The ceiling counts the launch
        // announcement as one mail, and every ladder mail already sent for this
        // campaign — the weekly « not started » mails of the former cadence
        // included — so an upgrade in the middle of a campaign never exceeds 4.
        const stage = ladderStage({ sinceOpenDays, daysLeft, durationDays });
        if (stage) {
            try {
                const candidates = await db.all(
                    `SELECT p.employee_id AS "employeeId", p.expected_skills AS "expected",
                            (SELECT COUNT(DISTINCT sa.skill_id) FROM self_assessments sa
                              WHERE sa.cycle_id = p.cycle_id AND sa.employee_id = p.employee_id
                                AND sa.self_rated_level IS NOT NULL)::int AS "done",
                            ((SELECT COUNT(*) FROM reminder_log rl
                               WHERE rl.kind = ? AND rl.target_type = 'employee'
                                 AND rl.target_id = p.employee_id AND rl.ref_id = p.cycle_id)
                           + (SELECT COUNT(*) FROM nudge_log nl
                               WHERE nl.cycle_id = p.cycle_id AND nl.target_type = 'employee'
                                 AND nl.target_id = p.employee_id
                                 AND nl.kind IN ('reminder_7', 'reminder_2')))::int AS "sent"
                       FROM cycle_participants p
                       JOIN employees e ON e.id = p.employee_id AND e.is_active AND e.erased_at IS NULL
                      WHERE p.cycle_id = ? AND p.excluded_at IS NULL AND p.submitted_at IS NULL
                        AND NOT EXISTS (SELECT 1 FROM self_assessments sa
                                         WHERE sa.cycle_id = p.cycle_id AND sa.employee_id = p.employee_id
                                           AND sa.workflow_state NOT IN ('draft', 'changes_requested'))
                        ${
                            stage === 'd+3'
                                ? `AND p.started_at IS NULL
                        AND NOT EXISTS (SELECT 1 FROM self_assessments sa
                                         WHERE sa.cycle_id = p.cycle_id AND sa.employee_id = p.employee_id
                                           AND sa.self_rated_level IS NOT NULL)`
                                : ''
                        }`,
                    [LADDER_KIND, cycle.id]
                );
                for (const emp of candidates) {
                    try {
                        if (1 + Number(emp.sent || 0) >= MAX_PER_PERSON) continue;
                        const claimed =
                            stage === 'd+3'
                                ? await claimPeriod(
                                      LADDER_KIND,
                                      'employee',
                                      emp.employeeId,
                                      cycle.id,
                                      D3_PERIOD
                                  )
                                : await claim(cycle.id, 'employee', emp.employeeId, stage);
                        if (!claimed) continue;
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
                                stage: stage === 'd+3' ? 'not_started' : stage,
                                link: '/employee/self-assessment',
                            },
                            content: ladderMail(cycle, stage, closesOn, emp.expected, emp.done),
                            // D-7 and D-2 carry the deadline .ics, with the uid of the
                            // launch summary's: a calendar updates ONE event.
                            calendar:
                                closesOn && (stage === 'reminder_7' || stage === 'reminder_2')
                                    ? {
                                          type: 'campaign_deadline',
                                          date: closesOn,
                                          uid: `cycle-${cycle.id}-deadline`,
                                      }
                                    : undefined,
                        });
                        // A claimed-but-undelivered reminder goes back on the queue:
                        // each step is one-shot, so keeping the claim would lose it.
                        if (!r || r.inapp === 'error') {
                            if (stage === 'd+3')
                                await releasePeriod(
                                    LADDER_KIND,
                                    'employee',
                                    emp.employeeId,
                                    cycle.id,
                                    D3_PERIOD
                                );
                            else await release(cycle.id, 'employee', emp.employeeId, stage);
                            continue;
                        }
                        if (stage === 'd+3') notStarted++;
                        else reminders++;
                    } catch (e) {
                        console.error(
                            `[cycle-nudge] reminder to employee ${emp.employeeId} failed:`,
                            e.message
                        );
                    }
                }
            } catch (e) {
                console.error('[cycle-nudge] ladder pass failed:', e.message);
            }
        }

        // ---- D-7: the LINE learns how many of its people have not started (a
        // count, never a name), once per reviewer and campaign. It counts against
        // nobody's ceiling: the person's own ladder is untouched.
        if (stage === 'reminder_7') {
            try {
                teamReminders += await remindLines(cycle, closesOn, NotificationService, {
                    claimPeriod,
                    releasePeriod,
                });
            } catch (e) {
                console.error('[cycle-nudge] team reminder pass failed:', e && e.message);
            }
        }

        // ---- Reviewer escalations: reviews still pending ----
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
                            link: reviewsLink,
                        },
                        severity: overdue ? 'echeance' : 'action',
                        content: reviewerMail(cycle, {
                            stage: escalationKind,
                            pending: mgr.n,
                            closesOn,
                        }),
                        ctaUrl: reviewsLink,
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
    return {
        cycles: cycles.length,
        reminders,
        escalations,
        notStarted,
        reviewPending,
        reincluded,
        teamReminders,
    };
}

module.exports = {
    tick,
    pendingReviewers,
    __test: {
        ladderStage,
        ladderMail,
        reviewerMail,
        teamMail,
        remindLines,
        SHORT_CAMPAIGN_DAYS,
        MAX_PER_PERSON,
        TEAM_KIND,
    },
};
