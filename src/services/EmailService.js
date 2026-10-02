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

        // ONE named relay host may be reached without TLS (see plaintextDecision).
        const plaintextRelayHost = String(
            (await AppSettingsModel.getValue('smtpPlaintextRelayHost', '')) || ''
        )
            .trim()
            .toLowerCase();
        return {
            host,
            port,
            secure: Boolean(secure),
            user,
            pass,
            from,
            fromAddress,
            plaintextRelayHost,
        };
    }

    /** Resolve a host (an IP literal passes through). Stubbable in tests. */
    async _resolve(host) {
        const net = require('net');
        const h = String(host || '').replace(/^\[|\]$/g, '');
        const fam = net.isIP(h);
        if (fam) return [{ address: h, family: fam }];
        return require('dns').promises.lookup(h, { all: true, verbatim: true });
    }

    /**
     * How this connection may be made:
     *   { mode: 'tls' }       implicit TLS (secure)
     *   { mode: 'starttls' }  STARTTLS REQUIRED: the default for every host
     *   { mode: 'relay', pinned }
     *                         the ONE named relay, resolved NOW to private /
     *                         loopback addresses only, connected to the pinned IP;
     *                         STARTTLS still required when credentials are set
     *   { mode: 'refused', error }  the named relay resolves to a public address
     */
    async plaintextDecision(cfg) {
        if (cfg.secure) return { mode: 'tls' };
        const host = String(cfg.host || '')
            .trim()
            .toLowerCase();
        if (!cfg.plaintextRelayHost || cfg.plaintextRelayHost !== host) return { mode: 'starttls' };
        let addrs;
        try {
            addrs = await this._resolve(host);
        } catch (_) {
            return { mode: 'refused', error: `SMTP relay ${host} cannot be resolved; not sent.` };
        }
        const { isPrivateAddress } = require('./SamlMetadataService');
        if (!addrs || !addrs.length || !addrs.every((a) => isPrivateAddress(a.address)))
            return {
                mode: 'refused',
                error: `SMTP relay ${host} does not resolve to a private or loopback address: an unencrypted connection to it is refused; nothing was sent.`,
            };
        return { mode: 'relay', pinned: { address: addrs[0].address, family: addrs[0].family } };
    }

    /**
     * The nodemailer transport options. Not implicit TLS: STARTTLS REQUIRED
     * (`requireTLS`). nodemailer otherwise sends AUTH and the mail in clear
     * whenever the server does not offer STARTTLS, or when an attacker strips
     * it. The only exception is the named plaintext relay (decision.mode
     * 'relay'), connected at its pinned private IP; even there SMTP AUTH
     * credentials are NEVER sent in clear: with a user/password set, STARTTLS
     * stays required and a relay without it refuses to send. Certificate
     * checks stay on.
     */
    transportOptions(cfg, decision = { mode: cfg.secure ? 'tls' : 'starttls' }) {
        const options = { host: cfg.host, port: cfg.port, secure: cfg.secure };
        const hasAuth = !!(cfg.user || cfg.pass);
        if (!cfg.secure) {
            const relay = decision && decision.mode === 'relay';
            options.requireTLS = !(relay && !hasAuth);
            if (relay) {
                options.host = decision.pinned.address; // the address that was checked
                options.tls = { servername: String(cfg.host) }; // certificate still checked by NAME
            }
        }
        if (hasAuth) options.auth = { user: cfg.user, pass: cfg.pass };
        return options;
    }

    /** For the settings page and the admin dashboard warning. */
    async plaintextRelayStatus() {
        const host = String((await AppSettingsModel.getValue('smtpPlaintextRelayHost', '')) || '');
        if (!host) return { active: false };
        let setBy = await AppSettingsModel.getValue('smtpPlaintextRelaySetBy', null);
        if (typeof setBy === 'string') {
            try {
                setBy = JSON.parse(setBy);
            } catch (_) {
                setBy = null;
            }
        }
        return {
            active: true,
            host,
            reason: String((await AppSettingsModel.getValue('smtpPlaintextRelayReason', '')) || ''),
            setBy: setBy || null,
        };
    }

    /**
     * Name (or clear, with host '') the ONE plaintext relay. SuperAdmin only,
     * mandatory reason, audited (who / when / reason).
     */
    async setPlaintextRelay(actor, { host, reason } = {}) {
        if (!actor || actor.role !== 'superadmin') return { ok: false, code: 'superadmin_only' };
        const h = String(host || '')
            .trim()
            .toLowerCase();
        const why = String(reason || '').trim();
        if (why.length < 10) return { ok: false, code: 'reason_required' };
        if (h && !/^(\[[0-9a-f:]+\]|[a-z0-9.-]+|[0-9a-f:]+)$/i.test(h))
            return { ok: false, code: 'bad_host' };
        const at = new Date().toISOString();
        const who = { id: actor.id || null, username: actor.username || null, at };
        await AppSettingsModel.setValue(
            'smtpPlaintextRelayHost',
            h,
            'string',
            'The ONE SMTP relay reachable without TLS (private/loopback address checked at connect time; set by a SuperAdmin with a reason)',
            'email',
            actor.id || null
        );
        await AppSettingsModel.setValue(
            'smtpPlaintextRelayReason',
            h ? why : '',
            'string',
            'Why the plaintext SMTP relay was allowed',
            'email',
            actor.id || null
        );
        await AppSettingsModel.setValue(
            'smtpPlaintextRelaySetBy',
            h ? who : null,
            'json',
            'Who allowed the plaintext SMTP relay, and when',
            'email',
            actor.id || null
        );
        this.invalidate();
        try {
            await LogService.log({
                adminId: actor.id || null,
                action: h ? 'SMTP_PLAINTEXT_RELAY_SET' : 'SMTP_PLAINTEXT_RELAY_CLEARED',
                entityType: 'appSetting',
                category: 'security',
                details: h
                    ? `Plaintext SMTP relay allowed for ${h} by ${actor.username || actor.id} at ${at}. Reason: ${why}`
                    : `Plaintext SMTP relay withdrawn by ${actor.username || actor.id} at ${at}. Reason: ${why}`,
                severity: 'warning',
            });
        } catch (_) {
            /* audit best-effort */
        }
        return { ok: true, host: h, setBy: who };
    }

    /** A clear message when credentials would have needed a plaintext channel. */
    _explain(error, cfg) {
        const msg = String((error && error.message) || error || '');
        if (cfg && !cfg.secure && (cfg.user || cfg.pass) && /starttls|tls/i.test(msg))
            return `SMTP credentials are never sent over an unencrypted connection, and ${cfg.host} did not offer TLS (STARTTLS); nothing was sent. Remove the SMTP user/password for an unauthenticated internal relay, or enable TLS on the server. (${msg})`;
        return msg;
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

        // Resolved on every call so the pinned relay IP follows DNS, and is
        // re-checked (private/loopback) each time it changes.
        const decision = await this.plaintextDecision(cfg);
        this._refusal = decision.mode === 'refused' ? decision.error : null;
        if (decision.mode === 'refused') {
            this.invalidate();
            return null;
        }
        const sig = JSON.stringify({
            h: cfg.host,
            p: cfg.port,
            s: cfg.secure,
            u: cfg.user,
            pw: cfg.pass,
            m: decision.mode,
            ip: decision.pinned ? decision.pinned.address : null,
        });
        if (this._transport && this._signature === sig) return this._transport;

        this._transport = nodemailer.createTransport(this.transportOptions(cfg, decision));
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
        if (!transport && this._refusal) return { sent: false, error: this._refusal };
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
                    details: `Email to ${to} failed: ${this._explain(error, cfg)}`,
                });
            } catch {
                /* ignore */
            }
            return { sent: false, error: this._explain(error, cfg) };
        }
    }

    /** Verify SMTP credentials/connectivity (used by the "send test" action). */
    async verify() {
        if (!nodemailer) return { ok: false, error: 'nodemailer not installed' };
        const cfg = await this.getConfig();
        if (!cfg.host) return { ok: false, error: 'SMTP host is not configured' };
        const transport = await this._getTransport();
        if (!transport) return { ok: false, error: this._refusal || 'SMTP transport unavailable' };
        try {
            await transport.verify();
            return { ok: true };
        } catch (error) {
            return { ok: false, error: this._explain(error, cfg) };
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
        if (!transport)
            return { sent: false, error: this._refusal || 'SMTP host is not configured' };
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
            return { sent: false, error: this._explain(error, cfg) };
        }
    }
}

module.exports = new EmailService();
