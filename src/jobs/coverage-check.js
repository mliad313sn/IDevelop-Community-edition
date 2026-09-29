'use strict';

/**
 * coverage-check — evaluates every active position-coverage rule hourly.
 *
 * CoverageService.evaluateAll persists each evaluation onto the rule row
 * (last_actual / last_satisfied / breached_since) and returns only the rules
 * that TRANSITIONED on this pass, so alerts fire exactly once per breach:
 *
 *   ok → BREACHED : system_logs warning (category 'compliance') + in-app/email
 *                   notification to THE PEOPLE WHO CAN ACT.
 *   breached → ok : recovery entry in system_logs (info) so the audit trail
 *                   shows the full breach window.
 *
 * Who gets alerted (CoverageService.alertAudienceFor): the line managers of the
 * breached org unit first, the rule's creator as a fallback, and the
 * manage_compliance admins as the last resort — so a rule with a null
 * created_by can no longer alert NOBODY, and a breach on a site no longer pages
 * only whoever authored the rule months ago.
 *
 * How much gets alerted (ALERT_CAP): a bulk rule generation can flip hundreds
 * of rules into breach in a single pass. Past the cap this job stops sending
 * one notification per rule and sends ONE batched notice to the
 * manage_compliance audience instead. Every breach is still logged to
 * system_logs and still visible on /compliance — the cap limits the paging,
 * never the record.
 *
 * The live status (including ongoing breaches) is always visible on
 * /compliance and in the departmental digest — this job only handles the
 * transition alerts and the persisted evaluation trail.
 */

/** Max per-rule notifications in one pass; beyond it, one batched notice. */
function alertCap() {
    const n = parseInt(process.env.COVERAGE_ALERT_MAX || '25', 10);
    return Number.isFinite(n) && n >= 0 ? n : 25;
}

function ruleScopeLabel(r) {
    const bits = [];
    if (r.siteName) bits.push(r.siteName);
    if (r.departmentName) bits.push(r.departmentName);
    if (r.serviceName) bits.push(r.serviceName);
    return bits.length ? bits.join(' / ') : 'Whole organization';
}

const esc = (s) =>
    String(s == null ? '' : s).replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]
    );

/**
 * Over-cap fallback: ONE notice to the admins who hold `manage_compliance`
 * (the owners of the rule set), naming the count and a few examples, instead of
 * hundreds of individual pages. Never silent — an empty audience is logged.
 */
async function batchNotice(rules, kind, subject) {
    const NotificationService = require('../services/NotificationService');
    const RBACService = require('../services/RBACService');
    const LogService = require('../services/LogService');
    let admins = [];
    try {
        admins = await RBACService.adminsWithPermission('manage_compliance');
    } catch (e) {
        console.error('[coverage-check] batch audience lookup failed:', e.message);
    }
    const sample = rules.slice(0, 5).map((r) => `${r.name} (${ruleScopeLabel(r)})`);
    try {
        await LogService.log({
            action: 'COVERAGE_ALERT_BATCHED',
            entityType: 'coverage_rule',
            entityId: null,
            details: `${rules.length} rule transitions exceeded the per-pass alert cap — batched into one notice to ${admins.length} manage_compliance admin(s). Full detail is in the COVERAGE_BREACH/COVERAGE_PREDICTED_BREACH entries and on /compliance.`,
            severity: 'warn',
            category: 'compliance',
        });
    } catch (_) {
        /* logging must never break the sweep */
    }
    let delivered = 0;
    for (const adminId of admins) {
        try {
            const res = await NotificationService.notify({
                userType: 'admin',
                userId: Number(adminId),
                kind,
                category: 'compliance',
                payload: { count: rules.length, batched: true, link: '/compliance' },
                subject,
                html:
                    `<p><strong>${rules.length}</strong> règles de couverture viennent de basculer en rupture en une seule passe — ` +
                    `alertes regroupées pour éviter une avalanche. <span style="color:#888;">/ ${rules.length} coverage rules changed state in a single pass; alerts batched.</span></p>` +
                    `<ul>${sample.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` +
                    `<p style="font-size:13px;color:#888;">Détail complet sur /compliance et dans le journal système. / Full detail on /compliance and in the system log.</p>`,
                text: `${rules.length} coverage rules newly breached in one pass (alerts batched). See /compliance.`,
            });
            if (res && res.inapp && res.inapp !== 'error') delivered++;
        } catch (e) {
            console.error('[coverage-check] batch notice failed:', e.message);
        }
    }
    return { recipients: admins.length, delivered };
}

