'use strict';

/**
 * OnboardingCredentialService — open an employee's login and tell them how to
 * get in, in a bilingual (FR/EN) onboarding message.
 *
 * A PASSWORD IS NEVER SENT BY E-MAIL (SA-37).
 *   1. Ensure a unique username (kept if one exists, else generated from the
 *      identity via credentialGenerator).
 *   2a. E-mail possible: the account receives a random password that nobody
 *       knows, and the person receives their USERNAME and a one-time
 *       « Définir mon mot de passe / Set my password » link, valid 72 hours.
 *       The link is a token of the password-reset machinery
 *       (PasswordResetService.issueSetupToken: sha256 at rest, claimed once
 *       by consume()). No migration is needed.
 *   2b. No address, e-mail off, or the send failed: a temporary password is
 *       generated and returned ONCE for the administrator's one-time
 *       credentials sheet; force_password_change makes the person replace it
 *       at first sign-in. It is never mailed, never stored in clear and never
 *       logged.
 *   3. Audit CREDENTIALS_ISSUED, never with the password or the link.
 */

const crypto = require('crypto');
const PRODUCT = require('../config/product');
const bcrypt = require('bcrypt');
const EmployeeModel = require('../models/EmployeeModel');
const EmailService = require('./EmailService');
const LogService = require('./LogService');
const { generatePassword, baseUsername, uniqueUsername } = require('../utils/credentialGenerator');

/** The set-password link lives 72 hours. */
const SETUP_TTL_HOURS = 72;

/** « 05/10/2026 14:30 » / « 2026-10-05 14:30 » in server local time. */
function expiryLabels(d) {
    const p = (n) => String(n).padStart(2, '0');
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return {
        fr: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${time}`,
        en: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`,
    };
}

/** The credential block of both mails: username, the link and its expiry. */
function setupBlocks(T, { username, link, expiresAt, branding }) {
    const when = expiryLabels(expiresAt);
    return [
        T.details([['Identifiant / Username', username]]),
        T.para(
            'Choisissez vous-même votre mot de passe avec le bouton ci-dessous. Aucun mot de passe ne vous est envoyé par e-mail.',
            'Choose your own password with the button below. No password is ever sent to you by e-mail.'
        ),
        T.cta(
            'Définir mon mot de passe',
            'Set my password',
            link,
            branding && branding.accentColor
        ),
        T.para(
            `Ce lien sert une seule fois et expire dans ${SETUP_TTL_HOURS} heures (le ${when.fr}).`,
            `This link works once and expires in ${SETUP_TTL_HOURS} hours (${when.en}).`
        ),
        T.para(
            'Lien expiré ? Utilisez « Mot de passe oublié » sur la page de connexion, ou demandez une nouvelle invitation à votre administrateur.',
            'Link expired? Use "Forgot password" on the sign-in page, or ask your administrator for a new invitation.'
        ),
    ];
}

/** The plain-text twin of setupBlocks. */
function setupText({ username, link, expiresAt }) {
    const when = expiryLabels(expiresAt);
    return (
        `Identifiant / Username: ${username}\n` +
        `Définir mon mot de passe / Set my password: ${link}\n` +
        `Lien à usage unique, valable ${SETUP_TTL_HOURS} heures (jusqu'au ${when.fr}). / ` +
        `Single-use link, valid ${SETUP_TTL_HOURS} hours (until ${when.en}).\n` +
        `Aucun mot de passe n'est envoyé par e-mail. / No password is ever sent by e-mail.`
    );
}

