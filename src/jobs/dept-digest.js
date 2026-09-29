'use strict';

/**
 * dept-digest — opt-in bi-weekly / monthly "Departmental Status Report" for
 * admins, managers and supervisors (digest_subscriptions, migration 55).
 *
 * Each recipient's report is scoped to exactly the org sub-tree they govern:
 *   - manager / supervisor (employee account) → their governed reports
 *     (EmployeeModel.findGovernedIds — supervisor_id / manager_id sub-tree)
 *   - local admin / viewer → the employees inside their assigned scopes
 *     (RBACService.getFilteredEmployees, same resolution as the app pages)
 *   - superadmin → the whole organization
 *
 * Sections per department: headcount, matrix completion %, avg readiness,
 * pending self-assessment reviews, open PIPs, open IDP actions.
 *
 * Due logic (tick runs hourly; a subscription fires at most once per day):
 *   - biweekly: today matches day_of_week AND last send ≥ 13 days ago
 *   - monthly : today's day-of-month matches day_of_month
 * Both also wait for the configured hour. Per-recipient failures never abort
 * the tick. Delivery goes through EmailService (SMTP master-switch gated);
 * employee recipients also get the in-app notification via NotificationService.
 */

const db = require('../config/database');
const { dayKey } = require('../utils/dayKey');

/** Visible employee ids for a subscriber. null = unrestricted (superadmin). */
async function scopeFor(sub) {
    const EmployeeModel = require('../models/EmployeeModel');
    const RBACService = require('../services/RBACService');
    if (sub.subscriberType === 'employee') {
        return EmployeeModel.findGovernedIds(sub.subscriberId);
    }
    const admin = await db.get(
        'SELECT id, role, email, username FROM admins WHERE id = ? AND is_active',
        [sub.subscriberId]
    );
    if (!admin) return [];
    if (admin.role === 'superadmin') return null;
    const employees = await RBACService.getFilteredEmployees({
        id: admin.id,
        role: admin.role,
        userType: 'admin',
    });
    return employees.map((e) => Number(e.id));
}

/** Departmental stats over a scope (ids array, or null = all). */
async function departmentStats(ids) {
    const params = [];
    let scope = '';
    if (ids !== null) {
        if (!ids.length) return [];
        scope = ` AND g.employee_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    const completion = await db.all(
        `SELECT g.department_id AS "departmentId", g.site_name AS "siteName", g.department_name AS "departmentName",
                COUNT(DISTINCT g.employee_id)::int AS headcount,
                ROUND(100.0 * SUM(g.is_assessed) / NULLIF(COUNT(*), 0), 1)::float AS "completionPct"
           FROM v_employee_skill_gaps g
          WHERE 1 = 1${scope}
          GROUP BY 1, 2, 3 ORDER BY 2, 3`,
        params
    );

    const inList = (col) =>
        ids === null
            ? '1 = 1'
            : ids.length
              ? `${col} IN (${ids.map(() => '?').join(',')})`
              : '1 = 0';
    const idParams = ids === null ? [] : ids;

    const [readiness, reviews, pips, idp] = await Promise.all([
        // ONE NUMBER (Wave 2): the digest publishes readiness_assessed_only —
        // the same figure as the dashboard, the Report Builder and the API.
        // AVG(v_employee_readiness.readiness) counted every never-rated
        // requirement as a scored 0, so a department mid-rollout was emailed to
        // its own manager as under-performing. The all-requirements average is
        // kept beside it under a distinct name, plus the coverage that makes
        // either number readable.
        db.all(
            `SELECT department_id AS "departmentId",
                       ROUND(AVG(readiness_assessed_only), 1)::float AS "avgReadiness",
                       COUNT(readiness_assessed_only)::int            AS "measuredCount",
                       COUNT(*)::int                                  AS "scopedCount",
                       SUM(assessed_skills)::int                      AS "assessedSkills",
                       SUM(expected_skills)::int                      AS "expectedSkills",
                       ROUND(100.0 * SUM(assessed_skills) / NULLIF(SUM(expected_skills), 0), 1)::float AS "coveragePct"
                  FROM v_employee_assessment_coverage WHERE ${inList('employee_id')} GROUP BY 1`,
            [...idParams]
        ),
        db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
                  FROM self_assessments sa JOIN employees e ON e.id = sa.employee_id
                 WHERE sa.workflow_state IN ('submitted','under_review') AND ${inList('sa.employee_id')}
                 GROUP BY 1`,
            [...idParams]
        ),
        db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
                  FROM pips p JOIN employees e ON e.id = p.employee_id
                 WHERE p.state IN ('proposed','approved','active') AND ${inList('p.employee_id')}
                 GROUP BY 1`,
            [...idParams]
        ),
        db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
                  FROM idp_actions a JOIN idp_plans p ON p.id = a.idp_id JOIN employees e ON e.id = p.employee_id
                 WHERE a.status NOT IN ('completed','cancelled') AND p.status IN ('draft','active')
                   AND ${inList('p.employee_id')}
                 GROUP BY 1`,
            [...idParams]
        ),
    ]);
    const idx = (rows, key) => Object.fromEntries(rows.map((r) => [r.departmentId, r[key]]));
    const rd = idx(readiness, 'avgReadiness'),
        rv = idx(reviews, 'n'),
        pp = idx(pips, 'n'),
        ia = idx(idp, 'n');
    const rdMeasured = idx(readiness, 'measuredCount');
    const rdCoverage = idx(readiness, 'coveragePct');
    const rdAssessed = idx(readiness, 'assessedSkills');
    const rdExpected = idx(readiness, 'expectedSkills');
    return completion.map((c) => ({
        ...c,
        avgReadiness: rd[c.departmentId] ?? null,
        measuredCount: rdMeasured[c.departmentId] ?? 0,
        readinessCoveragePct: rdCoverage[c.departmentId] ?? null,
        assessedSkills: rdAssessed[c.departmentId] ?? 0,
        expectedSkills: rdExpected[c.departmentId] ?? 0,
        pendingReviews: rv[c.departmentId] || 0,
        openPips: pp[c.departmentId] || 0,
        openIdpActions: ia[c.departmentId] || 0,
    }));
}