async function tick() {
    const CoverageService = require('../services/CoverageService');
    const LogService = require('../services/LogService');
    const NotificationService = require('../services/NotificationService');

    const { evaluated, newlyBreached, recovered } = await CoverageService.evaluateAll();

    // The audit trail is ALWAYS complete, whatever the alert cap does.
    for (const r of newlyBreached) {
        try {
            await LogService.log({
                action: 'COVERAGE_BREACH',
                entityType: 'coverage_rule',
                entityId: r.ruleId,
                details:
                    `Coverage BREACH [${r.severity}] "${r.name}" (${ruleScopeLabel(r)}): ` +
                    `${r.qualifiedHeadcount}/${r.minHeadcount} qualified at level>=${r.minLevel} in ${r.skillName}` +
                    `${r.requireValidCert ? ' with a valid certification' : ''}`,
                severity: 'warn',
                category: 'compliance',
            });
        } catch (e) {
            console.error(`[coverage-check] breach log for rule ${r.ruleId} failed:`, e.message);
        }
    }

    const cap = alertCap();
    if (newlyBreached.length > cap) {
        // Mass event (typically right after a bulk rule generation). One notice
        // to the people who own the rule set, not one page per rule.
        const batch = await batchNotice(
            newlyBreached,
            'coverage.breach.batch',
            `[IDevelop] ${newlyBreached.length} règles de couverture en rupture / coverage rules newly breached`
        );
        if (batch && batch.recipients > 0 && batch.delivered === 0) {
            // The whole batch reached nobody (systemic send failure). Re-open every
            // transition so the next pass retries, rather than burning the alert.
            for (const r of newlyBreached) {
                try {
                    await CoverageService.reopenTransition(r.ruleId, r.lastSatisfied);
                } catch (e) {
                    console.error(
                        `[coverage-check] could not reopen breach ${r.ruleId}:`,
                        e.message
                    );
                }
            }
        }
    } else {
        for (const r of newlyBreached) {
            let anyError = false;
            try {
                const rule = await CoverageService.findRule(r.ruleId);
                const audience = await CoverageService.alertAudienceFor(rule || r);
                for (const who of audience) {
                    const res = await NotificationService.notify({
                        userType: who.userType,
                        userId: who.userId,
                        kind: 'coverage.breach',
                        category: 'compliance',
                        payload: {
                            ruleId: r.ruleId,
                            name: r.name,
                            actual: r.qualifiedHeadcount,
                            required: r.minHeadcount,
                            severity: r.severity,
                            via: who.via,
                            link: '/compliance',
                        },
                        subject: `[IDevelop] ${r.severity === 'critical' ? 'CRITIQUE' : 'Alerte'} — couverture insuffisante / coverage breach: ${r.name}`,
                        html:
                            `<p><strong>${esc(r.name)}</strong> — ${esc(ruleScopeLabel(r))} : ` +
                            `<strong>${r.qualifiedHeadcount}/${r.minHeadcount}</strong> personnes qualifiées (${esc(r.skillName)}, niveau ≥ ${r.minLevel}` +
                            `${r.requireValidCert ? ', certification valide requise' : ''}). ` +
                            `<span style="color:#888;">/ qualified people below the required minimum.</span></p>`,
                        text: `${r.name} (${ruleScopeLabel(r)}): ${r.qualifiedHeadcount}/${r.minHeadcount} qualified — below minimum.`,
                    });
                    if (!(res && res.inapp && res.inapp !== 'error')) anyError = true;
                }
            } catch (e) {
                anyError = true;
                console.error(
                    `[coverage-check] breach alert for rule ${r.ruleId} failed:`,
                    e.message
                );
            }
            if (anyError) {
                // A recipient's alert did not go through. Re-open the transition so
                // the next pass re-detects the breach and retries; the breach is
                // never left recorded-but-unannounced.
                try {
                    await CoverageService.reopenTransition(r.ruleId, r.lastSatisfied);
                } catch (e) {
                    console.error(
                        `[coverage-check] could not reopen breach ${r.ruleId}:`,
                        e.message
                    );
                }
            }
        }
    }
    for (const r of recovered) {
        try {
            await LogService.log({
                action: 'COVERAGE_RECOVERED',
                entityType: 'coverage_rule',
                entityId: r.ruleId,
                details: `Coverage recovered "${r.name}" (${ruleScopeLabel(r)}): ${r.qualifiedHeadcount}/${r.minHeadcount} qualified`,
                severity: 'info',
                category: 'compliance',
            });
        } catch (e) {
            console.error(`[coverage-check] recovery log for rule ${r.ruleId} failed:`, e.message);
        }
    }

    // ---- PREDICTED breaches (migration 58): project planned absences +
    // in-horizon certificate expiry over the next 14 days. Alerts only when a
    // predicted breach APPEARS or moves EARLIER (predictAndPersist watermark).
    let predictedNew = 0;
    try {
        const { newlyPredicted } = await CoverageService.predictAndPersist(
            Number(process.env.COVERAGE_PREDICT_DAYS || 14)
        );
        for (const p of newlyPredicted) {
            try {
                await LogService.log({
                    action: 'COVERAGE_PREDICTED_BREACH',
                    entityType: 'coverage_rule',
                    entityId: p.id,
                    details: `PREDICTED coverage breach [${p.severity}] "${p.name}" on ${p.firstBreachOn}: only ${p.worstQualified}/${p.minHeadcount} present-qualified (worst day ${p.worstDay}; planned absences + certificate expiry projected)`,
                    severity: 'warn',
                    category: 'compliance',
                });
            } catch (e) {
                console.error(
                    `[coverage-check] predicted-breach log for rule ${p.id} failed:`,
                    e.message
                );
            }
        }
        if (newlyPredicted.length > cap) {
            const batch = await batchNotice(
                newlyPredicted,
                'coverage.predicted.batch',
                `[IDevelop] ${newlyPredicted.length} ruptures de couverture PRÉVUES / predicted coverage breaches`
            );
            if (batch && batch.recipients > 0 && batch.delivered === 0) {
                for (const p of newlyPredicted) {
                    try {
                        await CoverageService.reopenPrediction(p.id, p.prev);
                    } catch (e) {
                        console.error(
                            `[coverage-check] could not reopen prediction ${p.id}:`,
                            e.message
                        );
                    }
                }
            } else {
                predictedNew = newlyPredicted.length;
            }
        } else {
            for (const p of newlyPredicted) {
                let anyError = false;
                try {
                    const rule = await CoverageService.findRule(p.id);
                    const audience = await CoverageService.alertAudienceFor(
                        rule || { createdBy: p.createdBy }
                    );
                    for (const who of audience) {
                        const res = await NotificationService.notify({
                            userType: who.userType,
                            userId: who.userId,
                            kind: 'coverage.predicted',
                            category: 'compliance',
                            payload: {
                                ruleId: p.id,
                                name: p.name,
                                firstBreachOn: p.firstBreachOn,
                                worstQualified: p.worstQualified,
                                required: p.minHeadcount,
                                via: who.via,
                                link: '/compliance',
                            },
                            subject: `[IDevelop] Rupture de couverture PRÉVUE le ${p.firstBreachOn} / PREDICTED coverage breach: ${p.name}`,
                            html:
                                `<p><strong>${esc(p.name)}</strong> : rupture prévue le <strong>${p.firstBreachOn}</strong> — ` +
                                `seulement <strong>${p.worstQualified}/${p.minHeadcount}</strong> personnes qualifiées présentes (absences planifiées + expirations de certificats projetées). ` +
                                `<span style="color:#888;">/ Predicted breach on ${p.firstBreachOn}: only ${p.worstQualified}/${p.minHeadcount} present-qualified.</span></p>` +
                                `<p style="font-size:13px;color:#888;">Agissez avant la date : décalez une absence, planifiez une revalidation ou affectez un remplaçant. / Act before the date: move an absence, schedule a revalidation, or assign cover.</p>`,
                            text: `PREDICTED breach ${p.firstBreachOn}: ${p.name} — ${p.worstQualified}/${p.minHeadcount} present-qualified.`,
                        });
                        if (!(res && res.inapp && res.inapp !== 'error')) anyError = true;
                    }
                    if (!anyError) predictedNew++;
                } catch (e) {
                    anyError = true;
                    console.error(
                        `[coverage-check] predicted-breach alert for rule ${p.id} failed:`,
                        e.message
                    );
                }
                if (anyError) {
                    try {
                        await CoverageService.reopenPrediction(p.id, p.prev);
                    } catch (e) {
                        console.error(
                            `[coverage-check] could not reopen prediction ${p.id}:`,
                            e.message
                        );
                    }
                }
            }
        }
    } catch (e) {
        // Prediction must never break the live evaluation (e.g. pre-58 schema).
        console.error('[coverage-check] prediction pass failed:', e.message);
    }

    return { evaluated, breached: newlyBreached.length, recovered: recovered.length, predictedNew };
}

module.exports = { tick };
