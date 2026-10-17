'use strict';

/**
 * manager-digest — weekly email recap for every manager/supervisor with reports.
 *
 * Redesigned (3.22.35) on the shared branded template (emailTemplate.js) and
 * broadened to the full set of criteria a manager is accountable for:
 *
 *   1. Pending self-assessment reviews        (workflow throughput)
 *   2. Open IDP actions                       (development follow-through)
 *   3. Critical skill gaps — MEASURED only    (operational risk)
 *   3b. Critical skills not yet measured      (measurement debt, reported apart)
 *   4. Certifications expiring ≤60 days       (compliance runway)
 *   5. Coverage breaches — live AND predicted (safe-shift assurance)
 *   6. Current campaign completion            (cycle discipline)
 *
 * Sections render ONLY when non-empty, KPI chips give the 5-second read, and
 * each figure states where to act. One language per mail (the site's mail
 * language), through the one renderer (renderEmail blocks); the subject is the
 * catalogue's and carries no date and no figure.
 *
 * Cadence unchanged: hourly tick, fires on DIGEST_DOW at/after DIGEST_HOUR,
 * at most once per week (digestLastSentOn claim BEFORE sending). Delivery via
 * NotificationService (in-app always lands; email rides the master switch).
 */

const db = require('../config/database');
const { fmtDate } = require('../utils/dateFormat');
const { dayKey } = require('../utils/dayKey');

const ENV_DOW = Number(process.env.DIGEST_DOW) || 1; // 1 = Monday
const ENV_HOUR = Number(process.env.DIGEST_HOUR) || 7;