class OnboardingCredentialService {
    /**
     * Full WELCOME onboarding email (bulk invitation flow): what the platform
     * is, the person's own profile details, what is expected of them (adapted
     * to employee vs manager), their username and the one-time set-password
     * link. Never a password. Built on the shared branded template.
     */
    async _welcomeEmail({ employee, username, link, expiresAt, branding }) {
        const T = require('../utils/emailTemplate');
        const db = require('../config/database');
        const appUrl = require('../utils/emailTemplate').baseUrl();
        const appName = (branding && branding.appName) || PRODUCT.name;

        // Profile details (org placement + who reviews them).
        let detail = null,
            managerName = null;
        try {
            detail = await db.get(
                `SELECT full_name, site_name, department_name, service_name, role_name
                   FROM v_employee_details WHERE employee_id = ?`,
                [employee.id]
            );
            const mgr = await db.get(
                `SELECT sup.first_name || ' ' || sup.last_name AS name
                   FROM employees e JOIN employees sup
                     ON sup.id = COALESCE(e.supervisor_id, CASE WHEN e.manager_type = 'employee' THEN e.manager_id END)
                  WHERE e.id = ?`,
                [employee.id]
            );
            managerName = mgr && mgr.name;
        } catch {
            /* details best-effort */
        }

        const isManager = await db
            .get(
                `SELECT 1 AS x FROM employees r
              WHERE r.is_active AND (r.supervisor_id = ? OR (r.manager_id = ? AND r.manager_type = 'employee')) LIMIT 1`,
                [employee.id, employee.id]
            )
            .then((r) => !!r)
            .catch(() => false);

        const blocks = [];
        blocks.push(
            T.para(
                `Bienvenue ! ${appName} est la plateforme de compétences, de talents et de conformité de votre organisation : vous y évaluez vos compétences, suivez votre progression et votre développement, et restez informé de ce qui vous concerne.`,
                `Welcome! ${appName} is your organization's skills, talent & compliance platform: you rate your skills, follow your progression and development, and stay informed.`
            )
        );

        blocks.push(T.section('Votre profil', 'Your profile'));
        blocks.push(
            T.details([
                [
                    'Nom / Name',
                    (detail && detail.fullName) || `${employee.firstName} ${employee.lastName}`,
                ],
                ['Matricule / Employee #', employee.employeeNumber],
                ...(detail && detail.roleName ? [['Poste / Role', detail.roleName]] : []),
                ...(detail && detail.siteName ? [['Site', detail.siteName]] : []),
                ...(detail && detail.departmentName
                    ? [['Département / Department', detail.departmentName]]
                    : []),
                ...(detail && detail.serviceName ? [['Service', detail.serviceName]] : []),
                ...(managerName ? [['Responsable / Reviewed by', managerName]] : []),
                [
                    'Profil / Profile',
                    isManager ? 'Manager / Superviseur' : 'Collaborateur / Employee',
                ],
            ])
        );

        blocks.push(T.section('Ce qui est attendu de vous', 'What is expected from you'));
        const expected = [
            {
                fr: 'Choisissez votre mot de passe avec le lien « Définir mon mot de passe » ci-dessous, puis connectez-vous.',
                en: 'Choose your password with the "Set my password" link below, then sign in.',
            },
            {
                fr: 'Complétez votre auto-évaluation : pour chaque compétence de votre poste, votre niveau honnête de 0 à 4 — un niveau bas sert à planifier des formations, pas à juger.',
                en: 'Complete your self-assessment: your honest 0–4 level per skill — low levels drive training, not judgement.',
            },
            {
                fr: 'Soumettez pour revue, suivez votre statut (Mon statut) et répondez aux demandes de modification.',
                en: 'Submit for review, track your status and respond to change requests.',
            },
            {
                fr: 'Consultez « Ma progression » pour voir votre évolution campagne après campagne.',
                en: 'Open "My Progression" to see your growth campaign over campaign.',
            },
            {
                fr: 'Surveillez la cloche 🔔 : rappels de campagne, plans de développement et notifications vous y attendent.',
                en: 'Watch the 🔔 bell: campaign reminders, development plans and notifications land there.',
            },
        ];
        if (isManager) {
            expected.push(
                {
                    fr: 'En tant que manager : examinez les auto-évaluations de votre équipe, menez les revues et le coaching, et suivez la conformité (certifications, couverture) de vos unités.',
                    en: 'As a manager: review your team’s self-assessments, run reviews and coaching, and watch your units’ compliance.',
                },
                {
                    fr: 'Votre récapitulatif d’équipe arrive chaque semaine — l’objectif est un récapitulatif vide.',
                    en: 'Your weekly team digest arrives every Monday — the goal is an empty digest.',
                }
            );
        }
        blocks.push(T.steps(expected));

        blocks.push(T.section('Votre accès', 'Your access'));
        blocks.push(...setupBlocks(T, { username, link, expiresAt, branding }));
        blocks.push(
            T.para(
                'Besoin d’aide ? Le Guide utilisateur est dans le menu de votre profil une fois connecté.',
                'Need help? The User Guide lives in your profile menu once signed in.'
            )
        );

        return {
            subject: `[${appName}] Bienvenue — vos accès / Welcome — your account`,
            html: T.wrap({
                branding,
                title: 'Bienvenue / Welcome',
                intro: `Bonjour ${employee.firstName},`,
                blocks,
            }),
            text:
                `Bienvenue sur ${appName} / Welcome to ${appName}.\n` +
                setupText({ username, link, expiresAt }) +
                (appUrl ? `\nConnexion / Sign in: ${appUrl}/login` : ''),
        };
    }

