'use strict';

/**
 * planning-digest — the monthly workforce-planning brief.
 *
 * The reactive nudges each answer "this one thing slipped". This is the other
 * half: once a month, per manager, ONE forward-looking page answering "what
 * will hurt me in the next quarter, and what do I do about it today". Three
 * sections, each with a deep link to the exact console where the fix lives:
 *
 *   1. Certifications expiring within 90 days   → /compliance
 *      Named, dated, sorted by urgency: the manager must book the revalidation
 *      (VOC) before the ticket lapses, because a lapsed ticket degrades that
 *      person's readiness to 0 (migration 78) and can breach a coverage rule.
 *   2. Critical roles in scope with an EMPTY bench → /v2/continuity
 *      The key-person exposure, named by role.
 *   3. Retention risk that turned HIGH this month → /v2/continuity
 *      COUNT ONLY. retention_risk is a `restricted` confidentiality tier, so
 *      no name and no band ever leaves the app; the count plus the link is the
 *      whole message.
 *
 * Anti-noise rules, deliberately strict:
 *   - a manager with nothing in all three sections gets NOTHING,
 *   - empty sections are omitted rather than rendered as a row of zeros,
 *   - one claim per manager per calendar month in the shared reminder_log
 *     (claim-before-send), so the hourly tick, a restart, or a second app
 *     instance can never double-send.
 *
 * Tiering: delivered through NotificationService.notify, which is where the
 * existing quiet-hours deferral, the per-user email opt-out and the `digest`
 * category switch already live — this job adds no new delivery path. Like
 * manager_digest / dept_digest the kind is deliberately absent from
 * KIND_POLICY: it composes its own branded bilingual email and is gated by the
 * email category, not by a per-kind tier.
 */

const db = require('../config/database');
const { claim, release, monthBucket } = require('./reminders');

const ENV_DOM = Number(process.env.PLANNING_DIGEST_DOM) || 1; // 1st of the month
const ENV_HOUR = Number(process.env.PLANNING_DIGEST_HOUR) || 7;
const CERT_HORIZON_DAYS = Number(process.env.PLANNING_DIGEST_CERT_DAYS) || 90;
// How far back "newly high" reaches. Slightly over a month so a crossing on the
// 2nd is still reported in the following month's brief rather than being lost
// in the gap between two runs.
// Must not exceed the send cadence, or the SAME people are reported as "newly at
// high risk" in two consecutive briefs: at 35 days against a monthly cadence
// (28-31 days) every brief re-reported 4 to 7 days of overlap, so the number in the
// e-mail contradicted the application. 28 is the shortest month, so no window can
// span two sends.
const NEWLY_HIGH_DAYS = 28;

/** Everything one manager needs, or nulls when a section has nothing to say. */
async function collect(managerId, ids) {
    if (!ids.length) return { certs: [], noBench: [], newlyHigh: 0 };
    const ph = ids.map(() => '?').join(',');

    // Sequential, NOT Promise.all: a tick can be exercised from inside
    // db.runTransaction (probes, tests), where every query shares ONE pg client
    // and a parallel fan-out trips node-pg's "client is already executing a
    // query" path. A monthly batch has no latency budget worth the risk.
    const certs = await db
        .all(
            `SELECT cc.full_name AS "fullName", cc.skill_name AS "skillName",
                cc.expires_on AS "expiresOn", cc.days_to_expiry::int AS "days"
           FROM v_certification_current cc
          WHERE cc.employee_id IN (${ph})
            AND cc.expires_on IS NOT NULL
            AND cc.days_to_expiry <= ?
          ORDER BY cc.days_to_expiry ASC`,
            [...ids, CERT_HORIZON_DAYS]
        )
        .catch(() => []);

    const roles = await db
        .all(
            `SELECT DISTINCT role_id FROM employees WHERE id IN (${ph}) AND role_id IS NOT NULL`,
            ids
        )
        .catch(() => []);

    // "Newly high" comes from the ledger the nightly recompute writes, not from
    // retention_risk.updated_at — that column is refreshed on EVERY nightly
    // pass, so it can never mean "changed recently".
    const newlyHigh = await db
        .get(
            `SELECT COUNT(DISTINCT ref_id)::int AS n
           FROM reminder_log
          WHERE kind = 'retention.high' AND target_type = 'employee' AND target_id = ?
            AND sent_at >= now() - (? || ' days')::interval`,
            [managerId, NEWLY_HIGH_DAYS]
        )
        .catch(() => null);

    let noBench = [];
    const roleIds = roles.map((r) => Number(r.roleId ?? r.role_id)).filter(Boolean);
    if (roleIds.length) {
        try {
            noBench = await require('../services/ContinuityService').criticalRolesWithoutSuccessor(
                roleIds
            );
        } catch (_) {
            noBench = [];
        }
    }
    return { certs, noBench, newlyHigh: Number(newlyHigh && newlyHigh.n) || 0 };
}