async function tick() {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');
    let dow = ENV_DOW,
        hour = ENV_HOUR;
    try {
        dow = Number(await AppSettingsModel.getValue('digestDow', ENV_DOW));
        hour = Number(await AppSettingsModel.getValue('digestHour', ENV_HOUR));
    } catch {
        /* settings unavailable → env/default */
    }
    if (now.getDay() !== dow || now.getHours() < hour) return { sent: 0, skipped: 'not_due' };
    const today = dayKey(now); // LOCAL day — matches the getDay()/getHours() gate (J12)
    const last = await AppSettingsModel.getValue('digestLastSentOn', null);
    if (last === today) return { sent: 0, skipped: 'already_today' };

    // Claim the run BEFORE sending so a crash mid-run can't double-send next tick.
    await AppSettingsModel.setValue(
        'digestLastSentOn',
        today,
        'string',
        'Last manager-digest send date',
        'notifications'
    );

    const managers = await db.all(`
        SELECT DISTINCT m.id, m.email, m.first_name
          FROM employees m
          JOIN employees e ON (e.supervisor_id = m.id OR (e.manager_id = m.id AND e.manager_type = 'employee'))
         WHERE m.is_active = true AND e.is_active = true`);

    const EmployeeModel = require('../models/EmployeeModel');
    // ONE language per mail: the manager's own e-mail language, else the
    // site's (resolved per recipient below); the subject is the catalogue's and
    // carries no date and no figure.
    const NotificationService = require('../services/NotificationService');
    const siteLang = await require('../utils/emailTemplate').mailLang();
    let sent = 0;

    // Current open campaign (shared across managers; per-manager counts below).
    const DashboardService = require('../services/DashboardService');
    const cycle = await DashboardService.getOpenCampaignCycle();

    for (const mgr of managers) {
        try {
            const ids = await EmployeeModel.findGovernedIds(mgr.id);
            if (!ids.length) continue;
            const lang = await require('../utils/emailTemplate').recipientLang(
                'employee',
                mgr.id,
                siteLang
            );
            const T = require('../utils/emailTemplate').blocks(lang);
            const ph = ids.map(() => '?').join(',');

            // NO LIMIT here: TOTALS must reflect the whole sub-tree (a manager
            // with 12 pending reviews must see 12, not 8). The email tables
            // display only the top rows via .slice(0, 8) below.
            const [reviews, idp, gaps, unmeasured, certs, campaign] = await Promise.all([
                db.all(
                    `
                    SELECT sa.employee_id AS "employeeId", count(*)::int AS n
                      FROM self_assessments sa
                     WHERE sa.employee_id IN (${ph}) AND sa.workflow_state IN ('submitted','under_review')
                     GROUP BY 1 ORDER BY n DESC`,
                    ids
                ),
                db.all(
                    `
                    SELECT p.employee_id AS "employeeId", count(*)::int AS n
                      FROM idp_actions a JOIN idp_plans p ON p.id = a.idp_id
                     WHERE p.employee_id IN (${ph}) AND a.status NOT IN ('completed','cancelled')
                       AND p.status IN ('draft','active')
                     GROUP BY 1 ORDER BY n DESC`,
                    ids
                ),
                // A GAP is a MEASURED shortfall. v_employee_skill_gaps COALESCEs an
                // absent level to 0, so `gap > 0` alone also returns every critical
                // skill nobody has ever assessed — a requirement of 3 against no
                // measurement reads as "gap 3". Measured on this database: 303
                // critical gaps reported, 0 of them assessed, and org-wide 2 500 of
                // 3 352 gap points fabricated. `is_assessed` is what separates them.
                db.all(
                    `
                    SELECT g.skill_name, count(*)::int AS n
                      FROM v_employee_skill_gaps g
                     WHERE g.employee_id IN (${ph}) AND g.is_critical AND g.gap > 0
                       AND g.is_assessed = 1
                     GROUP BY 1 ORDER BY n DESC`,
                    ids
                ),
                // The unmeasured ones are still real news — arguably more actionable
                // than a gap — so they are reported as their own thing rather than
                // dropped. "Not measured" is not "meets the requirement".
                db.all(
                    `
                    SELECT g.skill_name, count(*)::int AS n
                      FROM v_employee_skill_gaps g
                     WHERE g.employee_id IN (${ph}) AND g.is_critical AND g.is_assessed = 0
                     GROUP BY 1 ORDER BY n DESC`,
                    ids
                ),
                db
                    .all(
                        `
                    SELECT cc.employee_id AS "employeeId", cc.days_to_expiry::int AS days
                      FROM v_certification_current cc
                     WHERE cc.employee_id IN (${ph}) AND cc.expires_on IS NOT NULL AND cc.days_to_expiry <= 60
                     ORDER BY cc.days_to_expiry ASC`,
                        ids
                    )
                    .catch(() => []),
                // Campaign progress from the PARTICIPANT ROSTER (migration 70).
                // self_assessments rows only exist once somebody has ACTED, so
                // the old denominator counted the team members who had already
                // submitted and mailed managers "100 %" while most of their team
                // had not started. The roster puts the non-starter back in.
                DashboardService.getCampaignFunnel(ids, cycle).catch(() => null),
            ]);

            // Coverage breaches (live + predicted) visible to this manager.
            let breaches = [],
                predicted = [];
            try {
                const CoverageService = require('../services/CoverageService');
                const cov = await CoverageService.status(ids);
                breaches = cov.filter((r) => !r.satisfied);
                predicted = cov.filter((r) => r.satisfied && r.predictedBreachOn);
            } catch {
                /* compliance optional on older schemas */
            }

            const totals = {
                reviews: reviews.reduce((s, r) => s + r.n, 0),
                idp: idp.reduce((s, r) => s + r.n, 0),
                gaps: gaps.reduce((s, r) => s + r.n, 0),
                unmeasured: unmeasured.reduce((s, r) => s + r.n, 0),
                certs: certs.length,
                breaches: breaches.length + predicted.length,
            };
            // null when no campaign is open, when nobody on this team is enrolled
            // yet ("campagne non lancée"), or when the roster is unavailable —
            // never a percentage invented from an engagement-only table.
            const campaignPct = campaign && campaign.launched ? campaign.completionPct : null;
            const campaignFunnelFr =
                campaign && campaign.launched
                    ? `${campaign.submitted} / ${campaign.enrolled} soumis · ${campaign.notStarted} non démarrés`
                    : null;
            const campaignFunnelEn =
                campaign && campaign.launched
                    ? `${campaign.submitted} / ${campaign.enrolled} submitted · ${campaign.notStarted} not started`
                    : null;
            if (
                !totals.reviews &&
                !totals.idp &&
                !totals.gaps &&
                !totals.unmeasured &&
                !totals.certs &&
                !totals.breaches &&
                (campaignPct === null || campaignPct === 100)
            )
                continue; // nothing to say — no noise mail

            const blocks = [];
            blocks.push(
                T.kpis([
                    {
                        label: T.pick('Revues', 'Reviews'),
                        value: totals.reviews,
                        color: totals.reviews ? '#b45309' : '#15803d',
                    },
                    {
                        label: T.pick('Actions de développement', 'Development actions'),
                        value: totals.idp,
                        color: totals.idp ? '#b45309' : '#15803d',
                    },
                    {
                        label: T.pick('Écarts critiques', 'Critical gaps'),
                        value: totals.gaps,
                        color: totals.gaps ? '#b91c1c' : '#15803d',
                    },
                    // Amber, not red: an unmeasured skill is a measurement debt, not a
                    // proven competence shortfall. Green only when there is nothing left
                    // to measure.
                    {
                        label: T.pick('Non mesuré', 'Not measured'),
                        value: totals.unmeasured,
                        color: totals.unmeasured ? '#b45309' : '#15803d',
                    },
                    {
                        label: T.pick('Certifications ≤ 60 jours', 'Certifications ≤ 60 days'),
                        value: totals.certs,
                        color: totals.certs ? '#b45309' : '#15803d',
                    },
                    {
                        label: T.pick('Couverture', 'Coverage'),
                        value: totals.breaches,
                        color: totals.breaches ? '#b91c1c' : '#15803d',
                    },
                    ...(campaignPct !== null
                        ? [
                              {
                                  label: T.pick('Campagne', 'Campaign'),
                                  value: campaignPct + '%',
                                  color: campaignPct >= 80 ? '#15803d' : '#b45309',
                                  sub: `${cycle.code} · ${campaign.submitted}/${campaign.enrolled}`,
                              },
                          ]
                        : []),
                ])
            );

            // No person is named in a digest (wave 12, D3): counts only, and
            // a link to the page that holds the list under its own guard.
            if (totals.reviews) {
                blocks.push(
                    T.section(
                        'Revues d’auto-évaluation en attente',
                        'Pending self-assessment reviews',
                        '#b45309'
                    )
                );
                blocks.push(
                    T.para(
                        `${totals.reviews} auto-évaluation(s) de ${reviews.length} personne(s) attendent votre revue.`,
                        `${totals.reviews} self-assessment(s) from ${reviews.length} person(s) wait for your review.`
                    )
                );
                blocks.push(
                    T.button('Voir la liste', 'See the list', '/supervisor/self-assessment-reviews')
                );
            }
            if (certs.length) {
                const people = new Set(certs.map((c) => c.employeeId)).size;
                const soon = certs.filter((c) => c.days <= 30).length;
                blocks.push(
                    T.section(
                        'Certifications à renouveler (≤60 jours)',
                        'Certifications expiring (≤60 days)',
                        '#b45309'
                    )
                );
                blocks.push(
                    T.para(
                        `${certs.length} certification(s) de ${people} personne(s) arrivent à échéance dans les 60 jours, dont ${soon} dans les 30 jours. Planifiez la revalidation avant la date — une formation de recyclage associée est assignée automatiquement à 60 jours.`,
                        `${certs.length} certification(s) held by ${people} person(s) expire within 60 days, ${soon} of them within 30 days. Schedule the revalidation before the date — a mapped LMS refresher is auto-assigned at 60 days.`
                    )
                );
                blocks.push(T.button('Voir la liste', 'See the list', '/compliance'));
            }
            if (breaches.length || predicted.length) {
                blocks.push(T.section('Couverture de postes', 'Position coverage', '#b91c1c'));
                blocks.push(
                    T.table(
                        [
                            { fr: 'Règle', en: 'Rule' },
                            { fr: 'État', en: 'Status' },
                        ],
                        [
                            ...breaches.map((b) => [
                                b.name,
                                {
                                    text: `${T.pick('Rupture', 'Breach')} — ${b.qualifiedHeadcount}/${b.minHeadcount}`,
                                    color: '#b91c1c',
                                    bold: true,
                                },
                            ]),
                            ...predicted.map((b) => [
                                b.name,
                                {
                                    text: `${T.pick('prévue le', 'predicted on')} ${fmtDate(b.predictedBreachOn)} (${b.predictedQualified}/${b.minHeadcount})`,
                                    color: '#b45309',
                                },
                            ]),
                        ]
                    )
                );
            }
            if (totals.idp) {
                blocks.push(
                    T.section('Actions de développement ouvertes', 'Open development actions')
                );
                blocks.push(
                    T.para(
                        `${totals.idp} action(s) ouvertes dans les plans de ${idp.length} personne(s).`,
                        `${totals.idp} open action(s) in the plans of ${idp.length} person(s).`
                    )
                );
                blocks.push(T.button('Voir la liste', 'See the list', '/tasks'));
            }
            if (totals.gaps) {
                blocks.push(T.section('Écarts de compétences critiques', 'Critical skill gaps'));
                blocks.push(
                    T.table(
                        [
                            { fr: 'Compétence', en: 'Skill' },
                            { fr: 'Personnes', en: 'People' },
                        ],
                        gaps.slice(0, 8).map((r) => [r.skillName || r.skill_name, String(r.n)])
                    )
                );
            }
            if (totals.unmeasured) {
                blocks.push(
                    T.section(
                        'Compétences critiques non mesurées',
                        'Critical skills not yet measured'
                    )
                );
                blocks.push(
                    T.table(
                        [
                            { fr: 'Compétence', en: 'Skill' },
                            { fr: 'Personnes', en: 'People' },
                        ],
                        unmeasured
                            .slice(0, 8)
                            .map((r) => [r.skillName || r.skill_name, String(r.n)])
                    )
                );
            }
            if (campaignPct !== null && campaignPct < 100 && cycle) {
                const closes = cycle.closesAt ? fmtDate(cycle.closesAt) : null;
                // A LOCKED campaign is still followed: the employee window is
                // shut, the manager's reviews are what is left.
                const locked = cycle.status === 'locked';
                blocks.push(
                    T.section(
                        `Campagne ${cycle.label}${locked ? ' — verrouillée, revues à finaliser' : ''}`,
                        `Campaign ${cycle.label}${locked ? ' — locked, reviews to finalise' : ''}`,
                        campaignPct >= 80 ? '#15803d' : '#b45309'
                    )
                );
                // The funnel, stated honestly: how many of the people ASKED have
                // submitted, and how many have not even started.
                blocks.push(
                    T.para(
                        `${campaignFunnelFr}, ${campaign.inProgress} en cours` +
                            (closes
                                ? ` — ${locked ? 'échéance passée le' : 'clôture le'} ${closes}.`
                                : '.'),
                        `${campaignFunnelEn}, ${campaign.inProgress} in progress` +
                            (closes
                                ? ` — ${locked ? 'deadline passed on' : 'closes'} ${closes}.`
                                : '.')
                    )
                );
                if (campaign.notStarted) {
                    blocks.push(
                        T.para(
                            `${campaign.notStarted} membre(s) de votre équipe n’ont pas ouvert la campagne : relancez-les nommément depuis la console de campagne.`,
                            `${campaign.notStarted} team member(s) have not opened the campaign: nudge them by name from the campaign console.`
                        )
                    );
                }
            }
            const r = await NotificationService.notify({
                userType: 'employee',
                userId: mgr.id,
                kind: 'manager_digest',
                category: 'digest',
                payload: {
                    totals,
                    campaignPct,
                    campaign:
                        campaign && campaign.launched
                            ? {
                                  code: cycle.code,
                                  enrolled: campaign.enrolled,
                                  submitted: campaign.submitted,
                                  notStarted: campaign.notStarted,
                                  inProgress: campaign.inProgress,
                              }
                            : null,
                    week: today,
                },
                locale: lang,
                title: T.pick(
                    'Récapitulatif hebdomadaire de votre équipe',
                    'Weekly summary of your team'
                ),
                blocks,
                ctaUrl: '/dashboard',
                ctaLabel: T.pick('Ouvrir mon espace', 'Open my workspace'),
            });
            if (r && r.inapp && r.inapp !== 'error') sent++;
        } catch (e) {
            console.error(`[digest] manager ${mgr.id} failed:`, e.message);
        }
    }
    return { sent, managers: managers.length };
}

module.exports = { tick };
