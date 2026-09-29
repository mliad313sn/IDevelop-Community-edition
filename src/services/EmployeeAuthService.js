const bcrypt = require('bcrypt');
const EmployeeModel = require('../models/EmployeeModel');
const LogService = require('./LogService');
const passwordValidator = require('../utils/passwordValidator');

// the passport strategy collapses every refusal into "Invalid
// credentials" and drops the service's `code`. A POLICY refusal the person
// should read (an expired invitation discloses nothing new — the caller already
// holds a valid temporary password) is parked here for a few seconds, keyed by
// the identifier typed, and taken by AuthController.login for the flash.
const REFUSAL_TTL_MS = 10000;
const refusals = new Map();
function parkRefusal(identifier, code) {
    const key = String(identifier || '')
        .trim()
        .toLowerCase();
    if (!key) return;
    refusals.set(key, { code, at: Date.now() });
    if (refusals.size > 500) {
        // bounded — never grows with traffic
        const cutoff = Date.now() - REFUSAL_TTL_MS;
        for (const [k, v] of refusals) if (v.at < cutoff) refusals.delete(k);
    }
}

class EmployeeAuthService {
    /** Take (and forget) the policy-refusal code parked for this identifier, if fresh. */
    takeRefusalCode(identifier) {
        const key = String(identifier || '')
            .trim()
            .toLowerCase();
        const hit = refusals.get(key);
        if (!hit) return null;
        refusals.delete(key);
        return Date.now() - hit.at <= REFUSAL_TTL_MS ? hit.code : null;
    }