    /** The short credentials mail (single resend): username + set-password link. */
    _setupEmail({ employee, username, link, expiresAt, branding }) {
        const T = require('../utils/emailTemplate');
        const appName = (branding && branding.appName) || PRODUCT.name;
        return {
            subject: `[${appName}] Définissez votre mot de passe / Set your password`,
            html: T.wrap({
                branding,
                title: 'Votre accès / Your access',
                intro: `Bonjour ${employee.firstName},`,
                blocks: [
                    T.para('Votre accès est ouvert.', 'Your access is open.'),
                    ...setupBlocks(T, { username, link, expiresAt, branding }),
                ],
            }),
            text: setupText({ username, link, expiresAt }),
        };
    }

    /**
     * Issue (or re-issue) credentials for an employee and send the onboarding
     * email. Returns { success, username, emailed, message? }.
     *
     * @param employeeId  target employee
     * @param actor       req.user performing the action (for the audit trail)
     * @param req         the request (ip / user-agent for the audit trail)
     * @param opts.welcome  true → full welcome/invitation email (system intro,
     *                      profile details, expectations) instead of the short
     *                      credentials-only mail.
     * @param opts.allowNoEmail  a person WITHOUT an address may
     *                      still be issued credentials — nothing is mailed and
     *                      the temp password comes back ONCE for the one-time
     *                      credentials sheet (reason 'no_email'). Without this
     *                      flag the historical refusal stands.
     * Refusals carry a stable `code` (translated by the caller as
     * admin:acc_err_<code>) beside the English `message` kept for API callers.
     */
    async issueAndSend(employeeId, actor, req, { welcome = false, allowNoEmail = false } = {}) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee) return { success: false, code: 'not_found', message: 'Employee not found' };

        // Issuing credentials sets `isAccountActive` unconditionally further down,
        // so "resend credentials" on a DEPARTED employee silently reopened their
        // access with a working temporary password — the admin saw "sent", and
        // nobody was told the account had been reopened. The bulk screen filters on
        // is_active; this single-employee route accepted any id in scope.
        //
        // A leaver is refused outright. Re-inviting someone who still works here but
        // whose login was switched off IS a legitimate remedy, so it proceeds — and
        // is recorded, because reopening a deliberately closed account should never
        // be an invisible side-effect of a "resend" button.
        if (employee.isActive === false || employee.isActive === 0) {
            return {
                success: false,
                code: 'employee_deactivated',
                message: 'This employee is deactivated — reactivate the employee record first.',
            };
        }
        // 3.23.20: an account MIGRATED to SSO is never issued a password —
        // its invitation is the SSO one (SsoInviteService), re-queued from the
        // Accounts console. Fail closed if the migration state cannot be read.
        try {
            if (await require('./SsoInviteService').isMigrated('employee', employee.id)) {
                return {
                    success: false,
                    code: 'sso_migrated_no_password',
                    message:
                        'This account signs in with SSO: no password is issued. Re-send the SSO invitation instead.',
                };
            }
        } catch (e) {
            return {
                success: false,
                code: 'sso_state_unavailable',
                message: `SSO migration state unavailable: ${e.message}`,
            };
        }
        const reopeningDisabledLogin =
            employee.isAccountActive === false || employee.isAccountActive === 0;

        const noEmail = !employee.email;
        if (noEmail && !allowNoEmail) {
            return {
                success: false,
                code: 'no_email',
                message: 'Employee has no email address on file — add one first.',
            };
        }

        // 1. Username: keep the existing one, else derive a unique one.
        let username = employee.username;
        if (!username) {
            const base = baseUsername({
                employeeNumber: employee.employeeNumber,
                firstName: employee.firstName,
                lastName: employee.lastName,
            });
            username = await uniqueUsername(base, async (name) => {
                const hit = await EmployeeModel.findByUsername(name);
                return !!(hit && Number(hit.id) !== Number(employeeId));
            });
        }

        // invited_at/invited_by (migration 59) record the invitation state:
        // they drive the console badges ("invited on…", stale/expired) and the
        // invitationExpiryDays login refusal for never-used TEMPORARY passwords.
        const invitedAt = new Date().toISOString();
        const invitedBy = actor && actor.userType === 'admin' ? actor.id : null;

        // Reopening a login somebody deliberately switched off is a privilege
        // change, not a mail-out. Record it as one (once, whichever path runs).
        let reopenAudited = false;
        const auditReopen = async () => {
            if (!reopeningDisabledLogin || reopenAudited) return;
            reopenAudited = true;
            try {
                await require('./LogService').log({
                    adminId: invitedBy,
                    action: 'CREDENTIALS_REISSUED_REACTIVATED',
                    entityType: 'employee',
                    entityId: Number(employeeId),
                    details:
                        'Credentials re-issued to an employee whose login was disabled — login re-enabled',
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                });
            } catch (_) {
                /* the audit is best-effort; the reactivation already happened */
            }
        };

        let branding = null;
        try {
            branding = await require('../utils/branding').getBranding();
        } catch {
            /* stock identity */
        }

        // 2a. E-mail possible → username + one-time set-password link, NO password.
        let mailOn = !noEmail;
        if (mailOn && typeof EmailService.isEnabled === 'function') {
            try {
                mailOn = !!(await EmailService.isEnabled());
            } catch (_) {
                mailOn = false;
            }
        }
        const PasswordResetService = require('./PasswordResetService');
        let result = { sent: false, skipped: noEmail ? 'no_email' : 'disabled' };
        if (mailOn) {
            // A random password nobody knows: the link sets the real one.
            await EmployeeModel.update(employeeId, {
                username,
                passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10),
                isAccountActive: 1,
                forcePasswordChange: false, // the person chooses it through the link
                invitedAt,
                invitedBy,
            });
            await auditReopen();
            let mail = null;
            try {
                const token = await PasswordResetService.issueSetupToken('employee', employeeId, {
                    ttlHours: SETUP_TTL_HOURS,
                    requestIp: req ? req.ip : null,
                });
                if (!token) {
                    result = { sent: false, skipped: 'link_not_allowed' };
                } else {
                    // The link carries a credential: its origin is the CONFIGURED
                    // base URL, never the request's Host header.
                    const base = String(
                        (await require('../utils/emailTemplate').baseUrlAsync()) || ''
                    ).replace(/\/+$/, '');
                    const link = `${base}/reset-password?token=${encodeURIComponent(token.rawToken)}&setup=1`;
                    const args = { employee, username, link, expiresAt: token.expiresAt, branding };
                    mail = welcome ? await this._welcomeEmail(args) : this._setupEmail(args);
                }
            } catch (e) {
                result = { sent: false, error: `setup link unavailable: ${e && e.message}` };
            }
            if (mail) {
                try {
                    result = await EmailService.send({ to: employee.email, ...mail });
                } catch (e) {
                    result = { sent: false, error: (e && e.message) || 'send failed' };
                }
            }
            // Not delivered: no live link may outlive the attempt.
            if (!(result && result.sent)) {
                try {
                    await PasswordResetService.invalidateOutstanding('employee', employeeId);
                } catch (_) {
                    /* best-effort: the token expires on its own */
                }
            }
        }

        // 2b. Not delivered (no address, e-mail off, send failed) → the one-time
        //     handover: a temporary password returned ONCE for the credentials
        //     sheet, replaced at first sign-in. Never mailed.
        let tempPassword = null;
        if (!(result && result.sent)) {
            tempPassword = generatePassword();
            await EmployeeModel.update(employeeId, {
                username,
                passwordHash: await bcrypt.hash(tempPassword, 10),
                isAccountActive: 1,
                forcePasswordChange: true,
                invitedAt,
                invitedBy,
            });
            await auditReopen();
        }

        // 3. Audit — neither the password nor the link ever appears here.
        await LogService.log({
            adminId: invitedBy,
            action: 'CREDENTIALS_ISSUED',
            entityType: 'employee',
            entityId: employeeId,
            details:
                `Login credentials issued${welcome ? ' (welcome invitation)' : ''} for employee:${Number(employeeId)} (number ${employee.employeeNumber}); ` +
                (result.sent
                    ? `set-password link (${SETUP_TTL_HOURS} h, single use) e-mailed`
                    : `e-mail NOT sent (${result.error || result.skipped || 'email disabled'}); temporary password for the one-time credentials sheet`),
            ipAddress: req && req.ip,
            userAgent: req && req.get && req.get('user-agent'),
        });
        // Account stream on /movements: the site admin can read this
        // trail; /system-logs refuses them. Best-effort, never blocks the issue.
        try {
            await require('./MovementService').recordAccount(employeeId, {
                actor,
                fromLabel: reopeningDisabledLogin
                    ? 'login_disabled'
                    : employee.passwordHash
                      ? 'credentials'
                      : 'no_credentials',
                toLabel: result.sent ? 'setup_link_emailed' : 'credentials_on_sheet',
            });
        } catch (_) {
            /* feed row is best-effort */
        }

        // The temp password is returned ONLY when the e-mail did NOT go out: the
        // invitations console turns it into the ONE-TIME credentials sheet (same
        // pattern as the import credentials CSV). When the e-mail went, no
        // password exists anywhere: the person sets it through the link.
        return {
            success: true,
            username,
            emailed: !!result.sent,
            emailStatus: result.sent ? 'sent' : result.error || result.skipped || 'disabled',
            ...(tempPassword ? { tempPassword } : {}),
        };
    }
}

module.exports = new OnboardingCredentialService();
module.exports.SETUP_TTL_HOURS = SETUP_TTL_HOURS;
