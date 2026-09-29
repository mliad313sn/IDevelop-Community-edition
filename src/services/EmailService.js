'use strict';

const PRODUCT = require('../config/product');
const AppSettingsModel = require('../models/AppSettingsModel');
const LogService = require('./LogService');

let nodemailer;
try {
    nodemailer = require('nodemailer');
} catch {
    /* dependency optional at boot */
}

/**
 *   EmailService — SMTP delivery for system notifications.
 *
 *   Configuration is sourced from the App Settings table (editable from the
 *   Settings UI) and falls back to SMTP_* environment variables. Delivery is
 *   gated by the `enableEmailNotifications` master switch; if SMTP is not
 *   configured or nodemailer is unavailable, sends are skipped gracefully and
 *   never throw into the calling request.
 *
 *   Per-domain triggers (workflow / validation / talent / lifecycle / coaching
 *   / auth) are toggled by the `emailOn*` settings — see isCategoryEnabled.
 */
class EmailService {
    constructor() {
        this._transport = null;
        this._signature = null; // config fingerprint — rebuild transport when it changes
    }

    // setting (DB) wins when non-empty; otherwise fall back to the env var.
    async _val(key, envName, fallback = '') {
        const v = await AppSettingsModel.getValue(key, null);
        if (v !== null && v !== undefined && String(v).trim() !== '') return v;
        const e = envName ? process.env[envName] : undefined;
        if (e !== undefined && String(e).trim() !== '') return e;
        return fallback;
    }

    /** Resolve the effective SMTP configuration (DB settings + env fallback). */
    async getConfig() {
        const host = await this._val('smtpHost', 'SMTP_HOST', '');
        const port = Number(await this._val('smtpPort', 'SMTP_PORT', 587)) || 587;
        const secure = await AppSettingsModel.getValue('smtpSecure', port === 465);
        const user = await this._val('smtpUser', 'SMTP_USER', '');
        const pass = await this._val('smtpPassword', 'SMTP_PASS', '');
        const fromName = await this._val('smtpFromName', null, PRODUCT.name);
        const fromAddress = await this._val('smtpFromAddress', null, user);

        // SMTP_FROM (env) may be a combined "Name <addr>" value; honour it when
        // no explicit from-address setting is present.
        let from;
        if (fromAddress) {
            from = fromName ? `"${fromName}" <${fromAddress}>` : fromAddress;
        } else {
            from = process.env.SMTP_FROM || '';
        }

        return { host, port, secure: Boolean(secure), user, pass, from, fromAddress };
    }

    /** Master switch + minimal config present (host). */
    async isEnabled() {
        if (!nodemailer) return false;
        const master = await AppSettingsModel.getValue('enableEmailNotifications', false);
        if (!master) return false;
        const cfg = await this.getConfig();
        return Boolean(cfg.host);
    }

    /**
     * Whether email should fire for a given event domain. Requires the master
     * switch AND the per-domain toggle. Unknown/blank categories pass through
     * once the master switch is on.
     */
    async isCategoryEnabled(category) {
        if (!(await this.isEnabled())) return false;
        if (!category) return true;
        // [setting-key, default]. The default encodes the "no-mailbox-invasion"
        // policy: action/obligation domains send immediately (ON); engagement/
        // ambient domains (recognition, mobility, surveys) are in-app + daily-digest
        // only (OFF) so kudos never trigger a real-time email. auth stays OFF here
        // because security mails are sent by their own transactional paths.
        const map = {
            workflow: ['emailOnWorkflow', true],
            reviews: ['emailOnReviews', false],
            validation: ['emailOnValidation', true],
            talent: ['emailOnTalentActions', true],
            lifecycle: ['emailOnLifecycle', true],
            coaching: ['emailOnCoaching', true],
            compliance: ['emailOnCompliance', true],
            disputes: ['emailOnDisputes', true],
            access: ['emailOnAccess', true],
            digest: ['emailOnDigest', true],
            auth: ['emailOnAuth', false],
            // 3.23.20 (C2f): security alerts to SuperAdmins (break-glass sign-in,
            // refused SuperAdmin SSO, SuperAdmin MFA change) — ON by default.
            security: ['emailOnSecurityAlerts', true],
            engagement: ['emailOnEngagement', false],
            mobility: ['emailOnMobility', false],
            survey: ['emailOnSurvey', false],
        };
        const entry = map[category];
        // Unknown category → no immediate email (fail closed against inbox spam);
        // the in-app notification is always written regardless.
        if (!entry) return false;
        return Boolean(await AppSettingsModel.getValue(entry[0], entry[1]));
    }