/** Branded bilingual brief. Sections render only when they have content. */
function renderHtml(
    recipientName,
    { certs, noBench, newlyHigh },
    { branding = null, monthLabel = '' } = {}
) {
    const T = require('../utils/emailTemplate');
    const appUrl = T.baseUrl();
    const accent = branding && branding.accentColor;
    const blocks = [];
    const urgentCerts = certs.filter((c) => Number(c.days) <= 30).length;

    blocks.push(
        T.kpis([
            {
                label: 'Certifications (90 j)',
                value: certs.length,
                color: certs.length ? '#b45309' : '#15803d',
                sub: urgentCerts ? `${urgentCerts} à ≤30 j` : undefined,
            },
            {
                label: 'Postes clés sans relève',
                value: noBench.length,
                color: noBench.length ? '#b91c1c' : '#15803d',
            },
            {
                label: 'Risque de départ (nouveau)',
                value: newlyHigh,
                color: newlyHigh ? '#b45309' : '#15803d',
            },
        ])
    );

    if (certs.length) {
        blocks.push(
            T.section(
                'Certifications à renouveler (90 jours)',
                'Certifications to renew (90 days)',
                '#b45309'
            )
        );
        blocks.push(
            T.table(
                [
                    { fr: 'Collaborateur', en: 'Team member' },
                    { fr: 'Certification' },
                    { fr: 'Échéance', en: 'Expiry' },
                ],
                certs.slice(0, 12).map((c) => [
                    { text: c.fullName, bold: true },
                    c.skillName,
                    {
                        text:
                            Number(c.days) < 0
                                ? `${c.expiresOn} — expirée / expired`
                                : `${c.expiresOn} — ${c.days} j`,
                        color: Number(c.days) <= 30 ? '#b91c1c' : '#b45309',
                        bold: Number(c.days) <= 30,
                    },
                ])
            )
        );
        if (certs.length > 12) {
            blocks.push(
                T.para(`… et ${certs.length - 12} autre(s).`, `… and ${certs.length - 12} more.`)
            );
        }
        blocks.push(
            T.para(
                "Planifiez la revalidation (VOC) avant l'échéance : une certification expirée ramène la préparation de la personne à 0 sur cette compétence et peut rompre une règle de couverture.",
                'Schedule the revalidation (VOC) before the due date: a lapsed certification drops that person’s readiness to 0 on the skill and can breach a coverage rule.'
            )
        );
        if (appUrl)
            blocks.push(
                T.cta('Ouvrir la conformité', 'Open compliance', appUrl + '/compliance', accent)
            );
    }

    if (noBench.length) {
        blocks.push(
            T.section(
                'Postes critiques sans successeur',
                'Critical positions with no successor',
                '#b91c1c'
            )
        );
        blocks.push(
            T.table(
                [
                    { fr: 'Poste', en: 'Position' },
                    { fr: 'Criticité', en: 'Criticality' },
                    { fr: 'Titulaires', en: 'Occupants' },
                ],
                noBench.slice(0, 12).map((r) => [
                    { text: r.roleName ?? r.role_name, bold: true },
                    {
                        text: String(r.criticalityScore ?? r.criticality_score ?? '—'),
                        color: '#b91c1c',
                    },
                    String(r.occupantCount ?? r.occupant_count ?? 0),
                ])
            )
        );
        blocks.push(
            T.para(
                "Désignez au moins un successeur, ou une doublure d'urgence, pour chacun de ces postes : sans relève nommée, un départ se traduit directement par une interruption d'activité.",
                'Name at least one successor, or an emergency cover, for each of these positions: with no named bench, a departure translates straight into an operational interruption.'
            )
        );
        if (appUrl)
            blocks.push(
                T.cta('Ouvrir la continuité', 'Open continuity', appUrl + '/v2/continuity', accent)
            );
    }

    if (newlyHigh) {
        blocks.push(
            T.section(
                'Risque de départ passé en élevé ce mois-ci',
                'Retention risk that turned high this month',
                '#b45309'
            )
        );
        blocks.push(
            T.para(
                `${newlyHigh} personne(s) de votre périmètre sont passées en risque de départ élevé depuis le dernier point. Le détail nominatif reste dans l'application, où votre habilitation s'applique.`,
                `${newlyHigh} person(s) in your scope moved to high retention risk since the last brief. The named detail stays inside the app, where your clearance applies.`
            )
        );
        if (appUrl)
            blocks.push(
                T.cta(
                    'Voir le risque de rétention',
                    'View retention risk',
                    appUrl + '/v2/continuity',
                    accent
                )
            );
    }

    blocks.push(
        T.para(
            'Ce point est mensuel. Les alertes urgentes vous parviennent séparément, au fil de l’eau.',
            'This brief is monthly. Urgent alerts reach you separately, as they happen.'
        )
    );

    return T.wrap({
        branding,
        title: `Planification des effectifs${monthLabel ? ` — ${monthLabel}` : ''}`,
        intro: `Bonjour ${recipientName},`,
        blocks,
    });
}

