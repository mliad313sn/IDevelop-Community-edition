'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const AdminModel = require('../models/AdminModel');
const EmployeeModel = require('../models/EmployeeModel');
const PasswordHistoryModel = require('../models/PasswordHistoryModel');
const SessionService = require('./SessionService');

// Best-practice self-service password reset.
//  - Token = 32 random bytes (CSPRNG), base64url. The RAW token is returned to the
//    caller ONCE (to email); only sha256(token) is persisted.
//  - Short TTL, single-use. Consuming a token revokes ALL of that user's sessions.
//  - Resolution is by username (admin first, then employee) OR by e-mail — and an
//    e-mail may belong to SEVERAL accounts (migration 107): every eligible account
//    carrying the address gets its own token and its own link, so no account is
//    ever silently unrecoverable because another one shares its address.
//  - Callers must treat "found" and "not found" identically (anti-enumeration).

const TTL_MINUTES = 30;
const BCRYPT_COST = 10; // matches the rest of the app (AuthService/EmployeeAuthService)

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const lower = (s) =>
    String(s == null ? '' : s)
        .trim()
        .toLowerCase();

function adminSubject(admin) {
    if (!admin) return null;
    // password_disabled (SSO merge) is refused for the same reason as the employee rules below.
    if (
        admin.isActive === false ||
        admin.passwordDisabled === true ||
        admin.password_disabled === true
    )
        return null;
    return { subjectType: 'admin', subjectId: admin.id, email: admin.email, name: admin.username };
}

function employeeSubject(emp) {
    if (!emp) return null;
    // Self-service reset serves accounts that could actually LOG IN afterwards.
    //   - a LEAVER (is_active=false): proven able to obtain a token before this
    //     guard — the login gate blocked them anyway, but a departure must not
    //     receive credentials mail (same rule as resend-credentials).
    //   - a DISABLED login (is_account_active=false): resetting would set a
    //     password on an account an administrator deliberately switched off.
    //   - SSO-only (password_disabled): the reset would complete and the login
    //     would still refuse the password — a flow that cannot succeed.
    // The HTTP response stays the same generic sentence either way, so none of
    // this is enumerable from outside.
    const inactive = emp.isActive === false || emp.is_active === false;
    const loginOff = emp.isAccountActive === false || emp.is_account_active === false;
    const ssoOnly = emp.passwordDisabled === true || emp.password_disabled === true;
    if (inactive || loginOff || ssoOnly) return null;
    return {
        subjectType: 'employee',
        subjectId: emp.id,
        email: emp.email,
        name: emp.username || emp.employeeNumber,
    };
}

/**
 * Every eligible account the identifier designates. A username names exactly one
 * account (admin first, mirroring login's auto-detection); an e-mail address may
 * name several, across admins AND employees — all of them are served.
 */
async function resolveSubjects(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return [];
    const byUsername =
        adminSubject(await AdminModel.findByUsername(id).catch(() => null)) ||
        employeeSubject(await EmployeeModel.findByUsername(id).catch(() => null));
    if (byUsername) return [byUsername];
    if (!id.includes('@')) return [];
    const e = lower(id);
    const out = [];
    const admins = await db
        .all('SELECT * FROM admins WHERE lower(email) = ? ORDER BY id', [e])
        .catch(() => []);
    for (const a of admins) {
        const s = adminSubject(a);
        if (s) out.push(s);
    }
    const emps = await db
        .all('SELECT * FROM employees WHERE lower(email) = ? ORDER BY id', [e])
        .catch(() => []);
    for (const emp of emps) {
        const s = employeeSubject(emp);
        if (s) out.push(s);
    }
    return out;
}

