'use strict';
/**
 * TalentTaskService — the queue that replaces the software opening a
 * performance-improvement plan by itself (HR policy, arbitration A3:
 * "le système propose une tâche, le manager décide et motive").
 *
 * BEFORE: approving a low-performance placement INSERTed a PIP and a coaching
 * plan inside the approval transaction. A plan that can end an employment was
 * opened by nobody, with a boilerplate reason, and — measured on a development database — PIP #12
 * then sat in 'proposed' from 2026-06-15 until its own end date with no
 * objectives, no success criteria and no review checkpoints.
 *
 * AFTER: the placement raises ONE task addressed to the person's hierarchical
 * superior. The manager either opens the plan, giving a written reason that goes
 * onto the task AND becomes the plan's summary, or records that no plan is
 * needed — also with a reason. Either way a human decided and said why.
 *
 * CONFIDENTIALITY: a task row stores no grid vocabulary. `origin_evaluation_id`
 * is provenance only (same rule as pips.origin_evaluation_id) and is never read
 * by an authorization or disclosure check.
 */
const db = require('../config/database');
const LogService = require('./LogService');
const RBACService = require('./RBACService');

const KIND_OPEN_PIP = 'open_pip';

class TalentTaskService {
    /**
     * The EMPLOYEE a task is addressed to: the effective reviewer when that is
     * an employee (ACTIVE supervisor, else ACTIVE employee-manager — 3.23.18 R2,
     * ReportingLineService). A departed supervisor no longer swallows the task;
     * an admin-managed person gets NULL here (the column is an employee FK) and
     * the managing admin is notified instead (DevelopmentTriggerService).
     */
    async _superiorOf(employeeId) {
        const r = await require('./ReportingLineService')
            .effectiveReviewer(employeeId)
            .catch(() => null);
        return r && r.type === 'employee' && r.id !== Number(employeeId) ? r.id : null;
    }

    /**
     * Raise (or reuse) the "open a PIP" task for a person.
     *
     * Idempotent by construction: `uq_tmt_open_per_employee_kind` is a partial
     * unique index on the OPEN rows, and the ON CONFLICT below turns a concurrent
     * second placement into a no-op instead of a unique violation that would
     * poison the enclosing 9-box approve transaction — the same guard
     * PipService.proposeDirect uses. Re-placing someone in the red zone (which
     * the 9-box explicitly allows, without limit) therefore never stacks tasks.
     *
     * @returns {{ id:number, created:boolean, assigneeId:number|null }}
     */
    async raisePipTask({ employeeId, originEvaluationId = null, originKind = 'ninebox_approval' }) {
        const assigneeId = await this._superiorOf(employeeId);
        const row = await db.get(
            `INSERT INTO talent_manager_tasks (employee_id, assignee_employee_id, kind, state, origin_evaluation_id, origin_kind)
             VALUES (?, ?, ?, 'open', ?, ?)
             ON CONFLICT (employee_id, kind) WHERE state = 'open' DO NOTHING
             RETURNING id`,
            [employeeId, assigneeId, KIND_OPEN_PIP, originEvaluationId || null, originKind]
        );
        if (row) return { id: Number(row.id), created: true, assigneeId };
        const existing = await db.get(
            "SELECT id, assignee_employee_id FROM talent_manager_tasks WHERE employee_id = ? AND kind = ? AND state = 'open' LIMIT 1",
            [employeeId, KIND_OPEN_PIP]
        );
        return existing
            ? {
                  id: Number(existing.id),
                  created: false,
                  assigneeId: existing.assigneeEmployeeId || assigneeId,
              }
            : { id: null, created: false, assigneeId };
    }

    /** Open tasks the caller is cleared for, newest first. */
    async listOpen(user) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        return db.all(
            `SELECT t.id, t.employee_id, t.kind, t.state, t.origin_evaluation_id, t.origin_kind, t.created_at,
                    e.first_name, e.last_name, e.employee_number
               FROM talent_manager_tasks t JOIN employees e ON e.id = t.employee_id
              WHERE t.state = 'open' ${sc.clause}
              ORDER BY t.created_at DESC, t.id DESC`,
            sc.params
        );
    }

    /** One task, or null. No clearance check here — the caller does it (it needs the employee id). */
    async get(taskId) {
        return db.get('SELECT * FROM talent_manager_tasks WHERE id = ?', [Number(taskId) || 0]);
    }

    /**
     * Close a task. A written reason is MANDATORY in both directions — the
     * database CHECK (chk_tmt_resolved_complete) is the backstop, this is the
     * message the manager actually reads.
     *
     * @param {'plan_opened'|'no_plan'} resolution
     */
    async resolve(taskId, user, { resolution, reason, targetId = null }, req = null) {
        if (!['plan_opened', 'no_plan'].includes(resolution))
            throw new Error('Unknown task resolution');
        const clean = reason == null ? '' : String(reason).trim();
        if (!clean) {
            const e = new Error('Un motif écrit est obligatoire pour clore cette tâche.');
            e.code = 'REASON_REQUIRED';
            e.status = 400;
            e.expose = true;
            throw e;
        }
        const isAdmin = Boolean(user && user.userType === 'admin');
        const row = await db.get(
            `UPDATE talent_manager_tasks
                SET state = ?, resolution = ?, resolution_reason = ?, resolved_at = now(),
                    resolved_by_employee_id = ?, resolved_by_admin_id = ?, resolved_target_id = ?
              WHERE id = ? AND state = 'open'
              RETURNING id, employee_id`,
            [
                resolution === 'plan_opened' ? 'done' : 'dismissed',
                resolution,
                clean.slice(0, 2000),
                isAdmin ? null : (user && user.id) || null,
                isAdmin ? (user && user.id) || null : null,
                targetId != null ? Number(targetId) : null,
                Number(taskId) || 0,
            ]
        );
        if (!row) return null;
        // The decision is journaled WITH its author: `actor_ref` names the
        // manager (an employee, never written into admin_id — FK admins, and an
        // admin homonym would be credited). Measured before: TALENT_TASK_DISMISSED
        // with admin_id NULL and actor_ref NULL for manager 137. In a savepoint
        // so a swallowed log failure cannot poison a caller's transaction.
        try {
            await db.runInSavepoint(() =>
                LogService.log({
                    adminId: isAdmin ? user.id : null,
                    actorRef:
                        user && user.id != null
                            ? `${isAdmin ? 'admin' : 'employee'}:${user.id}`
                            : null,
                    action:
                        resolution === 'plan_opened'
                            ? 'TALENT_TASK_PLAN_OPENED'
                            : 'TALENT_TASK_DISMISSED',
                    entityType: 'talentTask',
                    entityId: Number(row.id),
                    details: `employee ${row.employeeId}: ${clean.slice(0, 300)}`,
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                })
            );
        } catch (_) {
            /* the decision must not fail because the log did */
        }
        return row;
    }
}

module.exports = new TalentTaskService();
module.exports.KIND_OPEN_PIP = KIND_OPEN_PIP;
