'use strict';

/**
 * CopilotEgressController — the SuperAdmin records (or withdraws) the transfer
 * basis and the processor-agreement acknowledgement that an EXTERNAL AI
 * provider needs before the copilot may send it anything. The verdict itself
 * lives in CopilotService.connectionGate(); this controller only writes the
 * record.
 *
 * Routes (SuperAdmin, CSRF like the other /app-settings posts):
 *   GET  /app-settings/copilot/egress                  JSON policy status
 *   POST /app-settings/copilot/transfer-basis          record
 *   POST /app-settings/copilot/transfer-basis/revoke   withdraw
 */
const CopilotService = require('../services/CopilotService');

const tr = (req, key, fallback, params) =>
    req.t ? req.t(`admin:${key}`, { defaultValue: fallback, ...(params || {}) }) : fallback;

const MESSAGES = {
    not_configured: 'No AI provider is configured.',
    bad_url: 'The AI endpoint URL is invalid.',
    basis_invalid: 'Choose the legal basis of the transfer.',
    basis_text_short: 'Describe the transfer basis (at least 20 characters).',
    region_required: 'State the region where the provider processes the data.',
    dpa_required: 'Tick the processor-agreement acknowledgement.',
};

function isSuperAdmin(req) {
    return !!(req.user && req.user.role === 'superadmin');
}

class CopilotEgressController {
    async status(req, res) {
        if (!isSuperAdmin(req)) return res.status(403).json({ ok: false });
        try {
            res.json({ ok: true, ...(await CopilotService.policyStatus()) });
        } catch (e) {
            res.status(500).json({ ok: false });
        }
    }

    async record(req, res) {
        if (!isSuperAdmin(req)) {
            req.flash(
                'error',
                tr(req, 'cpg_superadmin_only', 'Only a SuperAdmin can record an AI transfer basis.')
            );
            return res.redirect('/app-settings');
        }
        try {
            const b = req.body || {};
            const out = await CopilotService.recordTransferBasis(req.user, {
                basis: b.basis,
                basisText: b.basisText,
                region: b.region,
                dpaAcknowledged: b.dpaAcknowledged,
                dpaText: tr(
                    req,
                    'cpg_dpa_ack_text',
                    'I confirm that a data-processing agreement with this provider is in force and that the transfer of pseudonymised HR data to it rests on the basis recorded here.'
                ),
            });
            if (!out.ok) {
                req.flash('error', tr(req, `cpg_err_${out.code}`, MESSAGES[out.code] || out.code));
            } else {
                req.flash(
                    'success',
                    tr(
                        req,
                        'cpg_recorded',
                        `Transfer basis recorded for ${out.record.provider} (${out.record.host}).`,
                        { provider: out.record.provider, host: out.record.host }
                    )
                );
            }
        } catch (e) {
            console.error('Copilot transfer basis error:', e && e.message);
            req.flash('error', tr(req, 'cpg_save_error', 'The transfer basis could not be saved.'));
        }
        res.redirect('/app-settings#copilot-egress');
    }

    async revoke(req, res) {
        if (!isSuperAdmin(req)) {
            req.flash(
                'error',
                tr(req, 'cpg_superadmin_only', 'Only a SuperAdmin can record an AI transfer basis.')
            );
            return res.redirect('/app-settings');
        }
        try {
            await CopilotService.revokeTransferBasis(req.user);
            req.flash(
                'success',
                tr(
                    req,
                    'cpg_revoked',
                    'Transfer basis withdrawn: the external AI provider is disabled.'
                )
            );
        } catch (e) {
            req.flash('error', tr(req, 'cpg_save_error', 'The transfer basis could not be saved.'));
        }
        res.redirect('/app-settings#copilot-egress');
    }
}

module.exports = new CopilotEgressController();