class PasswordResetService {
    /**
     * Create a reset token for EVERY eligible account matching `identifier`.
     * Always resolves without throwing. `resets` lists one {rawToken, name,
     * subjectType, subjectId} per account that has an e-mail to send to; the
     * first one is also exposed as rawToken/name/subjectType for older callers.
     * The caller MUST render the same response either way (anti-enumeration).
     */
    async requestReset(identifier, requestIp = null) {
        await this._pruneExpired();
        // 3.23.19 (amendment A1): while SSO is enforced only an active SuperAdmin
        // may reset a password — nobody else is minted a token or sent a mail. The
        // controller still answers the same generic sentence (anti-enumeration).
        const subjects = [];
        for (const s of (await resolveSubjects(identifier)).filter((x) => x.email)) {
            // eslint-disable-next-line no-await-in-loop
            if (await this.resetAllowed(s.subjectType, s.subjectId)) subjects.push(s);
        }
        if (!subjects.length) {
            const any = await resolveSubjects(identifier);
            return any.length
                ? { sent: false, reason: 'no_email', resets: [] }
                : { sent: false, resets: [] };
        }
        const resets = [];
        for (const subject of subjects) {
            // Invalidate any outstanding tokens for this subject, then mint a fresh one.
            // Raw SQL uses native snake_case (the compat layer does not reliably rewrite
            // a new camelCase table name); result keys still come back camelCased.
            await db.run(
                'DELETE FROM password_reset_tokens WHERE subject_type = ? AND subject_id = ? AND used_at IS NULL',
                [subject.subjectType, subject.subjectId]
            );
            const rawToken = crypto.randomBytes(32).toString('base64url');
            const expires = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
            await db.run(
                `INSERT INTO password_reset_tokens (subject_type, subject_id, token_hash, expires_at, request_ip)
                 VALUES (?, ?, ?, ?, ?)`,
                [subject.subjectType, subject.subjectId, sha256(rawToken), expires, requestIp]
            );
            resets.push({
                rawToken,
                email: subject.email,
                name: subject.name,
                subjectType: subject.subjectType,
                subjectId: subject.subjectId,
            });
        }
        const first = resets[0];
        return {
            sent: true,
            resets,
            rawToken: first.rawToken,
            email: first.email,
            name: first.name,
            subjectType: first.subjectType,
            ttlMinutes: TTL_MINUTES,
        };
    }

    /** Validate a raw token; returns {subjectType, subjectId} or null (expired/used/unknown). */
    async validate(rawToken) {
        if (!rawToken) return null;
        const row = await db.get(
            `SELECT id, subject_type, subject_id FROM password_reset_tokens
              WHERE token_hash = ? AND used_at IS NULL AND expires_at > now()
              LIMIT 1`,
            [sha256(rawToken)]
        );
        if (!row) return null;
        // A token minted before SSO enforcement began no longer opens a
        // non-SuperAdmin account.
        if (!(await this.resetAllowed(row.subjectType, row.subjectId))) return null;
        return { tokenId: row.id, subjectType: row.subjectType, subjectId: row.subjectId };
    }

    /** A1 — may this account reset its password right now? Always, unless SSO is enforced. */
    async resetAllowed(subjectType, subjectId) {
        let enforced = false;
        try {
            enforced = require('./AdminSsoService').isEnforced();
        } catch (_) {
            enforced = false;
        }
        if (!enforced) return true;
        // EXC (3.23.21): an employee a SuperAdmin listed as an SSO exception signs
        // in with a password, so may reset it.
        if (subjectType === 'employee')
            return require('./AdminSsoService').hasSsoException(subjectId);
        if (subjectType !== 'admin') return false;
        const a = await db.get('SELECT role, is_active FROM admins WHERE id = ?', [
            Number(subjectId),
        ]);
        return !!a && a.role === 'superadmin' && (a.isActive ?? a.is_active) !== false;
    }

    /**
     * Consume a token: set the new password, mark the token used, revoke every
     * session for that user, and drop that user's other tokens. Returns
     * {ok:true, subjectType} or {ok:false, reason}.
     */
    async consume(rawToken, newPassword) {
        const v = await this.validate(rawToken);
        if (!v) return { ok: false, reason: 'invalid_or_expired' };

        const passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_COST);

        await db
            .runTransaction(async () => {
                // Re-check inside the tx and claim the token (single-use, race-safe).
                const claim = await db.run(
                    `UPDATE password_reset_tokens SET used_at = now()
                  WHERE id = ? AND used_at IS NULL AND expires_at > now()`,
                    [v.tokenId]
                );
                if (!claim || !claim.changes) throw new Error('token_already_used');

                if (v.subjectType === 'admin') {
                    await AdminModel.update(v.subjectId, {
                        passwordHash,
                        passwordChangedAt: new Date().toISOString(),
                        forcePasswordChange: false, // the user chose this password themselves
                    });
                    await PasswordHistoryModel.addPassword(v.subjectId, passwordHash);
                } else {
                    await EmployeeModel.update(v.subjectId, { passwordHash });
                }
                // Burn any other outstanding tokens for this subject.
                await db.run(
                    'DELETE FROM password_reset_tokens WHERE subject_type = ? AND subject_id = ? AND id <> ?',
                    [v.subjectType, v.subjectId, v.tokenId]
                );
            })
            .catch((e) => {
                throw e;
            });

