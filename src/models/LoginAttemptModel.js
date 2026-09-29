const BaseModel = require('./BaseModel');
const db = require('../config/database');

// PostgreSQL-only.
const IS_PG = true;
// Wall-clock per INSERT, not the transaction's frozen now: the lock window
// starts at the last success/reset, so a row written a moment later must
// carry a later timestamp even inside the same transaction.
const NOW_EXPR = 'clock_timestamp()';

/**
 * login_attempts is APPEND-ONLY (ZDB-5, migration 134).
 *
 * `clearFailedAttempts` used to be `DELETE ... WHERE successful = false`, called
 * on EVERY successful login. Measured on the test base, transaction rolled back:
 * three failures, one success → zero failure rows left. The trace of a
 * brute-force attack was erased at the exact moment it succeeded, and the
 * "most attacked accounts" panel and the access review read a table whose
 * failures before any success had vanished.
 *
 * The lock never needed the deletion: it is a count over a sliding window, so
 * the window simply starts at the LAST SUCCESS (or the last administrative
 * unlock). Nothing is deleted; an unlock is a `kind = 'reset'` row with
 * successful = NULL and no address — a boundary marker that no existing
 * `successful = true` / `= false` predicate can mistake for a login.
 */
class LoginAttemptModel extends BaseModel {
    constructor() {
        super('login_attempts');
    }

    // Window predicate: "<col> within the last N minutes".
    _withinMinutes(col) {
        return IS_PG
            ? `${col} > now() - (? * interval '1 minute')`
            : `datetime(${col}) > datetime('now', '-' || ? || ' minutes')`;
    }

    // Boundary predicate: "<col> after the last success or reset of ?username".
    // '-infinity' keeps the comparison true when there was never one.
    _sinceLastSuccess(col) {
        return `${col} > COALESCE((SELECT MAX(l2.attemptedAt) FROM login_attempts l2
                                     WHERE l2.username = ? AND (l2.successful = true OR l2.kind = 'reset')),
                                    '-infinity'::timestamptz)`;
    }

    /** Record a failed login attempt */
    async recordFailedAttempt(username, ipAddress) {
        return await db.run(
            `INSERT INTO login_attempts (username, ipAddress, attemptedAt, successful)
             VALUES (?, ?, ${NOW_EXPR}, ?)`,
            [username, ipAddress, false]
        );
    }

    /** Record a successful login */
    async recordSuccessfulLogin(username, ipAddress) {
        return await db.run(
            `INSERT INTO login_attempts (username, ipAddress, attemptedAt, successful)
             VALUES (?, ?, ${NOW_EXPR}, ?)`,
            [username, ipAddress, true]
        );
    }

    /**
     * Failed attempts that COUNT TOWARDS THE LOCK: within the window AND after
     * the last success/reset. Earlier failures stay in the table as history.
     */
    async getFailedAttemptsCount(username, windowMinutes = 15) {
        const result = await db.get(
            `SELECT COUNT(*) as count FROM login_attempts
             WHERE username = ? AND successful = ? AND ${this._withinMinutes('attemptedAt')}
               AND ${this._sinceLastSuccess('attemptedAt')}`,
            [username, false, windowMinutes, username]
        );
        return result ? result.count : 0;
    }

    /** Get failed attempts count for IP in time window */
    async getFailedAttemptsByIP(ipAddress, windowMinutes = 15) {
        const result = await db.get(
            `SELECT COUNT(*) as count FROM login_attempts
             WHERE ipAddress = ? AND successful = ? AND ${this._withinMinutes('attemptedAt')}`,
            [ipAddress, false, windowMinutes]
        );
        return result ? result.count : 0;
    }

    /**
     * Lift the lock for a username WITHOUT deleting anything: append a 'reset'
     * marker, from which the lock window restarts. Kept under its historical
     * name — every caller (successful login, admin unlock, employee unlock)
     * means "start counting again", none of them means "forget the failures".
     */
    async clearFailedAttempts(username) {
        return await db.run(
            `INSERT INTO login_attempts (username, ipAddress, attemptedAt, successful, kind)
             VALUES (?, NULL, ${NOW_EXPR}, NULL, 'reset')`,
            [username]
        );
    }

    /** Clean up old login attempts (older than 7 days) */
    async cleanupOldAttempts() {
        return await db.run(
            IS_PG
                ? `DELETE FROM login_attempts WHERE attemptedAt < now() - interval '7 days'`
                : `DELETE FROM login_attempts WHERE datetime(attemptedAt) < datetime('now', '-7 days')`
        );
    }
}

module.exports = new LoginAttemptModel();
