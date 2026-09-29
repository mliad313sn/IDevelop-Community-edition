'use strict';

/**
 * CancellationService — cancelling a coaching plan, a mentoring plan, a PIP or
 * an IDP, under a local admin's approval, with the whole story kept.
 *
 * THE RULES
 *   1. A manager or an admin may REQUEST a cancellation, always with a reason.
 *   2. Only a LOCAL ADMIN (or SuperAdmin) covering that employee may DECIDE.
 *   3. The requester can never be the approver — a cancellation always passes
 *      through a second pair of eyes, the same two-person rule the
 *      maker-checker queue applies to other sensitive actions.
 *   4. NOTHING IS DELETED. On approval the plan moves to a cancelled state and
 *      the request row keeps who asked, why, who decided, when, and what the
 *      state was before. The plan and all its history stay queryable.
 *
 * The database enforces 2 and 4 independently (chk_cancel_decided_by_admin,
 * NOT NULL reason), so this service is the convenient path, not the only guard.
 */

const db = require('../config/database');
const LogService = require('./LogService');
const GovernanceService = require('./GovernanceService');
const { isSamePerson } = require('../utils/personIdentity');

/**
 * How each supported plan maps onto its table. Coaching and mentoring share
 * `coaching_plans`, distinguished by `kind` — the request records which one was
 * meant so the trail reads correctly.
 */
/*
 * `terminal` is PER TABLE and lists only labels that exist in that column's own
 * vocabulary. `pips.state` (enum pip_state) and `idp_plans.status` (enum
 * idp_status) have DIFFERENT label sets, and `coaching_plans.state` is text under
 * a CHECK. Naming a label from another type inside SQL against an enum column is
 * not an empty match, it is error 22P02 — so the SQL guards below use the
 * per-table list, never a shared one.
 */
const ENTITIES = {
    coaching: {
        table: 'coaching_plans',
        stateCol: 'state',
        cancelled: 'cancelled',
        kind: 'coach',
        terminal: ['completed', 'cancelled'],
    },
    mentoring: {
        table: 'coaching_plans',
        stateCol: 'state',
        cancelled: 'cancelled',
        kind: 'mentor',
        terminal: ['completed', 'cancelled'],
    },
    pip: {
        table: 'pips',
        stateCol: 'state',
        cancelled: 'cancelled',
        terminal: ['closed_success', 'closed_failure', 'cancelled'],
    },
    idp: {
        table: 'idp_plans',
        stateCol: 'status',
        cancelled: 'cancelled',
        terminal: ['completed', 'archived', 'cancelled'],
    },
};

const OPEN = 'pending';
// A plan already in one of these states has nothing left to cancel. Union of the
// per-table lists — safe for a JavaScript string comparison (never used in SQL).
const TERMINAL = new Set(Object.values(ENTITIES).flatMap((s) => s.terminal));

// Decision authority comes from the permission CATALOGUE, not from the shape of
// the role. The old OR-over-role-names let a read-only Viewer (and the dead
// `hr_bp` role) decide cancellations with zero grants.
function isAdmin(user) {
    return require('./RBACService').hasPermission(user, 'manage_mobility');
}

const err = (code) => {
    const e = new Error(code);
    e.userMessage = code;
    return e;
};