function renderText({ certs, noBench, newlyHigh }) {
    const lines = [];
    if (certs.length) {
        lines.push(`Certifications à renouveler (90 j) : ${certs.length}`);
        for (const c of certs.slice(0, 12)) {
            lines.push(
                `  - ${c.fullName} — ${c.skillName} — ${c.expiresOn} (${Number(c.days) < 0 ? 'expirée' : c.days + ' j'})`
            );
        }
    }
    if (noBench.length) {
        lines.push(`Postes critiques sans successeur : ${noBench.length}`);
        for (const r of noBench.slice(0, 12)) lines.push(`  - ${r.roleName ?? r.role_name}`);
    }
    if (newlyHigh) lines.push(`Risque de départ passé en élevé ce mois-ci : ${newlyHigh}`);
    return lines.join('\n');
}

async function tick() {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');
    let dom = ENV_DOM,
        hour = ENV_HOUR;
    try {
        dom = Number(await AppSettingsModel.getValue('planningDigestDom', ENV_DOM));
        hour = Number(await AppSettingsModel.getValue('planningDigestHour', ENV_HOUR));
    } catch {
        /* env/default */
    }
    if (!Number.isFinite(dom)) dom = ENV_DOM;
    if (!Number.isFinite(hour)) hour = ENV_HOUR;
    if (now.getDate() !== dom || now.getHours() < hour) return { sent: 0, skipped: 'not_due' };

    const mo = monthBucket(now);
    const EmployeeModel = require('../models/EmployeeModel');
    const N = require('../services/NotificationService');
    let branding = null;
    try {
        branding = await require('../utils/branding').getBranding();
    } catch {
        /* stock identity */
    }
    const monthLabel = now.toISOString().slice(0, 7);

    const managers = await db.all(`
        SELECT DISTINCT m.id, m.first_name
          FROM employees m
          JOIN employees e ON (e.supervisor_id = m.id OR (e.manager_id = m.id AND e.manager_type = 'employee'))
         WHERE m.is_active = true AND e.is_active = true`);

    const out = { sent: 0, managers: managers.length, empty: 0 };
    for (const mgr of managers) {
        try {
            const mgrId = Number(mgr.id);
            const ids = await EmployeeModel.findGovernedIds(mgrId);
            if (!ids.length) continue;
            const data = await collect(mgrId, ids);
            if (!data.certs.length && !data.noBench.length && !data.newlyHigh) {
                out.empty++;
                continue;
            }
            // Claim BEFORE sending: exactly one brief per manager per month.
            if (!(await claim('planning.digest', 'employee', mgrId, 0, mo))) continue;

            const html = renderHtml(mgr.firstName ?? mgr.first_name ?? '', data, {
                branding,
                monthLabel,
            });
            const subject = `[IDevelop] Planification des effectifs / Workforce planning — ${monthLabel}`;
            const r = await N.notify({
                userType: 'employee',
                userId: mgrId,
                kind: 'planning.digest',
                category: 'digest',
                payload: {
                    link: '/v2/continuity',
                    period: mo,
                    certs: data.certs.length,
                    noBench: data.noBench.length,
                    newlyHigh: data.newlyHigh,
                },
                subject,
                html,
                text: renderText(data),
            });
            if (r && r.inapp && r.inapp !== 'error') {
                out.sent++;
                continue;
            }
            // Claimed but nothing delivered → hand the MONTHLY claim back, or this
            // manager's workforce-planning brief is lost for the whole month.
            await release('planning.digest', 'employee', mgrId, 0, mo);
        } catch (e) {
            console.error(`[planning-digest] manager ${mgr.id} failed:`, e.message);
            // The throw may have come from notify AFTER the claim was taken.
            // Releasing an unclaimed row is a harmless no-op DELETE.
            try {
                await release('planning.digest', 'employee', Number(mgr.id), 0, mo);
            } catch (_) {
                /* logged above */
            }
        }
    }

    if (process.env.NODE_ENV !== 'test') {
        console.log(
            `[planning-digest] managers:${out.managers} sent:${out.sent} nothing-to-say:${out.empty}`
        );
    }
    return out;
}

// `tick` is the job surface; `__test` exposes the pure-ish pieces so the
// section/anti-noise rules can be asserted without standing up a scheduler.
module.exports = { tick, __test: { collect, renderHtml, renderText } };
