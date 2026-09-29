'use strict';

/**
 * RecognitionService — recognition/kudos + continuous (anytime) feedback & praise.
 * Adds the culture/engagement layer that was entirely top-down/evaluative before.
 */
const db = require('../config/database');

const VISIBILITIES = ['team', 'private', 'org'];

/**
 * SQL predicate: is `other` in the team circle of `me`? Both aliases are rows of
 * `employees`. Same department; line relationship either way (supervisor, or an
 * EMPLOYEE-type manager); peers sharing a supervisor or a manager. Pure string
 * building from two fixed aliases — no user input reaches it.
 */
function teamPredicate(me, other) {
    return [
        `${me}.department_id = ${other}.department_id`,
        `${other}.supervisor_id = ${me}.id`,
        `(${other}.manager_type = 'employee' AND ${other}.manager_id = ${me}.id)`,
        `${me}.supervisor_id = ${other}.id`,
        `(${me}.manager_type = 'employee' AND ${me}.manager_id = ${other}.id)`,
        `(${me}.supervisor_id IS NOT NULL AND ${me}.supervisor_id = ${other}.supervisor_id)`,
        `(${me}.manager_id IS NOT NULL AND ${me}.manager_id = ${other}.manager_id AND ${me}.manager_type = ${other}.manager_type)`,
    ].join(' OR ');
}

/**
 * Pure. The WHERE clause (aliases r = recognitions, tf = recipient) and its
 * parameters for a viewer — see RecognitionService.feed.
 */
function feedScope(viewer, visibility = 'team') {
    const orgOnly = "r.visibility = 'org'";
    if (visibility === 'org' || !viewer) return { where: orgOnly, params: [] };
    if (viewer.all) return { where: "r.visibility IN ('team','org')", params: [] };
    const team = [];
    const params = [];
    const me = Number(viewer.employeeId);
    if (me) {
        team.push(
            'r.to_employee_id = ?',
            'r.from_employee_id = ?',
            `EXISTS (SELECT 1 FROM employees me WHERE me.id = ? AND (${teamPredicate('me', 'tf')}))`
        );
        params.push(me, me, me);
    }
    const ids = (viewer.scopeIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (ids.length) {
        team.push('r.to_employee_id = ANY(?::bigint[])');
        params.push(ids);
    }
    if (!team.length) return { where: orgOnly, params: [] };
    return {
        where: `(${orgOnly} OR (r.visibility = 'team' AND (${team.join(' OR ')})))`,
        params,
    };
}

class RecognitionService {
    async give({
        fromEmployeeId = null,
        toEmployeeId,
        valueTag = null,
        message,
        visibility = 'team',
    }) {
        if (!toEmployeeId || !message) throw new Error('toEmployeeId and message required');
        // Unknown visibility values used to be stored verbatim; anything that is
        // not a known level falls back to the default audience.
        if (!VISIBILITIES.includes(visibility)) visibility = 'team';
        const row = await db.get(
            `INSERT INTO recognitions (from_employee_id, to_employee_id, value_tag, message, visibility)
             VALUES (?, ?, ?, ?, ?) RETURNING *`,
            [fromEmployeeId, toEmployeeId, valueTag, message, visibility]
        );
        try {
            await require('./NotificationService').notify({
                userType: 'employee',
                userId: toEmployeeId,
                kind: 'recognition.received',
                category: 'engagement',
                payload: { valueTag, message },
            });
        } catch (_) {
            /* non-blocking */
        }
        return row;
    }
    /**
     * The recognition feed, scoped to the VIEWER.
     *
     * `org` items are organisation-wide. `team` items used to be treated as
     * organisation-wide too — every signed-in person read every "team" thank-you
     * in the company. A `team` item is now shown only to the people around its
     * RECIPIENT: the sender and recipient themselves, the recipient's department,
     * their manager/supervisor, their direct reports and their peers under the
     * same manager/supervisor (see teamPredicate). `private` items never appear in
     * a feed — they are between sender and recipient (see forEmployee).
     *
     * @param {object} [opts]
     * @param {'team'|'org'} [opts.visibility] 'org' restricts to org-wide items.
     * @param {number} [opts.limit]
     * @param {{all?:boolean, employeeId?:number, scopeIds?:number[]}|null} [opts.viewer]
     *   all        — the SuperAdmin: every team item.
     *   employeeId — an employee/manager row: the team items around them.
     *   scopeIds   — the employees an admin/manager governs: team items about them.
     *   Absent/null — fail closed: org-wide items only.
     */
    async feed({ visibility = 'team', limit = 50, viewer = null } = {}) {
        const { where, params } = feedScope(viewer, visibility);
        return db.all(
            `SELECT r.*, tf.first_name AS to_first, tf.last_name AS to_last,
                    ff.first_name AS from_first, ff.last_name AS from_last
             FROM recognitions r
             JOIN employees tf ON tf.id = r.to_employee_id
             LEFT JOIN employees ff ON ff.id = r.from_employee_id
             WHERE ${where}
             ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
            [...params, limit]
        );
    }

    /**
     * The colleagues this employee can thank from their own space: the same
     * circle a team-visible recognition reaches (department, line, peers),
     * active people only, never themselves.
     */
    async colleaguesFor(employeeId, limit = 500) {
        const me = Number(employeeId);
        if (!me) return [];
        return db.all(
            `SELECT tf.id, tf.first_name, tf.last_name
               FROM employees tf
               JOIN employees me ON me.id = ?
              WHERE tf.is_active = true AND tf.id <> me.id AND (${teamPredicate('me', 'tf')})
              ORDER BY tf.last_name, tf.first_name, tf.id
              LIMIT ?`,
            [me, limit]
        );
    }

    /** Is `otherId` in the team circle of `employeeId`? (Thank-a-colleague guard.) */
    async isColleague(employeeId, otherId) {
        const me = Number(employeeId);
        const other = Number(otherId);
        if (!me || !other || me === other) return false;
        const row = await db.get(
            `SELECT 1 AS ok FROM employees tf JOIN employees me ON me.id = ?
              WHERE tf.id = ? AND tf.is_active = true AND (${teamPredicate('me', 'tf')})`,
            [me, other]
        );
        return Boolean(row);
    }

    async forEmployee(employeeId, limit = 50) {
        return db.all(
            'SELECT * FROM recognitions WHERE to_employee_id = ? ORDER BY created_at DESC LIMIT ?',
            [employeeId, limit]
        );
    }

    // ---- Continuous feedback ----------------------------------------------
    async addFeedback({
        aboutEmployeeId,
        authorEmployeeId = null,
        authorAdminId = null,
        kind = 'feedback',
        body,
        visibility = 'manager',
    }) {
        if (!aboutEmployeeId || !body) throw new Error('aboutEmployeeId and body required');
        return db.get(
            `INSERT INTO feedback_notes (about_employee_id, author_employee_id, author_admin_id, kind, body, visibility)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
            [aboutEmployeeId, authorEmployeeId, authorAdminId, kind, body, visibility]
        );
    }
    async feedbackFor(employeeId, limit = 50) {
        return db.all(
            'SELECT * FROM feedback_notes WHERE about_employee_id = ? ORDER BY created_at DESC LIMIT ?',
            [employeeId, limit]
        );
    }
}

module.exports = new RecognitionService();
module.exports.feedScope = feedScope;
module.exports.teamPredicate = teamPredicate;
module.exports.VISIBILITIES = VISIBILITIES;
