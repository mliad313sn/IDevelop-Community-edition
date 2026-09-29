'use strict';

/**
 * NotificationAdminService — the operator's view over every notification the
 * platform has produced, IN-APP and EMAIL alike. They share one table
 * (`notifications`, discriminated by `channel` = inapp | email; `state` =
 * queued | sent | failed | snoozed), so one query monitors both.
 *
 * This is a monitoring + light management surface: an admin can see who was
 * notified of what, on which channel, and whether it went out — and re-queue a
 * FAILED delivery so the sender attempts it again. It never fabricates a "sent":
 * retry moves failed → queued and lets the real sender do the work.
 */
const db = require('../config/database');

const CHANNELS = ['inapp', 'email'];
const STATES = ['queued', 'sent', 'failed', 'snoozed'];
const USER_TYPES = ['employee', 'admin'];

class NotificationAdminService {
    get CHANNELS() {
        return CHANNELS;
    }
    get STATES() {
        return STATES;
    }
    get USER_TYPES() {
        return USER_TYPES;
    }

    // Recipient name is resolved by joining the two possible recipient tables;
    // user_type decides which one carries the row.
    _from() {
        return `FROM notifications n
                LEFT JOIN employees e ON n.user_type = 'employee' AND e.id = n.user_id
                LEFT JOIN admins a    ON n.user_type = 'admin'    AND a.id = n.user_id`;
    }

    _where(filters, params) {
        const cl = [];
        if (CHANNELS.includes(filters.channel)) {
            cl.push('n.channel = ?');
            params.push(filters.channel);
        }
        if (STATES.includes(filters.state)) {
            cl.push('n.state = ?');
            params.push(filters.state);
        }
        if (USER_TYPES.includes(filters.userType)) {
            cl.push('n.user_type = ?');
            params.push(filters.userType);
        }
        if (filters.kind) {
            cl.push('n.kind = ?');
            params.push(filters.kind);
        }
        // Date bounds are computed as timestamps by the caller (from = start of
        // day, to = start of the following day) so no SQL date arithmetic — and
        // so the compat translator never has to rewrite a cast.
        if (filters.fromTs) {
            cl.push('n.created_at >= ?');
            params.push(filters.fromTs);
        }
        if (filters.toTs) {
            cl.push('n.created_at < ?');
            params.push(filters.toTs);
        }
        if (filters.q) {
            const like = '%' + String(filters.q).toLowerCase() + '%';
            cl.push(
                `(LOWER(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) LIKE ?
                  OR LOWER(COALESCE(a.username, '')) LIKE ?
                  OR LOWER(COALESCE(a.email, '')) LIKE ?)`
            );
            params.push(like, like, like);
        }
        return cl.length ? 'WHERE ' + cl.join(' AND ') : '';
    }

    async count(filters = {}) {
        const params = [];
        const where = this._where(filters, params);
        const r = await db.get(`SELECT COUNT(*)::int AS n ${this._from()} ${where}`, params);
        return r ? Number(r.n) : 0;
    }

    async list(filters = {}, limit = 50, offset = 0) {
        const params = [];
        const where = this._where(filters, params);
        params.push(limit, offset);
        return db.all(
            `SELECT n.id, n.user_type, n.user_id, n.channel, n.kind, n.state, n.locale,
                    n.created_at, n.sent_at, n.read_at, n.release_at, n.payload,
                    COALESCE(
                        NULLIF(TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')), ''),
                        a.username, a.email
                    ) AS recipient_name
             ${this._from()}
             ${where}
             ORDER BY n.created_at DESC, n.id DESC
             LIMIT ? OFFSET ?`,
            params
        );
    }

    /**
     * Counts grouped by channel and state, shaped for the summary cards.
     * @returns {{ byChannel: object, byState: object, total: number }}
     */
    async stats(filters = {}) {
        const params = [];
        const where = this._where(filters, params);
        const rows = await db.all(
            `SELECT n.channel, n.state, COUNT(*)::int AS n ${this._from()} ${where}
             GROUP BY n.channel, n.state`,
            params
        );
        const byChannel = {};
        const byState = {};
        let total = 0;
        for (const c of CHANNELS) byChannel[c] = { total: 0 };
        for (const s of STATES) byState[s] = 0;
        for (const r of rows) {
            const n = Number(r.n) || 0;
            total += n;
            if (!byChannel[r.channel]) byChannel[r.channel] = { total: 0 };
            byChannel[r.channel][r.state] = (byChannel[r.channel][r.state] || 0) + n;
            byChannel[r.channel].total += n;
            byState[r.state] = (byState[r.state] || 0) + n;
        }
        return { byChannel, byState, total };
    }

    async distinctKinds() {
        const rows = await db.all('SELECT DISTINCT kind FROM notifications ORDER BY kind');
        return rows.map((r) => r.kind);
    }

    async getById(id) {
        return db.get(
            `SELECT n.*, COALESCE(
                        NULLIF(TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')), ''),
                        a.username, a.email
                    ) AS recipient_name
             ${this._from()} WHERE n.id = ?`,
            [Number(id) || 0]
        );
    }

    /**
     * Re-queue a FAILED notification so the sender attempts delivery again. Only
     * a failed row is eligible — never a queued/sent/snoozed one — so this can
     * never manufacture a duplicate send or a fake "sent". Returns the row, or
     * null when nothing was eligible.
     */
    async retry(id) {
        const row = await db.get(
            `UPDATE notifications
                SET state = 'queued', release_at = now(), sent_at = NULL
              WHERE id = ? AND state = 'failed'
              RETURNING id, state`,
            [Number(id) || 0]
        );
        return row || null;
    }
}

module.exports = new NotificationAdminService();