/**
 * Branded departmental report (shared emailTemplate): KPI chips for the
 * aggregate picture, per-department table, and — when present — the live and
 * PREDICTED coverage-breach sections. Every figure states where to act.
 */
function renderHtml(
    recipientName,
    rows,
    periodLabel,
    { breaches = [], predicted = [], branding = null } = {}
) {
    const T = require('../utils/emailTemplate');
    const totals = rows.reduce(
        (a, r) => ({
            headcount: a.headcount + Number(r.headcount || 0),
            reviews: a.reviews + Number(r.pendingReviews || 0),
            pips: a.pips + Number(r.openPips || 0),
            idp: a.idp + Number(r.openIdpActions || 0),
        }),
        { headcount: 0, reviews: 0, pips: 0, idp: 0 }
    );
    // Average only over departments that HAVE a completion figure — a dept
    // with no requirements (null) must not drag the KPI toward zero.
    const withPct = rows.filter((r) => r.completionPct != null);
    const avgCompletion = withPct.length
        ? Math.round(withPct.reduce((s, r) => s + Number(r.completionPct), 0) / withPct.length)
        : null;

    const blocks = [];
    blocks.push(
        T.kpis([
            { label: 'Effectif / Headcount', value: totals.headcount },
            {
                label: 'Matrice / Matrix',
                value: avgCompletion == null ? '—' : avgCompletion + '%',
                color: avgCompletion >= 80 ? '#15803d' : '#b45309',
            },
            {
                label: 'Revues / Reviews',
                value: totals.reviews,
                color: totals.reviews ? '#b45309' : '#15803d',
            },
            { label: 'PIP', value: totals.pips, color: totals.pips ? '#b45309' : '#15803d' },
            {
                label: 'Couverture / Coverage',
                value: breaches.length,
                color: breaches.length ? '#b91c1c' : '#15803d',
                sub: predicted.length ? `+${predicted.length} prévue(s)` : undefined,
            },
        ])
    );

    blocks.push(T.section('Détail par département', 'Per-department detail'));
    blocks.push(
        T.table(
            [
                { fr: 'Site / Département', en: 'Site / Department' },
                { fr: 'Effectif', en: 'Headcount' },
                { fr: 'Matrice', en: 'Matrix' },
                { fr: 'Préparation (évalué)', en: 'Readiness (assessed)' },
                // The denominator ships with the score: a manager must be able to
                // read "62 %" as "62 % of the 14 of 96 requirements measured".
                { fr: 'Couverture', en: 'Coverage' },
                { fr: 'Revues', en: 'Reviews' },
                { fr: 'PIP' },
                { fr: 'IDP' },
            ],
            rows.map((r) => [
                { text: `${r.siteName} / ${r.departmentName}`, bold: true },
                String(r.headcount),
                r.completionPct == null
                    ? '—'
                    : {
                          text: r.completionPct + '%',
                          color: r.completionPct >= 80 ? '#15803d' : '#b45309',
                      },
                r.avgReadiness == null
                    ? { text: 'non mesuré / not measured', color: '#64748b' }
                    : r.avgReadiness + '%',
                r.expectedSkills
                    ? {
                          text:
                              `${r.assessedSkills}/${r.expectedSkills}` +
                              (r.readinessCoveragePct == null
                                  ? ''
                                  : ` (${r.readinessCoveragePct}%)`),
                          color: (r.readinessCoveragePct || 0) >= 80 ? '#15803d' : '#b45309',
                      }
                    : '—',
                r.pendingReviews
                    ? { text: String(r.pendingReviews), color: '#b45309', bold: true }
                    : '0',
                r.openPips ? { text: String(r.openPips), color: '#b45309' } : '0',
                String(r.openIdpActions),
            ])
        )
    );

    if (breaches.length) {
        blocks.push(T.section('Couverture insuffisante', 'Coverage breaches', '#b91c1c'));
        blocks.push(
            T.table(
                [
                    { fr: 'Règle', en: 'Rule' },
                    { fr: 'Qualifiés / requis', en: 'Qualified / required' },
                ],
                breaches.map((b) => [
                    {
                        text: `${b.severity === 'critical' ? '🔴 ' : '🟠 '}${b.name} — ${b.skillName}`,
                        bold: b.severity === 'critical',
                    },
                    {
                        text: `${b.qualifiedHeadcount}/${b.minHeadcount}`,
                        color: '#b91c1c',
                        bold: true,
                    },
                ])
            )
        );
    }
    if (predicted.length) {
        blocks.push(
            T.section('Ruptures prévues (14 jours)', 'Predicted breaches (14 days)', '#b45309')
        );
        blocks.push(
            T.table(
                [
                    { fr: 'Règle', en: 'Rule' },
                    { fr: 'Date prévue', en: 'Predicted date' },
                ],
                predicted.map((b) => [
                    `⚠ ${b.name}`,
                    {
                        text: `${new Date(b.predictedBreachOn).toISOString().slice(0, 10)} — ${b.predictedQualified}/${b.minHeadcount}`,
                        color: '#b45309',
                    },
                ])
            )
        );
        blocks.push(
            T.para(
                'Agissez avant la date : décalez une absence, planifiez une revalidation ou affectez un remplaçant.',
                'Act before the date: move an absence, schedule a revalidation, or assign cover.'
            )
        );
    }

    const appUrl = require('../utils/emailTemplate').baseUrl();
    if (appUrl)
        blocks.push(
            T.cta(
                'Ouvrir la conformité',
                'Open compliance',
                appUrl + '/compliance',
                branding && branding.accentColor
            )
        );
    blocks.push(
        T.para(
            'Gérez cet abonnement sous Rapports → Programmations.',
            'Manage this subscription under Reports → Schedules.'
        )
    );

    return T.wrap({
        branding,
        title: `Rapport départemental (${periodLabel})`,
        intro: `Bonjour ${recipientName},`,
        blocks,
    });
}

