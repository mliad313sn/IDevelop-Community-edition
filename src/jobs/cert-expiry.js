'use strict';

/**
 * cert-expiry — certification/VOC expiry alerts + LMS refresher auto-assignment.
 *
 * Runs hourly (TICKS registry) but self-gates to one pass per day. For each
 * CURRENT certification (latest non-revoked per employee+skill, active
 * employees only) it computes the alert stage from days-to-expiry:
 *
 *     stage 1 = ≤90 days   stage 2 = ≤60   stage 3 = ≤30   stage 4 = expired
 *
 * and acts only when the computed stage EXCEEDS the record's alert_stage
 * watermark — so each stage fires exactly once per certification record
 * (re-issuing the cert creates a new record with stage 0, resetting the ladder).
 *
 * On each new stage:
 *   - notify the employee (in-app always; email rides on the master switch,
 *     category 'compliance') and their manager/supervisor,
 *   - from stage 2 (≤60 days), FIRST try a refresher auto-assignment through
 *     the existing LMS mapping engine: first course mapped to the skill
 *     (course_skill_map) that the employee isn't already actively enrolled in.
 *     Best-effort — no LMS configured means no assignment, never an error.
 *     The assignment is silent (no separate lms.assigned notice): the expiry
 *     mail itself says a refresher is waiting and its button opens it, so the
 *     person reads one mail, not two unrelated ones (4.0.0 port, wave 7).
 *   - an EXPIRED certification (stage 4) is « critique »: the person must not
 *     do the work that requires it until it is renewed.
 */

const db = require('../config/database');

function stageFor(daysToExpiry) {
    if (daysToExpiry === null || daysToExpiry === undefined) return 0; // no expiry
    if (daysToExpiry < 0) return 4;
    if (daysToExpiry <= 30) return 3;
    if (daysToExpiry <= 60) return 2;
    if (daysToExpiry <= 90) return 1;
    return 0;
}

const EMPLOYEE_LINK = '/employee/my-certifications';
const LEARNING_LINK = '/employee/my-learning';

/**
 * The refresher of a certification, assigned FIRST (stage ≥ 2) and silently.
 * True when the person now has an active enrolment in a course mapped to the
 * skill (just assigned or already there). Best-effort: no LMS means false.
 */
async function refresherFor(c, stage) {
    if (stage < 2) return { assigned: false, active: false };
    let assigned = false;
    try {
        const course = await db.get(
            `SELECT m.course_id AS "courseId"
               FROM course_skill_map m
               JOIN lms_courses c2 ON c2.id = m.course_id
              WHERE m.skill_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM lms_enrollments e
                     WHERE e.employee_id = ? AND e.course_id = m.course_id
                       AND e.status IN ('assigned', 'in_progress'))
              ORDER BY m.course_id LIMIT 1`,
            [c.skillId, c.employeeId]
        );
        if (course) {
            await require('../services/LmsService').assignCourse(c.employeeId, course.courseId, {
                assignedBy: null,
                notifyLearner: false,
            });
            assigned = true;
        }
        const active = await db.get(
            `SELECT 1 AS x FROM lms_enrollments e
               JOIN course_skill_map m ON m.course_id = e.course_id AND m.skill_id = ?
              WHERE e.employee_id = ? AND e.status IN ('assigned', 'in_progress')
              LIMIT 1`,
            [c.skillId, c.employeeId]
        );
        return { assigned, active: !!active };
    } catch (_) {
        /* LMS optional — never fail the sweep */
        return { assigned, active: false };
    }
}

/**
 * The person's own mail for a stage, for any language (B = emailTemplate
 * blocks in the recipient's language). The certification and its date are in
 * the body only; the subject is the catalogue's. The issuing body (migration
 * 196), when recorded, is said in this mail only: it is the person's own
 * record. The line's mail and every subject leave it out.
 */
function employeeMail(c, stage, label, due, { refresher = false } = {}) {
    const expired = stage === 4;
    return (B) => {
        const blocks = [
            B.para(
                `La certification ${c.skillName} ${label.fr} (échéance ${due}).`,
                `The ${c.skillName} certification ${label.en} (due ${due}).`
            ),
            ...(c.issuer
                ? [B.para(`Organisme émetteur : ${c.issuer}.`, `Issued by: ${c.issuer}.`)]
                : []),
            expired
                ? B.notice(
                      'Ne réalisez pas les tâches qui exigent cette certification avant son renouvellement. Parlez-en à votre responsable.',
                      'Do not carry out the tasks that require this certification until it is renewed. Talk to your manager.',
                      'critical'
                  )
                : B.para(
                      'Planifiez la revalidation avant l’échéance.',
                      'Schedule the revalidation before the due date.'
                  ),
        ];
        if (refresher)
            blocks.push(
                B.notice(
                    'Un module de recyclage vous attend dans votre espace formation : le suivre prépare le renouvellement.',
                    'A refresher course is waiting for you in your learning page: taking it prepares the renewal.',
                    'info'
                )
            );
        return {
            blocks,
            ctaLabel: refresher
                ? B.pick('Ouvrir mon recyclage', 'Open my refresher course')
                : B.pick('Voir mes certifications', 'See my certifications'),
            ctaUrl: refresher ? LEARNING_LINK : EMPLOYEE_LINK,
        };
    };
}

const STAGE_LABEL = {
    1: { fr: 'expire dans 90 jours', en: 'expires within 90 days' },
    2: { fr: 'expire dans 60 jours', en: 'expires within 60 days' },
    3: { fr: 'expire dans 30 jours', en: 'expires within 30 days' },
    4: { fr: 'a EXPIRÉ', en: 'has EXPIRED' },
};

