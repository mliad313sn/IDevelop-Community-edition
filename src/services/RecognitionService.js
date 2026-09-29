'use strict';

/**
 * RecognitionService — recognition/kudos + continuous (anytime) feedback & praise.
 * Adds the culture/engagement layer that was entirely top-down/evaluative before.
 */
const db = require('../config/database');

class RecognitionService {
    async give({
        fromEmployeeId = null,
        toEmployeeId,
        valueTag = null,
        message,
        visibility = 'team',
    }) {
        if (!toEmployeeId || !message) throw new Error('toEmployeeId and message required');
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
    async feed({ visibility = 'team', limit = 50 } = {}) {
        return db.all(
            `SELECT r.*, tf.first_name AS to_first, tf.last_name AS to_last,
                    ff.first_name AS from_first, ff.last_name AS from_last
             FROM recognitions r
             JOIN employees tf ON tf.id = r.to_employee_id
             LEFT JOIN employees ff ON ff.id = r.from_employee_id
             WHERE r.visibility IN ('team','org') ${visibility === 'org' ? "AND r.visibility = 'org'" : ''}
             ORDER BY r.created_at DESC LIMIT ?`,
            [limit]
        );
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
