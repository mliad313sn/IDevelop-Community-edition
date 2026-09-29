'use strict';
/**
 * reset-superadmin-mfa.js — 3.23.20 (Amendment C2d). The OS-administrator
 * recovery of a SuperAdmin who lost their authenticator when no other
 * SuperAdmin can reset it (the peer reset is the normal path).
 *
 *   node scripts/reset-superadmin-mfa.js <superadmin-username>
 *
 * Normally run through  Manage-IDevelop.ps1 -ResetSuperadminMfa <username>
 * (elevated). Refuses to run unless the process is elevated (Windows: an
 * administrator token; elsewhere: root). It:
 *   - clears the TOTP secret, the backup codes and the replay ledger;
 *   - ends every live session of that account;
 *   - leaves the account HELD on MFA enrolment at its next sign-in (a
 *     SuperAdmin without MFA is always held — middleware/mfaEnforcement);
 *   - writes MFA_RESET_BY_OS_ADMIN to the audit log with the Windows user and
 *     host, and alerts every SuperAdmin.
 * Only a SuperAdmin account can be reset here. There is no web or e-mail path.
 * Exit codes: 0 done, 1 error, 2 not found / not a SuperAdmin, 3 not elevated.
 */
require('dotenv').config();
const os = require('os');

function isElevated() {
    try {
        if (process.platform === 'win32') {
            // `net session` succeeds only with an administrator token.
            require('child_process').execSync('net session', { stdio: 'ignore' });
            return true;
        }
        return typeof process.getuid === 'function' && process.getuid() === 0;
    } catch (_) {
        return false;
    }
}

/**
 * The reset itself (exported for the tests). Runs on the caller's database
 * connection (and inside its transaction when there is one).
 * @returns {Promise<{ok:boolean, code?:string, adminId?:number, hadSecret?:boolean, backupCodesRemoved?:number, sessions?:number}>}
 */
async function resetSuperadminMfa({ username, osUser, host, elevated }) {
    if (!elevated) return { ok: false, code: 'not_elevated' };
    const name = String(username || '').trim();
    if (!name) return { ok: false, code: 'username_required' };
    const db = require('../src/config/database');
    const a = await db.get('SELECT id, username, role, is_active FROM admins WHERE username = ?', [
        name,
    ]);
    if (!a) return { ok: false, code: 'not_found' };
    if (a.role !== 'superadmin') return { ok: false, code: 'not_superadmin' };
    const MfaService = require('../src/services/MfaService');
    const r = await MfaService.adminReset({ userType: 'admin', userId: Number(a.id) });
    let sessions = 0;
    try {
        sessions = await require('../src/services/SessionService').revokeAllForUser(
            Number(a.id),
            'admin',
            null
        );
    } catch (_) {
        sessions = 0; // the enrolment hold still applies at the next request
    }
    const who = String(osUser || 'unknown').slice(0, 120);
    const where = String(host || 'unknown').slice(0, 120);
    await require('../src/services/LogService').log({
        adminId: null,
        actorRef: `os-admin ${who}@${where}`,
        action: 'MFA_RESET_BY_OS_ADMIN',
        entityType: 'admin',
        entityId: Number(a.id),
        category: 'security',
        details: `Two-factor authentication of SuperAdmin "${a.username}" reset from the server by OS administrator ${who} on ${where}: secret ${r.hadSecret ? 'removed' : 'absent'}, ${r.backupCodesRemoved} backup code(s) removed, ${Number(sessions) || 0} session(s) ended; next sign-in held on enrolment`,
    });
    await require('../src/services/SuperadminAlertService').alert(
        'security.superadmin_mfa_changed',
        {
            targetAdminId: Number(a.id),
            username: a.username,
            detail: `reset from the server by OS administrator ${who} on ${where}`,
        }
    );
    return {
        ok: true,
        adminId: Number(a.id),
        hadSecret: r.hadSecret,
        backupCodesRemoved: r.backupCodesRemoved,
        sessions: Number(sessions) || 0,
    };
}

const MESSAGES = {
    not_elevated:
        'Refused: run this from an elevated (administrator) prompt — Manage-IDevelop.ps1 -ResetSuperadminMfa <username>.',
    username_required: 'A SuperAdmin username is required.',
    not_found: 'No administrator account with that username.',
    not_superadmin:
        'That account is not a SuperAdmin: use the peer reset from the Admins page instead.',
};
const EXIT = { not_elevated: 3, username_required: 2, not_found: 2, not_superadmin: 2 };

if (require.main === module) {
    (async () => {
        const db = require('../src/config/database');
        await db.connect();
        let r;
        try {
            r = await resetSuperadminMfa({
                username: process.argv[2],
                osUser:
                    process.env.APP_OS_ADMIN_USER ||
                    `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${os.userInfo().username}`,
                host: os.hostname(),
                elevated: isElevated(),
            });
        } finally {
            await db.close();
        }
        if (!r.ok) {
            console.error(MESSAGES[r.code] || `Refused (${r.code}).`);
            process.exit(EXIT[r.code] || 1);
        }
        console.log(
            `Two-factor authentication of '${process.argv[2]}' reset (secret ${r.hadSecret ? 'removed' : 'absent'}, ${r.backupCodesRemoved} backup code(s), ${r.sessions} session(s) ended). The next sign-in is held on enrolment.`
        );
    })().catch((e) => {
        console.error('Failed:', e && e.message);
        process.exit(1);
    });
}

module.exports = { resetSuperadminMfa, isElevated };