        // The old password is dead — force the account off every device.
        // `resolveSubjects` only ever yields 'admin' or 'employee', but a live
        // session for an employee who governs anyone is typed 'manager', because
        // `deserializeUser` recomputes the type on every request. Revoking a single
        // bucket left 20 of the 77 people here signed in with the very password
        // that had just been reset — the one thing a reset exists to prevent.
        // EmployeeController, DSRService and LifecycleService all revoke both.
        try {
            await SessionService.revokeAllForUser(v.subjectId, v.subjectType, null);
            if (v.subjectType === 'employee') {
                await SessionService.revokeAllForUser(v.subjectId, 'manager', null);
            }
        } catch (e) {
            console.error('Session revoke on password reset failed:', e.message);
        }
        // C2c (3.23.20): a SuperAdmin's password reset NEVER touches its MFA (the
        // next sign-in still asks for the code) and every SuperAdmin is told.
        if (v.subjectType === 'admin') {
            try {
                const a = await db.get('SELECT id, username, role FROM admins WHERE id = ?', [
                    Number(v.subjectId),
                ]);
                if (a && a.role === 'superadmin')
                    await require('./SuperadminAlertService').alert(
                        'security.superadmin_password_reset',
                        {
                            targetAdminId: Number(a.id),
                            username: a.username,
                            detail: 'password reset by e-mail link (two-factor unchanged)',
                        }
                    );
            } catch (_) {
                /* the alert never undoes the reset */
            }
        }

        return { ok: true, subjectType: v.subjectType, subjectId: v.subjectId };
    }

    /**
     * Burn every OUTSTANDING (unused) reset token of one account. Throws on a DB
     * error so a caller that must fail closed can.
     * @returns {Promise<number>} tokens invalidated
     */
    async invalidateOutstanding(subjectType, subjectId) {
        const r = await db.run(
            'DELETE FROM password_reset_tokens WHERE subject_type = ? AND subject_id = ? AND used_at IS NULL',
            [subjectType, Number(subjectId)]
        );
        return (r && r.changes) || 0;
    }

    /**
     * An account's e-mail address changed (3.23.17, A-3). The address is where
     * the reset link goes, so a change of address is a change of who can take the
     * account over:
     *   1. every outstanding reset token of the account is invalidated;
     *   2. the OLD address is told (best-effort, never awaited on the request
     *      path, never throws) — the owner learns of a takeover attempt.
     * @param {'admin'|'employee'} subjectType
     * @param {object} opts {oldEmail, newEmail, t (i18n), name}
     */
    async onEmailChanged(
        subjectType,
        subjectId,
        { oldEmail = null, newEmail = null, t = null, name = '' } = {}
    ) {
        const out = { tokensInvalidated: null, oldAddressNotified: false };
        try {
            out.tokensInvalidated = await this.invalidateOutstanding(subjectType, subjectId);
        } catch (e) {
            console.error(
                '[PasswordReset] could not invalidate tokens after e-mail change:',
                e && e.message
            );
        }
        const before = lower(oldEmail);
        if (before && before !== lower(newEmail)) {
            const tr = (k, fb, p) =>
                typeof t === 'function' ? t(k, { defaultValue: fb, ...(p || {}) }) : fb;
            const newShown = newEmail
                ? String(newEmail).trim()
                : tr('auth:email_changed_removed', '(aucune)');
            try {
                const EmailService = require('./EmailService');
                // Fire and forget: SMTP latency or failure must never block the edit.
                Promise.resolve(
                    EmailService.send({
                        to: String(oldEmail).trim(),
                        subject: tr(
                            'auth:email_changed_subject',
                            'Votre adresse e-mail de connexion a été modifiée'
                        ),
                        text: tr(
                            'auth:email_changed_body',
                            'Bonjour {{name}},\n\nL’adresse e-mail associée à votre compte vient d’être remplacée par : {{newEmail}}.\nLes liens de réinitialisation de mot de passe seront désormais envoyés à cette adresse.\n\nSi vous n’êtes pas à l’origine de ce changement, contactez immédiatement votre administrateur.',
                            {
                                name: name || '',
                                newEmail: newShown,
                                interpolation: { escapeValue: false },
                            }
                        ),
                    })
                ).catch(() => {});
                out.oldAddressNotified = true;
            } catch (_) {
                /* best-effort */
            }
        }
        return out;
    }

    async _pruneExpired() {
        try {
            await db.run(
                'DELETE FROM password_reset_tokens WHERE expires_at < now() OR used_at IS NOT NULL'
            );
        } catch (_) {
            /* best-effort housekeeping */
        }
    }
}

module.exports = new PasswordResetService();
module.exports.resolveSubjects = resolveSubjects;