async function tick() {
    const now = new Date();
    const today = dayKey(now); // LOCAL day — matches the local hour/dow/dom gates (J12)
    const hour = now.getHours();
    const dow = now.getDay();
    const dom = now.getDate();

    const due = await db.all(
        `SELECT id, subscriber_type AS "subscriberType", subscriber_id AS "subscriberId",
                frequency, day_of_week AS "dayOfWeek", day_of_month AS "dayOfMonth",
                hour, last_sent_on AS "lastSentOn"
           FROM digest_subscriptions
          WHERE is_active = true
            AND hour <= ?
            AND (last_sent_on IS NULL OR last_sent_on < ?::date)
            AND ( (frequency = 'monthly'  AND day_of_month = ?)
               OR (frequency = 'biweekly' AND day_of_week = ?
                   AND (last_sent_on IS NULL OR last_sent_on <= (?::date - INTERVAL '13 days'))) )`,
        [hour, today, dom, dow, today]
    );
    if (!due.length) return { sent: 0 };

    const EmailService = require('../services/EmailService');
    let sent = 0;
    let failed = 0;

    // Restore last_sent_on to what it was before we claimed, so a subscription
    // whose delivery did not go through is due again and retries (bounded to the
    // same day by the frequency gate) instead of having the period burned.
    const releaseClaim = async (sub) => {
        try {
            await db.run(
                'UPDATE digest_subscriptions SET last_sent_on = ?, updated_at = now() WHERE id = ?',
                [sub.lastSentOn ?? null, sub.id]
            );
        } catch (e) {
            console.error(
                `[dept-digest] could not release claim on subscription ${sub.id}:`,
                e.message
            );
        }
    };

    for (const sub of due) {
        try {
            // Claim BEFORE sending so a crash mid-run can't double-send next tick.
            await db.run(
                'UPDATE digest_subscriptions SET last_sent_on = ?, updated_at = now() WHERE id = ?',
                [today, sub.id]
            );

            const ids = await scopeFor(sub);
            const rows = await departmentStats(ids);
            if (!rows.length) continue; // nothing in scope — nothing to say

            // Position-coverage breaches visible to this recipient (migration 56),
            // plus PREDICTED breaches inside the horizon (migration 58).
            let breaches = [],
                predicted = [];
            try {
                const CoverageService = require('../services/CoverageService');
                const covRows = await CoverageService.status(ids);
                breaches = covRows.filter((r) => !r.satisfied);
                predicted = covRows.filter((r) => r.satisfied && r.predictedBreachOn);
            } catch (_) {
                /* compliance module optional in older DBs */
            }

            let name = '',
                email = null,
                employeeId = null,
                adminId = null;
            if (sub.subscriberType === 'employee') {
                const e = await db.get(
                    'SELECT first_name, email FROM employees WHERE id = ? AND is_active',
                    [sub.subscriberId]
                );
                if (!e) continue;
                name = e.firstName;
                email = e.email;
                employeeId = sub.subscriberId;
            } else {
                const a = await db.get(
                    'SELECT username, email FROM admins WHERE id = ? AND is_active',
                    [sub.subscriberId]
                );
                if (!a) continue;
                name = a.username;
                email = a.email;
                adminId = sub.subscriberId;
            }

            const periodLabel =
                sub.frequency === 'monthly' ? 'mensuel / monthly' : 'bimensuel / bi-weekly';
            let branding = null;
            try {
                branding = await require('../utils/branding').getBranding();
            } catch {
                /* stock identity */
            }
            const html = renderHtml(name, rows, periodLabel, { breaches, predicted, branding });
            const subject = `[IDevelop] Rapport départemental / Departmental status report — ${today}`;
            const text = rows
                .map(
                    (r) =>
                        `${r.siteName}/${r.departmentName}: ${r.headcount} pers., matrice ${r.completionPct ?? '—'}%, ` +
                        `préparation ${r.avgReadiness == null ? 'non mesuré' : r.avgReadiness + '%'} ` +
                        `(sur ${r.assessedSkills}/${r.expectedSkills} exigences évaluées), ` +
                        `revues ${r.pendingReviews}, PIP ${r.openPips}, IDP ${r.openIdpActions}`
                )
                .join('\n');

            let delivered = false;
            if (employeeId) {
                // Managers/supervisors: in-app notification always lands; email rides along.
                const NotificationService = require('../services/NotificationService');
                const r = await NotificationService.notify({
                    userType: 'employee',
                    userId: employeeId,
                    kind: 'dept_digest',
                    category: 'digest',
                    payload: { departments: rows.length, period: sub.frequency, date: today },
                    subject,
                    html,
                    text,
                });
                delivered = !!(r && r.inapp && r.inapp !== 'error');
            } else if (adminId) {
                // Route ADMIN subscribers through notify as well. Sending straight
                // from EmailService skipped _userEmailAllowed and quiet hours, so an
                // admin who had set "e-mail notifications = NO" in /account/
                // notifications received the departmental digest anyway — and it was
                // never written to their bell, so it did not appear in-app either.
                // The employee branch above always did this; the asymmetry was
                // accidental.
                const NotificationService = require('../services/NotificationService');
                const r = await NotificationService.notify({
                    userType: 'admin',
                    userId: adminId,
                    kind: 'dept_digest',
                    category: 'digest',
                    payload: { departments: rows.length, period: sub.frequency, date: today },
                    subject,
                    html,
                    text,
                });
                delivered = !!(r && r.inapp && r.inapp !== 'error');
            } else if (email) {
                const r = await EmailService.send({ to: email, subject, html, text });
                delivered = !!(r && r.sent);
            }

            if (delivered) {
                sent++;
            } else {
                // Delivery did not go through (notify returned an error, or the
                // mail was not sent). The claim above would otherwise burn the
                // period silently — release it so the digest retries.
                await releaseClaim(sub);
                failed++;
                console.error(
                    `[dept-digest] subscription ${sub.id}: delivery failed, claim released for retry`
                );
            }
        } catch (e) {
            // A throw AFTER the claim would also burn the period. Release so it retries.
            await releaseClaim(sub);
            failed++;
            console.error(`[dept-digest] subscription ${sub.id} failed:`, e.message);
        }
    }
    return { sent, due: due.length, failed };
}

// `tick` is the job surface. `__test` exposes the two pure-ish pieces so the
// readiness figure and its "non mesuré" rendering can be asserted without
// standing up a scheduler.
module.exports = { tick, __test: { departmentStats, renderHtml } };