const CancellationService = {
    ENTITIES,

    /** Load a plan and its current state, whatever table it lives in. */
    async _loadPlan(entityType, entityId) {
        const spec = ENTITIES[entityType];
        if (!spec) throw err('unknown_entity_type');
        const row = await db.get(
            `SELECT id, employee_id AS "employeeId", ${spec.stateCol} AS "state"
             FROM ${spec.table} WHERE id = ?`,
            [entityId]
        );
        return row ? { ...row, spec } : null;
    },

    /**
     * Request a cancellation. Manager or admin, always with a reason, always
     * inside their own scope.
     */
    async request(user, { entityType, entityId, reason }) {
        if (!ENTITIES[entityType]) throw err('unknown_entity_type');
        if (!reason || !String(reason).trim()) throw err('reason_required');
        if (!isAdmin(user) && user.userType !== 'manager') throw err('not_allowed');

        const plan = await this._loadPlan(entityType, entityId);
        if (!plan) throw err('not_found');
        if (TERMINAL.has(String(plan.state))) throw err('already_closed');

        // Scope: you may only ask to cancel a plan belonging to somebody you
        // are responsible for.
        if (!(await GovernanceService.canReview(user, plan.employeeId))) throw err('out_of_scope');

        const existing = await db.get(
            'SELECT id FROM cancellation_requests WHERE entity_type = ? AND entity_id = ? AND state = ?',
            [entityType, entityId, OPEN]
        );
        if (existing) throw err('already_pending');

        const asAdmin = isAdmin(user);
        const row = await db.run(
            `INSERT INTO cancellation_requests
                (entity_type, entity_id, employee_id, reason, previous_state,
                 requested_by_employee_id, requested_by_admin_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                entityType,
                entityId,
                plan.employeeId,
                String(reason).trim().slice(0, 2000),
                String(plan.state ?? ''),
                asAdmin ? null : user.id,
                asAdmin ? user.id : null,
            ]
        );

        await LogService.log({
            adminId: asAdmin ? user.id : null,
            action: 'CANCELLATION_REQUESTED',
            entityType,
            entityId: Number(entityId),
            details: JSON.stringify({
                reason: String(reason).trim().slice(0, 500),
                previousState: plan.state,
            }),
        });
        return row;
    },

    /**
     * Decide. ADMIN ONLY, never the requester, and only inside their scope.
     * On approval the plan is marked cancelled — never removed.
     */
    async decide(user, id, approve, note) {
        if (!isAdmin(user)) throw err('admin_only');

        const r = await db.get(
            `SELECT id, entity_type AS "entityType", entity_id AS "entityId", employee_id AS "employeeId",
                    state::text AS "state", requested_by_admin_id AS "byAdmin",
                    requested_by_employee_id AS "byEmployee"
             FROM cancellation_requests WHERE id = ?`,
            [id]
        );
        if (!r) throw err('not_found');
        if (r.state !== OPEN) throw err('already_decided');

        // Two-person rule: the person who asked cannot be the one who approves.
        // Compared by PERSON, not by account (3.23.17, B-3): a manager who asked
        // on their employee account and decides on their linked admin account
        // (admins.linked_employee_id) is still the same pair of eyes.
        if (
            (r.byAdmin != null && (await isSamePerson(user, { adminId: r.byAdmin }))) ||
            (r.byEmployee != null && (await isSamePerson(user, { employeeId: r.byEmployee })))
        )
            throw err('requester_cannot_approve');

        if (!(await GovernanceService.canReview(user, r.employeeId))) throw err('out_of_scope');

        const spec = ENTITIES[r.entityType];
        if (!spec) throw err('unknown_entity_type');

        await db.runTransaction(async () => {
            const { changes } = await db.run(
                `UPDATE cancellation_requests
                 SET state = ?, decided_by_admin_id = ?, decided_at = now(), decision_note = ?
                 WHERE id = ? AND state = ?`,
                [
                    approve ? 'approved' : 'rejected',
                    user.id,
                    note ? String(note).trim().slice(0, 2000) : null,
                    id,
                    OPEN,
                ]
            );
            // Rowcount guard: two admins deciding at once must not both apply.
            if (!changes) throw err('already_decided');

            if (approve) {
                // The plan's CURRENT state, re-read inside the transaction and
                // locked. The request captured `previous_state` when it was
                // raised; the plan may have finished since (a PIP closed with its
                // outcome, an IDP completed). Approving a stale request must not
                // overwrite that verdict with 'cancelled' — the request's own
                // TERMINAL guard lived only in request, so a finished plan was
                // silently turned into a cancelled one while keeping its outcome.
                const plan = await db.get(
                    `SELECT id, ${spec.stateCol}::text AS "state" FROM ${spec.table}
                     WHERE id = ? FOR UPDATE`,
                    [r.entityId]
                );
                if (!plan) throw err('not_found');
                if (TERMINAL.has(String(plan.state))) throw err('already_closed');

                // Mark cancelled — never DELETE. The plan, its objectives, its
                // sessions and its history all remain queryable. The state guard
                // in SQL is the per-table label list (enum discipline) and the
                // rowcount check closes the race the lock already narrows.
                const upd = await db.run(
                    `UPDATE ${spec.table} SET ${spec.stateCol} = ?
                     WHERE id = ? AND ${spec.stateCol} NOT IN (${spec.terminal.map(() => '?').join(',')})`,
                    [spec.cancelled, r.entityId, ...spec.terminal]
                );
                if (!upd || !upd.changes) throw err('already_closed');

                // A cancelled plan must not keep live work items behind it.
                await this.cascadePlanCancellation(r.entityType, r.entityId);
            }
        });

        await LogService.log({
            adminId: user.id,
            action: approve ? 'CANCELLATION_APPROVED' : 'CANCELLATION_REJECTED',
            entityType: r.entityType,
            entityId: Number(r.entityId),
            details: JSON.stringify({
                requestId: Number(id),
                note: note ? String(note).slice(0, 500) : null,
            }),
        });
        return true;
    },

    /**
     * Cascade a plan cancellation to the live work items hanging off it.
     *
     * Cancelling an IDP used to flip `idp_plans.status` and nothing else: its
     * objectives and actions stayed 'pending', so the employee's Action Center
     * kept listing "development actions to progress" for a plan nobody would
     * ever sign, and the org "IDP completion %" kept them in its denominator.
     * Only OPEN items are touched — anything already completed/cancelled keeps
     * its own history. Nothing is deleted.
     *
     * Exported on purpose: every path that cancels a plan (this queue and the
     * SuperAdmin maintenance override) must leave the same shape behind.
     * Coaching/mentoring actions have no cancelled status in their CHECK
     * (pending|in_progress|done) and PIPs carry no child rows, so those return
     * zeros. Safe to call inside or outside a transaction.
     *
     * @returns {{objectives:number, actions:number}} rows moved to cancelled
     */
    async cascadePlanCancellation(entityType, entityId) {
        const out = { objectives: 0, actions: 0 };
        if (entityType !== 'idp') return out;
        const o = await db.run(
            `UPDATE idp_objectives SET state = 'cancelled', updated_at = now()
             WHERE idp_id = ? AND state IN ('pending', 'in_progress')`,
            [entityId]
        );
        const a = await db.run(
            `UPDATE idp_actions SET status = 'cancelled', updated_at = now()
             WHERE idp_id = ? AND status IN ('pending', 'in_progress')`,
            [entityId]
        );
        out.objectives = Number((o && o.changes) || 0);
        out.actions = Number((a && a.changes) || 0);
        return out;
    },

    /**
     * Withdraw a pending request: the requester themself, or an admin holding
     * manage_mobility whose scope covers the employee. The scope test is the
     * same one decide applies — an admin who could not decide the request
     * must not be able to make it disappear either. Audited like every other
     * transition on the queue.
     */
    async withdraw(user, id) {
        const r = await db.get(
            `SELECT id, entity_type AS "entityType", entity_id AS "entityId",
                    employee_id AS "employeeId", state::text AS "state",
                    requested_by_admin_id AS "byAdmin", requested_by_employee_id AS "byEmployee"
             FROM cancellation_requests WHERE id = ?`,
            [id]
        );
        if (!r) throw err('not_found');
        if (r.state !== OPEN) throw err('already_decided');
        const admin = isAdmin(user);
        const mine =
            (admin && Number(r.byAdmin) === Number(user.id)) ||
            (!admin && Number(r.byEmployee) === Number(user.id));
        if (!mine) {
            if (!admin) throw err('not_yours');
            if (!(await GovernanceService.canReview(user, r.employeeId))) throw err('out_of_scope');
        }
        const { changes } = await db.run(
            "UPDATE cancellation_requests SET state = 'withdrawn' WHERE id = ? AND state = ?",
            [id, OPEN]
        );
        if (!changes) throw err('already_decided');
        await LogService.log({
            adminId: admin ? user.id : null,
            action: 'CANCELLATION_WITHDRAWN',
            entityType: r.entityType,
            entityId: Number(r.entityId),
            details: JSON.stringify({
                requestId: Number(id),
                byRequester: mine,
                actor: `${user.userType || (admin ? 'admin' : 'employee')}:${user.id}`,
            }),
        });
        return true;
    },

    /** Scoped queue for the console. */
    async list(user, opts = {}) {
        const ids = await GovernanceService.reviewableEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return [];
        const where = [];
        const params = [];
        if (Array.isArray(ids)) {
            where.push(
                `(q.employee_id IS NULL OR q.employee_id IN (${ids.map(() => '?').join(',')}))`
            );
            params.push(...ids);
        }
        if (opts.state) {
            where.push('q.state = ?');
            params.push(opts.state);
        }
        if (opts.entityType) {
            where.push('q.entity_type = ?');
            params.push(opts.entityType);
        }
        return db.all(
            `SELECT q.id, q.entity_type AS "entityType", q.entity_id AS "entityId", q.state,
                    q.reason, q.previous_state AS "previousState", q.decision_note AS "decisionNote",
                    q.requested_at AS "requestedAt", q.decided_at AS "decidedAt",
                    q.employee_id AS "employeeId", q.employee_name AS "employeeName",
                    q.employee_number AS "employeeNumber", q.site_name AS "siteName",
                    q.department_name AS "departmentName", q.requested_by_name AS "requestedByName",
                    q.requested_by_kind AS "requestedByKind", q.decided_by_name AS "decidedByName"
             FROM v_cancellation_queue q
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY (q.state = 'pending') DESC, q.requested_at DESC
             LIMIT 300`,
            params
        );
    },

    /**
     * The trail for one plan — every request ever raised against it.
     * Columns are aliased explicitly rather than `SELECT *`: the sql-compat
     * layer rewrites result keys, so a caller reading snake_case off a star
     * select silently gets undefined.
     */
    async historyFor(entityType, entityId) {
        return db.all(
            `SELECT id, entity_type AS "entityType", entity_id AS "entityId", state,
                    reason, previous_state AS "previousState", decision_note AS "decisionNote",
                    requested_at AS "requestedAt", decided_at AS "decidedAt",
                    employee_id AS "employeeId", employee_name AS "employeeName",
                    requested_by_name AS "requestedByName", requested_by_kind AS "requestedByKind",
                    decided_by_name AS "decidedByName"
             FROM v_cancellation_queue
             WHERE entity_type = ? AND entity_id = ? ORDER BY requested_at DESC`,
            [entityType, entityId]
        );
    },
};

module.exports = CancellationService;
