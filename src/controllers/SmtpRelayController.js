'use strict';

/**
 * SmtpRelayController — names (or withdraws) the ONE SMTP relay that may be
 * reached without TLS. Every other SMTP server must offer TLS (STARTTLS is
 * required). SuperAdmin only, mandatory reason, audited in
 * EmailService.setPlaintextRelay.
 *
 *   POST /app-settings/smtp/plaintext-relay   body: host ('' = withdraw), reason
 */
const EmailService = require('../services/EmailService');

const tr = (req, key, fallback, params) =>
    req.t ? req.t(`admin:${key}`, { defaultValue: fallback, ...(params || {}) }) : fallback;

const MESSAGES = {
    superadmin_only: 'Only a SuperAdmin can allow an unencrypted SMTP relay.',
    reason_required: 'A reason (at least 10 characters) is mandatory.',
    bad_host: 'The relay host name is invalid.',
};

class SmtpRelayController {
    async set(req, res) {
        try {
            const out = await EmailService.setPlaintextRelay(req.user, {
                host: req.body && req.body.host,
                reason: req.body && req.body.reason,
            });
            if (!out.ok)
                req.flash(
                    'error',
                    tr(req, `smtp_relay_err_${out.code}`, MESSAGES[out.code] || out.code)
                );
            else if (out.host)
                req.flash(
                    'success',
                    tr(req, 'smtp_relay_set', `Unencrypted SMTP allowed for ${out.host} only.`, {
                        host: out.host,
                    })
                );
            else
                req.flash(
                    'success',
                    tr(
                        req,
                        'smtp_relay_cleared',
                        'Unencrypted SMTP relay withdrawn: TLS is required again for every server.'
                    )
                );
        } catch (e) {
            console.error('SMTP relay setting error:', e && e.message);
            req.flash(
                'error',
                tr(req, 'smtp_relay_save_error', 'The SMTP relay setting could not be saved.')
            );
        }
        res.redirect('/app-settings#smtp-plaintext-relay');
    }
}

module.exports = new SmtpRelayController();
