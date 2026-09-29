'use strict';

/**
 * OnboardingCredentialService — issue login credentials to an employee and
 * email them a bilingual (FR/EN) onboarding message.
 *
 * Flow (hooks straight into the existing first-login machinery):
 *   1. Ensure a unique username (kept if one exists, else generated from the
 *      identity via credentialGenerator).
 *   2. Generate a strong temporary password that satisfies the password policy.
 *   3. Store the bcrypt hash, activate the login (is_account_active) and set
 *      force_password_change — server.js funnels the account to
 *      /change-password on first sign-in until it is rotated.
 *   4. Email username + temporary password via EmailService (gated by the
 *      SMTP settings / master switch like every other mail).
 *   5. Audit CREDENTIALS_ISSUED — never logging the password itself.
 *
 * The temporary password exists only in the email; it is never persisted in
 * clear and never written to a log line.
 */

const PRODUCT = require('../config/product');
const bcrypt = require('bcrypt');
const EmployeeModel = require('../models/EmployeeModel');
const EmailService = require('./EmailService');
const LogService = require('./LogService');
const { generatePassword, baseUsername, uniqueUsername } = require('../utils/credentialGenerator');

class OnboardingCredentialService {
    /**
     * Full WELCOME onboarding email (bulk invitation flow): what the platform
     * is, the person's own profile details, what is expected of them (adapted
     * to employee vs manager), their credentials, and the forced first-login
     * password change. Built on the shared branded template.
     */
    async _welcomeEmail({ employee, username, tempPassword, branding }) {
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
                fr: 'Connectez-vous et choisissez votre propre mot de passe (obligatoire à la première connexion).',
                en: 'Sign in and set your own password (required at first login).',
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

        blocks.push(T.section('Vos identifiants', 'Your credentials'));
        blocks.push(
            T.details([
                ['Identifiant / Username', username],
                ['Mot de passe temporaire / Temporary password', tempPassword],
            ])
        );
        blocks.push(
            T.para(
                'Ce mot de passe est à usage unique : vous devrez en choisir un nouveau dès votre première connexion. Ne le partagez pas.',
                'This password is single-use: you must choose a new one at first sign-in. Do not share it.'
            )
        );
        if (appUrl)
            blocks.push(
                T.cta(
                    'Se connecter',
                    'Sign in',
                    appUrl + '/login',
                    branding && branding.accentColor
                )
            );
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
                `Identifiant / Username: ${username}\nMot de passe temporaire / Temporary password: ${tempPassword}\n` +
                (appUrl ? `Connexion / Sign in: ${appUrl}/login\n` : '') +
                `Un nouveau mot de passe sera exigé à la première connexion. / A new password is required at first sign-in.`,
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

        // 2–3. Temp password → hash, activate login, force first-login rotation.
        // invited_at/invited_by (migration 59) record the invitation state:
        // they drive the console badges ("invited on…", stale/expired) and the
        // invitationExpiryDays login refusal for never-used credentials.
        const tempPassword = generatePassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);
        await EmployeeModel.update(employeeId, {
            username,
            passwordHash,
            isAccountActive: 1,
            forcePasswordChange: true,
            invitedAt: new Date().toISOString(),
            invitedBy: actor && actor.userType === 'admin' ? actor.id : null,
        });

        // Reopening a login somebody deliberately switched off is a privilege
        // change, not a mail-out. Record it as one.
        if (reopeningDisabledLogin) {
            try {
                await require('./LogService').log({
                    adminId: actor && actor.userType === 'admin' ? actor.id : null,
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
        }

        // 4. Bilingual onboarding email on the shared branded template — the
        //    short credentials mail, or the full welcome/invitation variant.
        let branding = null;
        try {
            branding = await require('../utils/branding').getBranding();
        } catch {
            /* stock identity */
        }
        let mail;
        if (welcome) {
            mail = await this._welcomeEmail({ employee, username, tempPassword, branding });
        } else {
            const T = require('../utils/emailTemplate');
            const appUrl = require('../utils/emailTemplate').baseUrl();
            const appName = (branding && branding.appName) || PRODUCT.name;
            mail = {
                subject: `[${appName}] Vos identifiants de connexion / Your login credentials`,
                html: T.wrap({
                    branding,
                    title: 'Vos identifiants / Your credentials',
                    intro: `Bonjour ${employee.firstName},`,
                    blocks: [
                        T.para('Votre compte a été créé.', 'Your account has been created.'),
                        T.details([
                            ['Identifiant / Username', username],
                            ['Mot de passe temporaire / Temporary password', tempPassword],
                        ]),
                        T.para(
                            'Vous devrez choisir un nouveau mot de passe à votre première connexion. Ce mot de passe est à usage unique — ne le partagez pas.',
                            'You must choose a new password at first sign-in. This password is single-use — do not share it.'
                        ),
                        ...(appUrl
                            ? [
                                  T.cta(
                                      'Se connecter',
                                      'Sign in',
                                      appUrl + '/login',
                                      branding && branding.accentColor
                                  ),
                              ]
                            : []),
                    ],
                }),
                text:
                    `Identifiant / Username: ${username}\n` +
                    `Mot de passe temporaire / Temporary password: ${tempPassword}\n` +
                    (appUrl ? `Accès / Access: ${appUrl}/login\n` : '') +
                    `Un nouveau mot de passe vous sera demandé à la première connexion. / A new password is required on first sign-in.`,
            };
        }
        // No address → nothing to send; the sheet is the delivery channel.
        const result = noEmail
            ? { sent: false, skipped: 'no_email' }
            : await EmailService.send({ to: employee.email, ...mail });

        // 5. Audit — the password never appears here.
        await LogService.log({
            adminId: actor && actor.userType === 'admin' ? actor.id : null,
            action: 'CREDENTIALS_ISSUED',
            entityType: 'employee',
            entityId: employeeId,
            details:
                `Login credentials issued${welcome ? ' (welcome invitation)' : ''} for employee ${employee.employeeNumber} (username ${username}); ` +
                `onboarding email ${result.sent ? 'sent to ' + employee.email : 'NOT sent (' + (result.error || result.skipped || 'email disabled') + ')'}`,
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
                toLabel: result.sent ? 'credentials_emailed' : 'credentials_on_sheet',
            });
        } catch (_) {
            /* feed row is best-effort */
        }

        // The temp password is returned ONLY when the email did NOT go out —
        // otherwise the account would exist with a credential nobody can ever
        // read. The invitations console turns these into a ONE-TIME credentials
        // sheet (same pattern as the import credentials CSV); when the email
        // was delivered, the password lives nowhere but that email.
        return {
            success: true,
            username,
            emailed: !!result.sent,
            emailStatus: result.sent ? 'sent' : result.error || result.skipped || 'disabled',
            ...(result.sent ? {} : { tempPassword }),
        };
    }
}

module.exports = new OnboardingCredentialService();
