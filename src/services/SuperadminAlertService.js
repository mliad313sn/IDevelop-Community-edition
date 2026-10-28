'use strict';
/**
 * SuperadminAlertService — 3.23.20 (Amendment C2f). Security alerts to EVERY
 * active SuperAdmin, in-app always and by e-mail when e-mail is on (category
 * 'security', setting emailOnSecurityAlerts, default ON):
 *
 *   security.breakglass_signin       a SuperAdmin signed in by password while
 *                                    SSO is enforced (the emergency door);
 *   security.superadmin_sso_refused  an SSO route reached a SuperAdmin account
 *                                    and was refused (superadmin_sso_forbidden);
 *   security.superadmin_mfa_changed  a SuperAdmin's MFA was enrolled, reset
 *                                    (peer, OS-admin CLI) or a recovery code used;
 *   security.admin_account_locked    an admin account was hard-locked after
 *                                    repeated failed sign-ins.
 *   security.superadmin_password_reset  a SuperAdmin password was reset (its
 *                                    MFA is never touched by a reset).
 *
 * Best-effort: an alert never blocks, delays or fails the event it reports.
 * A repeated refusal against the same account is raised at most once an hour
 * (reminder_log claim) so a scripted attempt cannot flood the inboxes.
 * Payloads carry no secret: an account name, an id and a short reason.
 */
const db = require('../config/database');

const KINDS = new Set([
    'security.breakglass_signin',
    'security.superadmin_sso_refused',
    'security.superadmin_mfa_changed',
    'security.superadmin_password_reset',
    // A privileged account hard-locked after repeated failed sign-ins.
    'security.admin_account_locked',
]);

function hourBucket(d = new Date()) {
    return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
}

/**
 * @param {string} kind       one of KINDS
 * @param {object} p
 * @param {number} [p.targetAdminId]  the SuperAdmin account concerned
 * @param {string} [p.username]
 * @param {string} [p.detail]         short, secret-free reason
 * @param {boolean} [p.hourly]        de-duplicate per (kind, target, hour)
 * @returns {Promise<number>} how many SuperAdmins were notified
 */
async function alert(
    kind,
    { targetAdminId = null, username = null, detail = null, hourly = false } = {}
) {
    if (!KINDS.has(kind)) return 0;
    try {
        if (hourly) {
            const { claim } = require('../jobs/reminders');
            const first = await claim(
                kind,
                'admin',
                Number(targetAdminId) || 0,
                0,
                hourBucket()
            ).catch(() => false); // a ledger error counts as DUPLICATE: no flood on a broken ledger
            // (claim refuses a falsy target id too: an untargeted hourly alert is never sent.)
            if (!first) return 0;
        }
        const admins = await db.all(
            "SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id"
        );
        const Notify = require('./NotificationService');
        let n = 0;
        for (const a of admins || []) {
            // eslint-disable-next-line no-await-in-loop
            const r = await Notify.notify({
                userType: 'admin',
                userId: Number(a.id),
                kind,
                category: 'security',
                payload: {
                    targetAdminId: targetAdminId == null ? null : Number(targetAdminId),
                    username: username || null,
                    detail: detail ? String(detail).slice(0, 200) : null,
                },
            });
            if (r && r.inapp !== 'error') n++;
        }
        return n;
    } catch (e) {
        console.warn('[superadmin-alert] failed:', kind, e && e.message);
        return 0;
    }
}

module.exports = { alert, KINDS, hourBucket };
