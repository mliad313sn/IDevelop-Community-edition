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
 *   - from stage 2 (≤60 days), try a refresher auto-assignment through the
 *     existing LMS mapping engine: first course mapped to the skill
 *     (course_skill_map) that the employee isn't already actively enrolled in.
 *     Best-effort — no LMS configured means no assignment, never an error.
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
                cc.expires_on AS "expiresOn", cc.days_to_expiry AS "daysToExpiry", cc.alert_stage AS "alertStage"
           FROM v_certification_current cc
          WHERE cc.expires_on IS NOT NULL
            AND cc.days_to_expiry <= 90`
    );

    const NotificationService = require('../services/NotificationService');
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
            const esc = (s) =>
                String(s == null ? '' : s).replace(
                    /[&<>]/g,
                    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]
                );
            const subject = `[IDevelop] Certification ${stage === 4 ? 'expirée / expired' : 'à renouveler / renewal due'} — ${c.skillName}`;
            const html =
                `<p>La certification <strong>${esc(c.skillName)}</strong> ${label.fr} (échéance ${c.expiresOn}).` +
                ` <span style="color:#888;">/ The <strong>${esc(c.skillName)}</strong> certification ${label.en} (due ${c.expiresOn}).</span></p>` +
                `<p style="font-size:13px;color:#888;">Planifiez la revalidation (VOC) avant l'échéance. / Schedule the revalidation (VOC) before the due date.</p>`;

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
                },
                subject,
                html,
                text: `Certification ${c.skillName}: ${label.en} (due ${c.expiresOn}).`,
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
                    subject: `[IDevelop] Certification de ${c.fullName} ${stage === 4 ? 'expirée / expired' : 'à renouveler / renewal due'} — ${c.skillName}`,
                    html: `<p><strong>${esc(c.fullName)}</strong> : la certification <strong>${esc(c.skillName)}</strong> ${label.fr} (échéance ${c.expiresOn}). <span style="color:#888;">/ ${label.en} (due ${c.expiresOn}).</span></p>`,
                    text: `${c.fullName}: certification ${c.skillName} ${label.en} (due ${c.expiresOn}).`,
                });
            }
            alerts++;

            // LMS refresher auto-assignment from stage 2 (≤60 days). Best-effort.
            //
            // The upper bound used to be `stage <= 3`, which excluded stage 4 —
            // the ALREADY-EXPIRED certificates. The people most in breach, the
            // ones who may not legally perform the task today and whose lapsed
            // ticket degrades their readiness to 0 (v_certification_lapsed,
            // migration 78), were the only ones getting no refresher at all.
            // Stage is a monotonic watermark, so this still assigns at most once
            // per stage per certification record.
            if (stage >= 2) {
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
                        await require('../services/LmsService').assignCourse(
                            c.employeeId,
                            course.courseId,
                            { assignedBy: null }
                        );
                        lmsAssigned++;
                    }
                } catch (_) {
                    /* LMS optional — never fail the sweep */
                }
            }
        } catch (e) {
            console.error(`[cert-expiry] cert ${c.certId} failed:`, e.message);
        }
    }
    return { checked: due.length, alerts, lmsAssigned };
}

module.exports = { tick, stageFor };