    /**
     * Security-trail row for a failed attempt: when the
     * identifier resolves to an employee the row carries entityType/entityId
     * and an actor_ref, so "show me X's failed logins" is one filter on
     * /system-logs instead of paging through free text.
     */
    async _logFailed(employee, details, req) {
        await LogService.log({
            action: 'EMPLOYEE_LOGIN_FAILED',
            entityType: employee ? 'employee' : null,
            entityId: employee ? Number(employee.id) : null,
            actorRef: employee ? `employee:${employee.id}` : null,
            details,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
    }

    async login(identifier, password, req) {
        // Accept either a username or an email address. Self-onboarded users
        // register with their email and are placed with an auto-generated
        // username they never see, so email login is essential for them; it is
        // also the natural expectation for everyone else.
        let employee = await EmployeeModel.findByUsername(identifier);
        if (!employee && identifier && String(identifier).includes('@')) {
            // An address may belong to SEVERAL accounts (migration 107): e-mail
            // login works only when it names exactly one employee — never guess.
            const u = await require('./EmailAccountsService').uniqueEmployeeByEmail(identifier);
            if (u.ambiguous) {
                await LogService.log({
                    action: 'EMPLOYEE_LOGIN_FAILED',
                    details: `Login by e-mail refused: the address is shared by several employee accounts (username required): ${identifier}`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                // A policy refusal, not a failed password: no lockout tally.
                return {
                    success: false,
                    policyRefusal: true,
                    code: 'EMAIL_AMBIGUOUS',
                    message:
                        'Several accounts share this e-mail address. Please sign in with your username.',
                };
            }
            employee = u.row ? await EmployeeModel.findById(u.row.id) : null;
        }
        const username = identifier;

        if (!employee || !employee.isAccountActive) {
            // ONE row per attempt: the strategy tries the admin table
            // first, and AuthService already wrote LOGIN_FAILED for an identifier
            // that names an ADMIN — a second, employee-side row for the same
            // keystrokes was noise ("employee username: admin").
            let namesAdmin = false;
            if (!employee) {
                try {
                    namesAdmin =
                        !!(await require('../models/AdminModel').findByUsername(identifier));
                } catch (_) {
                    namesAdmin = false;
                }
            }
            if (!namesAdmin) {
                await this._logFailed(
                    employee,
                    employee
                        ? `Failed login attempt for employee username: ${username} (login disabled)`
                        : `Failed login attempt for employee username: ${username}`,
                    req
                );
            }
            return { success: false, message: 'Invalid credentials' };
        }

        if (!employee.passwordHash) {
            return {
                success: false,
                message: 'Account not activated. Please contact your administrator.',
            };
        }

        const isValid = await bcrypt.compare(password, employee.passwordHash);

        if (!isValid) {
            await this._logFailed(
                employee,
                `Failed login attempt for employee username: ${username}`,
                req
            );
            return { success: false, message: 'Invalid credentials' };
        }

        // Local password auth disabled after an SSO merge — route via the IdP.
        if (employee.passwordDisabled === true || employee.password_disabled === true) {
            return {
                success: false,
                policyRefusal: true,
                message:
                    'This account signs in through your organization (single sign-on). Please use the SSO button.',
            };
        }

        // Invitation expiry (migration 59): a temporary credential that was
        // NEVER used (invited, no login since) stops working after
        // invitationExpiryDays — an uncollected invitation must not remain a
        // valid credential forever. Re-inviting from the console resets it.
        if (employee.forcePasswordChange && employee.invitedAt && !employee.lastLoginAt) {
            let expiryDays = 14;
            try {
                const AppSettingsModel = require('../models/AppSettingsModel');
                expiryDays = Number(await AppSettingsModel.getValue('invitationExpiryDays', 14));
            } catch (_) {
                /* settings unavailable → default */
            }
            if (Number.isFinite(expiryDays) && expiryDays > 0) {
                const ageDays = (Date.now() - new Date(employee.invitedAt).getTime()) / 86400000;
                if (ageDays > expiryDays) {
                    await this._logFailed(
                        employee,
                        `Expired invitation credential refused for employee: ${username} (invited ${String(employee.invitedAt).slice(0, 10)}, expiry ${expiryDays}d)`,
                        req
                    );
                    parkRefusal(identifier, 'INVITATION_EXPIRED');
                    return {
                        success: false,
                        policyRefusal: true,
                        code: 'INVITATION_EXPIRED',
                        message:
                            'Your invitation has expired. Please contact your administrator to receive a new one. / Votre invitation a expiré. Contactez votre administrateur pour en recevoir une nouvelle.',
                    };
                }
            }
        }

        // Per-user authentication policy (migration 55): 'sso_only' refuses the
        // local password even when a valid hash exists.
        if (String(employee.authPolicy || employee.auth_policy || 'any') === 'sso_only') {
            await this._logFailed(
                employee,
                `Password login refused by auth policy (sso_only) for employee: ${username}`,
                req
            );
            return {
                success: false,
                message:
                    'Your account is required to sign in through your organization (single sign-on). Please use the SSO button.',
            };
        }

        // Update last login
        await EmployeeModel.update(employee.id, {
            lastLoginAt: new Date().toISOString(),
        });

        await LogService.log({
            action: 'EMPLOYEE_LOGIN_SUCCESS',
            entityType: 'employee',
            entityId: Number(employee.id),
            actorRef: `employee:${employee.id}`,
            details: `Employee logged in: ${username} (${employee.firstName} ${employee.lastName})`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });

        return { success: true, employee };
    }

    async setupAccount(employeeId, username, password) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee) {
            return { success: false, message: 'Employee not found' };
        }

        // Check if username already exists
        const existing = await EmployeeModel.findByUsername(username);
        if (existing && existing.id !== employeeId) {
            return { success: false, message: 'Username already exists' };
        }

        // Enforce password complexity here too (not only at the controller) so the
        // policy holds regardless of caller.
        const pv = passwordValidator.validate(password);
        if (!pv.valid) {
            return { success: false, message: 'Password: ' + pv.errors.join('; ') };
        }

        const passwordHash = await bcrypt.hash(password, 10);

        await EmployeeModel.update(employeeId, {
            username,
            passwordHash,
            isAccountActive: 1,
        });

        return { success: true };
    }

    async changePassword(employeeId, currentPassword, newPassword) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee || !employee.passwordHash) {
            return { success: false, message: 'Employee not found or account not activated' };
        }

        const isValid = await bcrypt.compare(currentPassword, employee.passwordHash);
        if (!isValid) {
            return { success: false, message: 'Current password is incorrect' };
        }

        const pv = passwordValidator.validate(newPassword);
        if (!pv.valid) {
            return { success: false, message: 'Password: ' + pv.errors.join('; ') };
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await EmployeeModel.update(employeeId, {
            passwordHash,
            forcePasswordChange: false,
        });

        return { success: true };
    }
}

module.exports = new EmployeeAuthService();