async function tick() {
    const AppSettingsModel = require('../models/AppSettingsModel');
    const today = new Date().toISOString().slice(0, 10);
    const last = await AppSettingsModel.getValue('certExpiryLastRunOn', null);
    if (last === today) return { checked: 0, skipped: 'already_today' };
    await AppSettingsModel.setValue(
        'certExpiryLastRunOn',
        today,
        'string',
        'Last cert-expiry sweep date',
        'jobs'
    );

    // Current certs with an expiry inside (or past) the widest alert horizon.
    const due = await db.all(
        `SELECT cc.certification_id AS "certId", cc.employee_id AS "employeeId", cc.full_name AS "fullName",
                cc.skill_id AS "skillId", cc.skill_name AS "skillName",
                cc.expires_on AS "expiresOn", cc.days_to_expiry AS "daysToExpiry", cc.alert_stage AS "alertStage",
                ec.issuer AS "issuer"
           FROM v_certification_current cc
           LEFT JOIN public.employee_certifications ec ON ec.id = cc.certification_id
          WHERE cc.expires_on IS NOT NULL
            AND cc.days_to_expiry <= 90`
    );

    const NotificationService = require('../services/NotificationService');
    const { fmtDate } = require('../utils/dateFormat');
    // Each mail is written in its recipient's e-mail language, else the site's
    // (the NotificationService `content` builder below).
    let alerts = 0,
        lmsAssigned = 0;

    for (const c of due) {
        try {
            const stage = stageFor(Number(c.daysToExpiry));
            if (stage <= Number(c.alertStage)) continue; // this stage already sent

            // Claim the stage BEFORE notifying (no duplicate alerts on crash), and
            // RELEASE it if the notification does not land.
            //
            // `alert_stage` is a monotonic watermark, so raising it is the claim —
            // but it was raised unconditionally and `notify` returns
            // `inapp:'error'` WITHOUT throwing, and nobody read the return value.
            // A single failed notification therefore burned the stage permanently:
            // the alert was never retried, never re-raised at a later stage, and the
            // job still counted it in `alerts`. For an expiring statutory ticket
            // that is a compliance alert that silently never happened.
            const priorStage = Number(c.alertStage) || 0;
            await db.run(
                'UPDATE employee_certifications SET alert_stage = ?, updated_at = now() WHERE id = ?',
                [stage, c.certId]
            );
            const releaseStage = async () => {
                try {
                    await db.run(
                        'UPDATE employee_certifications SET alert_stage = ?, updated_at = now() WHERE id = ?',
                        [priorStage, c.certId]
                    );
                } catch (e) {
                    console.error(
                        '[cert-expiry] could not release the claimed stage for cert',
                        c.certId,
                        e && e.message
                    );
                }
            };

            const label = STAGE_LABEL[stage];
            // ONE language per mail; the certification and its date are in the
            // body only — the subject is the catalogue's (no name, no date).
            const due = fmtDate(c.expiresOn);

            // The refresher is assigned FIRST (stage ≥ 2), silently, so the
            // expiry mail can say so and open it — one mail instead of two.
            const ref = await refresherFor(c, stage);
            if (ref.assigned) lmsAssigned++;

            // Employee notification. The EMPLOYEE's alert is what the stage claims;
            // if it fails, hand the stage back so the next tick tries again.
            const empResult = await NotificationService.notify({
                userType: 'employee',
                userId: c.employeeId,
                kind: 'cert.expiry',
                category: 'compliance',
                payload: {
                    skillId: c.skillId,
                    skillName: c.skillName,
                    expiresOn: c.expiresOn,
                    stage,
                    link: ref.active ? LEARNING_LINK : EMPLOYEE_LINK,
                    ...(ref.active ? { refresher: true } : {}),
                },
                // An expired certification is critical, not a deadline.
                ...(stage === 4 ? { severity: 'critique' } : {}),
                content: employeeMail(c, stage, label, due, { refresher: ref.active }),
            });
            if (!empResult || empResult.inapp === 'error') {
                await releaseStage();
                console.error(
                    '[cert-expiry] alert not delivered for cert',
                    c.certId,
                    '- stage released for retry'
                );
                continue;
            }
            // Line notification: the EFFECTIVE reviewer — ACTIVE supervisor →
            // ACTIVE employee-manager → ACTIVE admin-manager (3.23.18 R2). A
            // departed supervisor used to receive it and nobody else did.
            const mgr = await require('../services/ReportingLineService')
                .effectiveReviewer(c.employeeId)
                .catch(() => null);
            if (mgr && mgr.id) {
                await NotificationService.notify({
                    userType: mgr.type,
                    userId: Number(mgr.id),
                    kind: 'cert.expiry.team',
                    category: 'compliance',
                    payload: {
                        employeeId: c.employeeId,
                        skillName: c.skillName,
                        expiresOn: c.expiresOn,
                        stage,
                    },
                    ...(stage === 4 ? { severity: 'critique' } : {}),
                    content: (B) => ({
                        blocks: [
                            B.para(
                                `${c.fullName} : la certification ${c.skillName} ${label.fr} (échéance ${due}).`,
                                `${c.fullName}: the ${c.skillName} certification ${label.en} (due ${due}).`
                            ),
                        ],
                    }),
                });
            }
            alerts++;
            // (The refresher used to be assigned HERE, after the mail, with its
            // own lms.assigned notice. Stage 4 — the already-expired certificates —
            // is included: the people most in breach need it most. Stage is a
            // monotonic watermark, so it still assigns at most once per stage.)
        } catch (e) {
            console.error(`[cert-expiry] cert ${c.certId} failed:`, e.message);
        }
    }
    return { checked: due.length, alerts, lmsAssigned };
}

module.exports = { tick, stageFor, __test: { employeeMail, refresherFor } };