    async _getTransport() {
        if (!nodemailer) return null;
        const cfg = await this.getConfig();
        if (!cfg.host) return null;

        const sig = JSON.stringify({
            h: cfg.host,
            p: cfg.port,
            s: cfg.secure,
            u: cfg.user,
            pw: cfg.pass,
        });
        if (this._transport && this._signature === sig) return this._transport;

        const options = {
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
        };
        if (cfg.user || cfg.pass) {
            options.auth = { user: cfg.user, pass: cfg.pass };
        }
        this._transport = nodemailer.createTransport(options);
        this._signature = sig;
        return this._transport;
    }

    /** Drop the cached transport so the next send re-reads settings. */
    invalidate() {
        this._transport = null;
        this._signature = null;
    }

    /**
     * Send an email. Never throws — returns a small status object so callers
     * (background notifications) can record the outcome without try/catch.
     * @returns {Promise<{sent:boolean, skipped?:string, error?:string, messageId?:string}>}
     */
    async send({ to, subject, html, text, attachments }) {
        if (!nodemailer) return { sent: false, skipped: 'nodemailer_missing' };
        if (!to) return { sent: false, skipped: 'no_recipient' };
        if (!(await this.isEnabled())) return { sent: false, skipped: 'disabled' };

        const cfg = await this.getConfig();
        const transport = await this._getTransport();
        if (!transport) return { sent: false, skipped: 'not_configured' };

        try {
            const info = await transport.sendMail({
                from: cfg.from || cfg.user || PRODUCT.defaultMailFrom,
                to,
                subject: subject || '(no subject)',
                text: text || (html ? html.replace(/<[^>]+>/g, ' ') : ''),
                html: html || undefined,
                // nodemailer-native attachments (e.g. scheduled report CSVs).
                attachments:
                    Array.isArray(attachments) && attachments.length ? attachments : undefined,
            });
            return { sent: true, messageId: info && info.messageId };
        } catch (error) {
            // Best-effort audit; never propagate the failure to business logic.
            try {
                await LogService.log({
                    adminId: null,
                    action: 'EMAIL_FAILED',
                    entityType: 'email',
                    details: `Email to ${to} failed: ${error.message}`,
                });
            } catch {
                /* ignore */
            }
            return { sent: false, error: error.message };
        }
    }

    /** Verify SMTP credentials/connectivity (used by the "send test" action). */
    async verify() {
        if (!nodemailer) return { ok: false, error: 'nodemailer not installed' };
        const cfg = await this.getConfig();
        if (!cfg.host) return { ok: false, error: 'SMTP host is not configured' };
        const transport = await this._getTransport();
        if (!transport) return { ok: false, error: 'SMTP transport unavailable' };
        try {
            await transport.verify();
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }

    /** Send a diagnostic email to confirm configuration end-to-end. */
    async sendTest(to) {
        const cfg = await this.getConfig();
        const subject = 'IDevelop — test email';
        const html = `
            <p>This is a test message from <strong>IDevelop</strong>.</p>
            <p>If you received this, outgoing email notifications are configured correctly.</p>
            <hr>
            <p style="color:#777;font-size:12px">
                Host: ${cfg.host || '(unset)'} · Port: ${cfg.port} · Secure: ${cfg.secure ? 'yes' : 'no'}
            </p>`;
        // Bypass the master switch for the test so admins can validate before enabling.
        const transport = await this._getTransport();
        if (!transport) return { sent: false, error: 'SMTP host is not configured' };
        try {
            const info = await transport.sendMail({
                from: cfg.from || cfg.user || PRODUCT.defaultMailFrom,
                to,
                subject,
                html,
                text: 'Test message from IDevelop. Email notifications are configured correctly.',
            });
            return { sent: true, messageId: info && info.messageId };
        } catch (error) {
            return { sent: false, error: error.message };
        }
    }
}

module.exports = new EmailService();
