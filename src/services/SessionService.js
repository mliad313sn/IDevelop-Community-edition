'use strict';

const db = require('../config/database');

/**
 * SessionService — user-facing management of the server-side session store
 * (connect-pg-simple `session` table). Lets a user review their active sessions
 * and lets the app force-invalidate sessions on sensitive events (password change,
 * admin reset). Passport serialises the user as sess->'passport'->'user' =
 * { id, userType } (id stored as text), so we match on both to avoid collisions
 * between the employee and admin id spaces.
 */
class SessionService {
    /** Active (unexpired) sessions for a user, newest-activity first. */
    async listForUser(userId, userType) {
        const rows = await db.all(
            `SELECT sid, sess, expire FROM session
              WHERE sess->'passport'->'user'->>'id' = ?
                AND sess->'passport'->'user'->>'userType' = ?
                AND expire > now()
              ORDER BY expire DESC`,
            [String(userId), String(userType)]
        );
        return rows.map((r) => {
            const meta = (r.sess && r.sess.meta) || {};
            return {
                sid: r.sid,
                ip: meta.ip || null,
                userAgent: meta.ua || null,
                loginAt: meta.loginAt || null,
                lastActivity: (r.sess && r.sess.lastActivity) || null,
                expire: r.expire,
            };
        });
    }

    /** Revoke every session for this user EXCEPT the current one ("sign out other devices"). */
    async revokeOthers(userId, userType, currentSid) {
        const res = await db.run(
            `DELETE FROM session
              WHERE sess->'passport'->'user'->>'id' = ?
                AND sess->'passport'->'user'->>'userType' = ?
                AND sid <> ?`,
            [String(userId), String(userType), String(currentSid || '')]
        );
        return res && res.changes != null ? res.changes : 0;
    }

    /** Revoke a single session by id (must belong to this user). */
    async revokeOne(userId, userType, sid) {
        const res = await db.run(
            `DELETE FROM session
              WHERE sid = ?
                AND sess->'passport'->'user'->>'id' = ?
                AND sess->'passport'->'user'->>'userType' = ?`,
            [String(sid), String(userId), String(userType)]
        );
        return res && res.changes != null ? res.changes : 0;
    }

    /**
     * ALL active sessions platform-wide, with the owner resolved to a display
     * name (admin username / employee full name). Powers the admin session
     * monitor. Anonymous rows are pre-login sessions (login page, SSO handshake).
     */
    async listAll() {
        const rows = await db.all(
            `SELECT s.sid, s.sess, s.expire,
                    s.sess->'passport'->'user'->>'id'       AS owner_id,
                    s.sess->'passport'->'user'->>'userType' AS owner_type,
                    a.username                              AS admin_username,
                    (e.firstName || ' ' || e.lastName)      AS employee_name,
                    e.employeeNumber                        AS employee_number
               FROM session s
               LEFT JOIN admins a ON s.sess->'passport'->'user'->>'userType' = 'admin'
                                 AND a.id = NULLIF(s.sess->'passport'->'user'->>'id', '')::int
               LEFT JOIN employees e ON s.sess->'passport'->'user'->>'userType' IN ('employee','manager')
                                    AND e.id = NULLIF(s.sess->'passport'->'user'->>'id', '')::int
              WHERE s.expire > now()
              ORDER BY s.expire DESC`
        );
        return rows.map((r) => {
            const meta = (r.sess && r.sess.meta) || {};
            const type = r.ownerType ?? r.owner_type ?? null;
            const oid = r.ownerId ?? r.owner_id ?? null;
            const empName = r.employeeName ?? r.employee_name;
            return {
                sid: r.sid,
                ownerId: oid,
                ownerType: type,
                ownerName:
                    type === 'admin'
                        ? (r.adminUsername ?? r.admin_username) || `admin #${oid}`
                        : empName
                          ? `${empName} (${r.employeeNumber ?? r.employee_number ?? '—'})`
                          : type
                            ? `${type} #${oid}`
                            : null,
                anonymous: !type,
                ip: meta.ip || null,
                userAgent: meta.ua || null,
                loginAt: meta.loginAt || null,
                lastActivity: (r.sess && r.sess.lastActivity) || null,
                expire: r.expire,
            };
        });
    }

    /** Admin: revoke ONE session by exact sid, whoever owns it. */
    async revokeBySid(sid) {
        const res = await db.run('DELETE FROM session WHERE sid = ?', [String(sid)]);
        return res && res.changes != null ? res.changes : 0;
    }

    /**
     * Revoke ALL sessions for a user (used when an admin resets someone else's
     * password, or to fully log a user out everywhere). Optionally keep one sid.
     */
    async revokeAllForUser(userId, userType, exceptSid = null) {
        const params = [String(userId), String(userType)];
        let clause =
            "sess->'passport'->'user'->>'id' = ? AND sess->'passport'->'user'->>'userType' = ?";
        if (exceptSid) {
            clause += ' AND sid <> ?';
            params.push(String(exceptSid));
        }
        const res = await db.run(`DELETE FROM session WHERE ${clause}`, params);
        return res && res.changes != null ? res.changes : 0;
    }
}

module.exports = new SessionService();
