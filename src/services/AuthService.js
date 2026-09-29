const bcrypt = require('bcrypt');
const AdminModel = require('../models/AdminModel');
const LogService = require('./LogService');
const PasswordHistoryModel = require('../models/PasswordHistoryModel');
const passwordValidator = require('../utils/passwordValidator');

class AuthService {
    async login(username, password, req) {
        // Accept a username or an email address (consistent with employee login).
        // An address may belong to SEVERAL accounts (migration 107): signing in
        // by e-mail works only when it names exactly one admin — never guess.
        let admin = await AdminModel.findByUsername(username);
        if (!admin && username && String(username).includes('@')) {
            const u = await require('./EmailAccountsService').uniqueAdminByEmail(username);
            if (u.ambiguous) {
                await LogService.log({
                    action: 'LOGIN_FAILED',
                    details: `Login by e-mail refused: the address is shared by several admin accounts (username required): ${username}`,
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
            admin = u.row ? await AdminModel.findById(u.row.id) : null;
        }

        if (!admin || !admin.isActive) {
            await LogService.log({
                action: 'LOGIN_FAILED',
                details: `Failed login attempt for username: ${username}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            return { success: false, message: 'Invalid credentials' };
        }

        // Check if account is locked
        if (admin.lockedUntil) {
            const lockDate = new Date(admin.lockedUntil);
            const now = new Date();
            if (lockDate > now) {
                await LogService.log({
                    action: 'LOGIN_FAILED',
                    details: `Login attempt for locked account: ${username}`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                const minutesRemaining = Math.ceil((lockDate - now) / (1000 * 60));
                return {
                    success: false,
                    message: `Account is locked. Please try again in ${minutesRemaining} minute(s).`,
                };
            } else {
                // Lock has expired, clear it
                await AdminModel.update(admin.id, { lockedUntil: null });
            }
        }

        const isValid = await bcrypt.compare(password, admin.passwordHash);

        if (!isValid) {
            await LogService.log({
                action: 'LOGIN_FAILED',
                details: `Failed login attempt for username: ${username}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            return { success: false, message: 'Invalid credentials' };
        }

        // Local password auth disabled after an SSO merge — route via the IdP.
        if (admin.passwordDisabled === true || admin.password_disabled === true) {
            return {
                success: false,
                policyRefusal: true,
                message:
                    'This account signs in through your organization (single sign-on). Please use the SSO button.',
            };
        }

        await LogService.log({
            adminId: admin.id,
            action: 'LOGIN_SUCCESS',
            details: `User logged in: ${username}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });

        return { success: true, admin };
    }

    async createAdmin(data) {
        const existing = await AdminModel.findByUsername(data.username);
        if (existing) {
            return { success: false, message: 'Username already exists' };
        }

        // E-mail is contact information, not an identity key: a person may hold
        // several accounts (migration 107), so no uniqueness check here — the
        // controller advises the operator when the address is already in use.

        // Validate password with enhanced security requirements
        const validation = passwordValidator.validate(data.password);
        if (!validation.valid) {
            return { success: false, message: validation.errors.join(', ') };
        }

        // Additional check: password should not contain username
        if (data.username && data.password.toLowerCase().includes(data.username.toLowerCase())) {
            return { success: false, message: 'Password must not contain the username' };
        }

        const passwordHash = await bcrypt.hash(data.password, 10);

        const admin = await AdminModel.create({
            username: data.username,
            email: data.email || null,
            passwordHash,
            role: data.role,
            isActive: 1,
            passwordChangedAt: new Date().toISOString(),
        });

        // Add to password history
        await PasswordHistoryModel.addPassword(admin.id, passwordHash);

        return { success: true, admin };
    }

    async changePassword(adminId, currentPassword, newPassword) {
        const admin = await AdminModel.findById(adminId);
        if (!admin) {
            return { success: false, message: 'Admin not found' };
        }

        const isValid = await bcrypt.compare(currentPassword, admin.passwordHash);
        if (!isValid) {
            return { success: false, message: 'Current password is incorrect' };
        }

        // Validate new password with enhanced security requirements
        const validation = passwordValidator.validate(newPassword);
        if (!validation.valid) {
            return { success: false, message: validation.errors.join(', ') };
        }

        // Additional check: password should not contain username
        if (admin.username && newPassword.toLowerCase().includes(admin.username.toLowerCase())) {
            return { success: false, message: 'Password must not contain your username' };
        }

        // Check password history
        const recentPasswords = await PasswordHistoryModel.getRecentPasswords(adminId, 5);
        for (const record of recentPasswords) {
            const matches = await bcrypt.compare(newPassword, record.passwordHash);
            if (matches) {
                return { success: false, message: 'Cannot reuse any of your last 5 passwords' };
            }
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await AdminModel.update(adminId, {
            passwordHash,
            passwordChangedAt: new Date().toISOString(),
            forcePasswordChange: 0,
        });

        // Add to password history
        await PasswordHistoryModel.addPassword(adminId, passwordHash);
        await PasswordHistoryModel.cleanupOldPasswords(adminId);

        return { success: true };
    }

    async createDefaultSuperAdmin() {
        const existing = await AdminModel.findByUsername('admin');
        if (!existing) {
            // SECURITY — see utils/bootstrapAdmin: the first-run password is
            // generated per install, never the old constant 'admin123'. This is
            // the SECOND seed path (PostgresDatabase.seed is the other); both had
            // the same hardcoded default, so fixing only one would have left the
            // guessable credential reachable through this one.
            const { seedAdminPassword } = require('../utils/bootstrapAdmin');
            const { password, generated } = seedAdminPassword();
            const passwordHash = await bcrypt.hash(password, 12);
            await AdminModel.create({
                username: 'admin',
                email: 'admin@localhost',
                passwordHash,
                role: 'superadmin',
                isActive: 1,
                // Force a change at first login — the bootstrap value is good for
                // exactly the one sign-in that replaces it.
                forcePasswordChange: 1,
            });
            if (generated) {
                console.log('');
                console.log('  ============================================================');
                console.log('   FIRST-RUN SUPERADMIN — copy this now, it is shown ONCE');
                console.log('     username : admin');
                console.log(`     password : ${password}`);
                console.log('   A password change is required at first sign-in.');
                console.log('  ============================================================');
                console.log('');
            }
        }
    }
}

module.exports = new AuthService();
