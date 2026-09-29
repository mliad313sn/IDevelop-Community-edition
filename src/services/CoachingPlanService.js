'use strict';
/**
 * CoachingPlanService — Phase 3 (Coaching & Mentoring).
 * Plan-centric workflow extending the existing coaching_* tables.
 *   Supervisor creates plan -> employee executes/updates progress
 *   -> supervisor validates completion -> manager monitors.
 * Same admin-inherits authority model as Phase 2.
 * (db layer returns camelCase keys; raw SQL uses snake_case.)
 */
const db = require('../config/database');
const EmployeeModel = require('../models/EmployeeModel');
const LogService = require('./LogService');
const RBACService = require('./RBACService');
const GovernanceService = require('./GovernanceService');

class CoachingPlanService {
    async resolveAuthority(user, employeeId) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee) throw new Error('Employee not found');
        const isAdmin = Boolean(user && user.userType === 'admin');
        const isSuper = RBACService.isSuperAdmin(user);
        const isLocalAdmin = RBACService.isLocalAdmin(user);
        const isViewer = RBACService.isViewer(user);
        // THE PERSON BEHIND THE ACCOUNT + the manager_type discriminator — the
        // predicate of SelfAssessmentWorkflowService.resolveAuthority (the
        // reference). `manager_id` is polymorphic and the employee/admin id spaces
        // overlap: compared without `manager_type`, employee 145 was canManage
        // over 139 whose manager is ADMIN 145. And a manager on their LINKED admin
        // account compared the admin id to the line and lost their team.
        const personId = await GovernanceService.actingPersonId(user);
        const isSelf = personId != null && personId === Number(employeeId);
        const isSupervisor = Boolean(
            personId != null &&
            employee.supervisorId != null &&
            personId === Number(employee.supervisorId)
        );
        const isManager = Boolean(
            (personId != null &&
                employee.managerId != null &&
                employee.managerType === 'employee' &&
                personId === Number(employee.managerId)) ||
            (isAdmin &&
                employee.managerId != null &&
                employee.managerType === 'admin' &&
                Number(user.id) === Number(employee.managerId))
        );
        // Clearance: admin scopes only (super admin → all).
        const inClearance = isSuper
            ? true
            : isAdmin
              ? await RBACService.canAccessEmployeeData(user, employee)
              : false;
        // Reading scope: clearance UNION the reporting line — the sub-tree,
        // matching the coaching LIST beside it (which uses scopeFilter).
        const inScope = Boolean(
            inClearance ||
            isSupervisor ||
            isManager ||
            (personId != null && (await EmployeeModel.governs(personId, employeeId)))
        );
        // Acting: a local admin inside their CLEARANCE, a supervisor/manager on
        // their direct link. `!isViewer` keeps a read-only delegation read-only.
        const canSupervise =
            !isViewer &&
            Boolean(isSuper || (isLocalAdmin && inClearance) || isSupervisor || isManager);
        const canManage =
            !isViewer && Boolean(isSuper || (isLocalAdmin && inClearance) || isManager);
        // canView = read access: self, or anyone (incl. viewers) whose scope covers this
        // employee. Never the raw `isAdmin` flag — that would let an out-of-scope admin
        // read confidential plans across the whole org (IDOR).
        const canView = Boolean(isSelf || inScope);
        return {
            employee,
            isAdmin,
            isSelf,
            isViewer,
            inScope,
            canView,
            canSupervise,
            canManage,
            personId,
        };
    }

    /**
     * Actor named by `actor_ref`, `admin_id` only for an administrator, the write
     * contained in a SAVEPOINT — see NineBoxService._audit for the measured
     * failure (23503 then 25P02 inside a caller's transaction; DevelopmentTrigger
     * Service.createSupportCoaching runs createPlan inside the 9-box approve
     * transaction, so this exact write used to poison a red-zone approval).
     */
    async _audit(req, action, id, details) {
        const u = req && req.user;
        const isAdmin = Boolean(u && u.userType === 'admin');
        try {
            await db.runInSavepoint(() =>
                LogService.log({
                    adminId: isAdmin && u.id != null ? u.id : null,
                    actorRef:
                        u && u.id != null ? `${isAdmin ? 'admin' : 'employee'}:${u.id}` : null,
                    action,
                    entityType: 'coachingPlan',
                    entityId: id,
                    details,
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                })
            );
        } catch (_) {
            /* audit must never break the transition */
        }
    }

    /**
     * `coaching_sessions.coach_id` is a foreign key to EMPLOYEES: the coach is a
     * person. An administrator's account id written there named whichever
     * employee shares the number (admin 87 / employee 87 coexist) or failed the
     * FK. The coach is the person behind the account, or nobody.
     */
    _coachIdFor(auth, user) {
        if (auth && auth.personId != null) return auth.personId;
        if (user && user.userType !== 'admin' && user.id != null) return Number(user.id);
        return null;
    }

    async getPlan(id) {
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [id]);
        if (!plan) return null;
        plan.actions = await db.all(
            'SELECT * FROM coaching_plan_actions WHERE plan_id = ? ORDER BY id',
            [id]
        );
        plan.context = await this._contextLabel(plan);
        return plan;
    }

    /**
     * Coaching/mentoring must be done IN CONTEXT. Validate and resolve the
     * requested context (an IDP, a PIP, or a skill gap) for the employee.
     * Returns { contextType, idpId, pipId, skillId }.
     */
    async _resolveContext(employeeId, data) {
        const type = data.contextType;
        if (!['idp', 'pip', 'skill_gap'].includes(type)) {
            throw new Error(
                'A coaching/mentoring plan must be linked to a context: an IDP, a PIP, or a skill gap'
            );
        }
        const ctx = { contextType: type, idpId: null, pipId: null, skillId: null };
        if (type === 'idp') {
            const idp = await db.get('SELECT employee_id FROM idp_plans WHERE id = ?', [
                data.idpId,
            ]);
            if (!idp) throw new Error('Selected IDP not found');
            if (Number(idp.employeeId) !== Number(employeeId))
                throw new Error('Selected IDP does not belong to this employee');
            ctx.idpId = Number(data.idpId);
        } else if (type === 'pip') {
            const pip = await db.get('SELECT employee_id FROM pips WHERE id = ?', [data.pipId]);
            if (!pip) throw new Error('Selected PIP not found');
            if (Number(pip.employeeId) !== Number(employeeId))
                throw new Error('Selected PIP does not belong to this employee');
            ctx.pipId = Number(data.pipId);
        } else {
            const skill = await db.get('SELECT id FROM skills WHERE id = ?', [data.skillId]);
            if (!skill) throw new Error('Selected skill not found');
            ctx.skillId = Number(data.skillId);
        }
        return ctx;
    }

    /** Build a human-readable context label for a plan row. */
    async _contextLabel(plan) {
        if (!plan || !plan.contextType) return null;
        if (plan.contextType === 'idp') {
            const idp = await db.get('SELECT status, priority FROM idp_plans WHERE id = ?', [
                plan.idpId,
            ]);
            return {
                type: 'idp',
                id: plan.idpId,
                label: `IDP #${plan.idpId}${idp ? ' — ' + idp.status : ''}`,
            };
        }
        if (plan.contextType === 'pip') {
            const pip = await db.get('SELECT state, summary FROM pips WHERE id = ?', [plan.pipId]);
            return {
                type: 'pip',
                id: plan.pipId,
                label: `PIP #${plan.pipId}${pip ? ' — ' + pip.state : ''}`,
            };
        }
        if (plan.contextType === 'skill_gap') {
            const s = await db.get('SELECT name FROM skills WHERE id = ?', [plan.skillId]);
            return {
                type: 'skill_gap',
                id: plan.skillId,
                label: `Skill gap: ${s ? s.name : '#' + plan.skillId}`,
            };
        }
        return null;
    }

    /**
     * Context options the supervisor can attach a plan to for one employee:
     * their IDPs, PIPs, and current skill gaps (required level > current level).
     */
    async contextOptions(user, employeeId) {
        const auth = await this.resolveAuthority(user, employeeId);
        if (!auth.canSupervise) throw new Error('Not authorized: supervisor/admin only');
        const idps = await db.all(
            `SELECT id, status, priority, starts_on, ends_on FROM idp_plans
             WHERE employee_id = ? AND status <> 'archived' ORDER BY created_at DESC`,
            [employeeId]
        );
        const pips = await db.all(
            `SELECT id, state, summary, starts_on, ends_on FROM pips
             WHERE employee_id = ? AND state NOT IN ('closed_success','closed_failure','cancelled')
             ORDER BY created_at DESC`,
            [employeeId]
        );
        const gaps = await db.all(
            `SELECT s.id AS skill_id, s.name AS skill_name, rsr.required_level AS required,
                    COALESCE(sa.current_level, 0) AS current, rsr.is_critical
             FROM employees e
             JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
             JOIN skills s ON s.id = rsr.skill_id
             LEFT JOIN skill_assessments sa ON sa.employee_id = e.id AND sa.skill_id = rsr.skill_id
             WHERE e.id = ? AND rsr.required_level > COALESCE(sa.current_level, 0)
             ORDER BY (rsr.required_level - COALESCE(sa.current_level, 0)) DESC, rsr.is_critical DESC, s.name`,
            [employeeId]
        );
        return { idps, pips, gaps };
    }

    /** Supervisor (or admin) creates and assigns a plan. */
    async createPlan(user, data, req = null) {
        const auth = await this.resolveAuthority(user, data.employeeId);
        if (!auth.canSupervise) throw new Error('Not authorized: supervisor/admin only');
        if (!data.title) throw new Error('Title required');
        const ctx = await this._resolveContext(data.employeeId, data);
        const kind = data.kind === 'mentoring' ? 'mentoring' : 'coaching';
        const plan = await db.get(
            `INSERT INTO coaching_plans (employee_id, created_by, mentor_id, kind, title, objective, expected_outcome, target_date, state, context_type, idp_id, pip_id, skill_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) RETURNING *`,
            [
                data.employeeId,
                auth.isAdmin ? null : user.id,
                data.mentorId || null,
                kind,
                data.title,
                data.objective || null,
                data.expectedOutcome || null,
                data.targetDate || null,
                ctx.contextType,
                ctx.idpId,
                ctx.pipId,
                ctx.skillId,
            ]
        );
        if (Array.isArray(data.actions)) {
            for (const a of data.actions) {
                if (a && a.description)
                    await db.run(
                        'INSERT INTO coaching_plan_actions (plan_id, description, due_on) VALUES (?, ?, ?)',
                        [plan.id, a.description, a.dueOn || null]
                    );
            }
        }
        await this._audit(
            req,
            'COACHING_PLAN_CREATED',
            plan.id,
            `created ${kind} plan for employee ${data.employeeId} (context: ${ctx.contextType})`
        );
        // Notify the employee a coaching/mentoring plan was created (best-effort).
        // AWAITED. Left un-awaited, this query and the `getPlan` on the next line
        // ran CONCURRENTLY on the same transaction client — the source of the
        // "client.query when the client is already executing a query" warning.
        // Under pg 9 that throws, and combined with the abort-on-error rule it
        // would have turned every red-zone approval into a silent rollback. The
        // notice could also be dispatched after the client was released, so the
        // employee placed under a PIP was never told about the support attached
        // to it. `notify` contains its own failures in a savepoint.
        try {
            await require('./NotificationService').notify({
                userType: 'employee',
                userId: data.employeeId,
                kind: 'coaching.created',
                category: 'coaching',
                payload: { kind, title: data.title },
            });
        } catch (_) {
            /* never block plan creation on notification */
        }
        return this.getPlan(plan.id);
    }

    async addAction(user, planId, { description, dueOn }, req = null) {
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [planId]);
        if (!plan) throw new Error('Plan not found');
        const auth = await this.resolveAuthority(user, plan.employeeId);
        if (!auth.canSupervise) throw new Error('Not authorized: supervisor/admin only');
        if (!description) throw new Error('Description required');
        const a = await db.get(
            'INSERT INTO coaching_plan_actions (plan_id, description, due_on) VALUES (?, ?, ?) RETURNING *',
            [planId, description, dueOn || null]
        );
        await this._audit(req, 'COACHING_ACTION_ADDED', planId, `action added`);
        return a;
    }

    /** Employee updates overall plan progress. */
    async updateProgress(user, planId, { progress, note }, req = null) {
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [planId]);
        if (!plan) throw new Error('Plan not found');
        const auth = await this.resolveAuthority(user, plan.employeeId);
        // Write access: the plan owner, or an in-scope non-viewer admin. Raw isAdmin
        // (unscoped, and true for read-only viewers) must not gate a mutation.
        if (!auth.isSelf && !(auth.isAdmin && auth.inScope && !auth.isViewer))
            throw new Error('Not authorized: plan owner/admin only');
        const p = Math.max(0, Math.min(100, Number(progress)));
        await db.run('UPDATE coaching_plans SET progress = ?, updated_at = now() WHERE id = ?', [
            p,
            planId,
        ]);
        // The note is a session row and its coach is a PERSON (FK employees): an
        // administration account with no linked person leaves no session — the
        // progress itself is still recorded.
        const coachId = this._coachIdFor(auth, user);
        if (note && coachId != null)
            await db.run(
                'INSERT INTO coaching_sessions (employee_id, coach_id, kind, session_at, agenda, plan_id) VALUES (?, ?, ?, now(), ?, ?)',
                [
                    plan.employeeId,
                    coachId,
                    plan.kind === 'mentoring' ? 'mentor' : 'coach',
                    note,
                    planId,
                ]
            );
        await this._audit(req, 'COACHING_PROGRESS', planId, `progress -> ${p}%`);
        return this.getPlan(planId);
    }

    /** Employee acknowledges / progresses / completes an action. */
    async updateAction(user, actionId, { status, progressNote }, req = null) {
        const action = await db.get('SELECT * FROM coaching_plan_actions WHERE id = ?', [actionId]);
        if (!action) throw new Error('Action not found');
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [action.planId]);
        const auth = await this.resolveAuthority(user, plan.employeeId);
        // Write access: the plan owner, or an in-scope non-viewer admin. Raw isAdmin
        // (unscoped, and true for read-only viewers) must not gate a mutation.
        if (!auth.isSelf && !(auth.isAdmin && auth.inScope && !auth.isViewer))
            throw new Error('Not authorized: plan owner/admin only');
        const st = ['pending', 'in_progress', 'done'].includes(status) ? status : action.status;
        const sets = ['status = ?'];
        const vals = [st];
        if (progressNote != null) {
            sets.push('progress_note = ?');
            vals.push(progressNote);
        }
        if (!action.acknowledgedAt) {
            sets.push('acknowledged_at = now()');
        }
        if (st === 'done') {
            sets.push('completed_at = now()');
        }
        vals.push(actionId);
        await db.run(`UPDATE coaching_plan_actions SET ${sets.join(', ')} WHERE id = ?`, vals);
        await this._audit(
            req,
            'COACHING_ACTION_UPDATE',
            action.planId,
            `action ${actionId} -> ${st}`
        );
        return db.get('SELECT * FROM coaching_plan_actions WHERE id = ?', [actionId]);
    }

    /** Supervisor records a session note against the plan. */
    async recordSession(user, planId, { note }, req = null) {
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [planId]);
        if (!plan) throw new Error('Plan not found');
        const auth = await this.resolveAuthority(user, plan.employeeId);
        if (!auth.canSupervise) throw new Error('Not authorized: supervisor/admin only');
        const coachId = this._coachIdFor(auth, user);
        if (coachId == null) {
            // FK employees: an administration account that names no person
            // cannot be written as the coach — it would name a stranger or fail.
            const e = new Error(
                'Only a person can record a coaching session: this administration account is linked to no employee.'
            );
            e.code = 'NO_ACTING_PERSON';
            e.status = 400;
            e.expose = true;
            throw e;
        }
        await db.run(
            'INSERT INTO coaching_sessions (employee_id, coach_id, kind, session_at, agenda, plan_id) VALUES (?, ?, ?, now(), ?, ?)',
            [
                plan.employeeId,
                coachId,
                plan.kind === 'mentoring' ? 'mentor' : 'coach',
                note || null,
                planId,
            ]
        );
        await this._audit(req, 'COACHING_SESSION_NOTE', planId, 'session note recorded');
        return { ok: true };
    }

    /** Supervisor validates completion. */
    async validateCompletion(user, planId, req = null) {
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [planId]);
        if (!plan) throw new Error('Plan not found');
        const auth = await this.resolveAuthority(user, plan.employeeId);
        if (!auth.canSupervise) throw new Error('Not authorized: supervisor/admin only');
        // Only a LIVE plan can be validated. Guarding 'completed' alone let a plan
        // cancelled through the two-person queue be resurrected to completed /
        // progress 100 by one click, with the cancellation trail still saying it
        // was cancelled. Positive check: anything but 'active' is refused.
        if (plan.state !== 'active') throw new Error(`Cannot validate from '${plan.state}'`);
        await db.run(
            'UPDATE coaching_plans SET state = ?, progress = 100, validated_by = ?, validated_at = now(), updated_at = now() WHERE id = ?',
            ['completed', auth.isAdmin ? null : user.id, planId]
        );
        await this._audit(req, 'COACHING_PLAN_VALIDATED', planId, 'completion validated');
        // Tell the employee their coaching plan was completed/validated.
        try {
            await require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: Number(plan.employeeId),
                    kind: 'coaching.validated',
                    category: 'coaching',
                    payload: { link: '/employee/my-coaching' },
                })
                .catch(() => {});
        } catch (_) {
            /* never block */
        }
        return this.getPlan(planId);
    }

    /**
     * Cancelling a coaching/mentoring plan is a GOVERNED action: it files a
     * cancellation request (reason mandatory) that a different local admin
     * decides — the same two-person queue every other plan type goes through
     * (CancellationService). This method used to flip the row to 'cancelled'
     * directly, from ANY state including 'completed', on one person's say-so
     * and with no cancellation_requests trace. It now never mutates the plan:
     * the state stays as it is until an admin approves the request.
     *
     * `reqOrOpts` is the Express request (reason read from `req.body.reason`)
     * or a plain `{ reason }` for non-HTTP callers.
     * @returns the plan, plus `cancellationRequest: { id, state: 'pending' }`
     */
    async cancelPlan(user, planId, reqOrOpts = null) {
        const plan = await db.get('SELECT * FROM coaching_plans WHERE id = ?', [planId]);
        if (!plan) throw new Error('Plan not found');
        const auth = await this.resolveAuthority(user, plan.employeeId);
        if (!auth.canSupervise) throw new Error('Not authorized: supervisor/admin only');
        if (plan.state !== 'active' && plan.state !== 'draft') {
            throw new Error(`Cannot cancel from '${plan.state}'`);
        }
        const body = (reqOrOpts && reqOrOpts.body) || reqOrOpts || {};
        const reason = body.reason != null ? String(body.reason).trim() : '';
        if (!reason) throw new Error('A cancellation reason is required');

        const CancellationService = require('./CancellationService');
        const entityType = plan.kind === 'mentoring' ? 'mentoring' : 'coaching';
        let request;
        try {
            request = await CancellationService.request(user, {
                entityType,
                entityId: Number(planId),
                reason,
            });
        } catch (e) {
            // Turn the queue's codes into the domain sentences this API answers
            // with (see utils/apiErrors: "not authorized" → 403, "cannot … from" → 409).
            const code = e && e.userMessage;
            if (code === 'not_allowed' || code === 'out_of_scope')
                throw new Error(
                    'Not authorized: a manager or an administrator covering this employee may request a cancellation'
                );
            if (code === 'already_closed') throw new Error(`Cannot cancel from '${plan.state}'`);
            if (code === 'already_pending')
                throw new Error(
                    'Cannot cancel from a plan whose cancellation request is already pending'
                );
            if (code === 'reason_required') throw new Error('A cancellation reason is required');
            throw e;
        }
        const req = reqOrOpts && reqOrOpts.body ? reqOrOpts : null;
        await this._audit(
            req,
            'COACHING_PLAN_CANCEL_REQUESTED',
            planId,
            `cancellation requested (request ${request && request.lastID ? request.lastID : '?'}) — awaiting admin approval`
        );
        const fresh = await this.getPlan(planId);
        return {
            ...fresh,
            cancellationRequest: {
                id: request && request.lastID ? request.lastID : null,
                state: 'pending',
            },
        };
    }

    /**
     * Employees the user may create coaching/mentoring plans for — their
     * governed set (super admin: all; local admin: scope; manager/supervisor:
     * their reporting sub-tree). Annotated with active plan count.
     */
    async roster(user) {
        const employees = await RBACService.getFilteredEmployees(user);
        const ids = employees.map((e) => Number(e.id));
        const counts = {};
        if (ids.length) {
            const rows = await db.all(
                `SELECT employee_id, COUNT(*)::int AS n FROM coaching_plans
                 WHERE employee_id IN (${ids.map(() => '?').join(', ')}) AND state <> 'cancelled'
                 GROUP BY employee_id`,
                ids
            );
            for (const r of rows) counts[Number(r.employeeId)] = r.n;
        }
        return employees.map((e) => ({
            employeeId: Number(e.id),
            firstName: e.firstName,
            lastName: e.lastName,
            employeeNumber: e.employeeNumber,
            roleName: e.roleName || null,
            serviceName: e.serviceName || null,
            siteName: e.siteName || null,
            planCount: counts[Number(e.id)] || 0,
        }));
    }

    // ---- lists / monitoring ----
    // Build a compact context label for list rows (skill name resolved via JOIN).
    _rowContextLabel(p) {
        if (!p.contextType) return null;
        if (p.contextType === 'idp') return `IDP #${p.idpId}`;
        if (p.contextType === 'pip') return `PIP #${p.pipId}`;
        if (p.contextType === 'skill_gap')
            return `Skill gap: ${p.contextSkillName || '#' + p.skillId}`;
        return null;
    }
    async listForEmployee(employeeId) {
        const rows = await db.all(
            `SELECT p.*, cs.name AS context_skill_name,
                    (SELECT COUNT(*) FROM coaching_plan_actions a WHERE a.plan_id=p.id)::int AS action_count
             FROM coaching_plans p
             LEFT JOIN skills cs ON cs.id = p.skill_id
             WHERE p.employee_id = ? ORDER BY p.updated_at DESC`,
            [employeeId]
        );
        return rows.map((p) => ({ ...p, contextLabel: this._rowContextLabel(p) }));
    }
    async listForSupervisor(user) {
        let where = '1=1';
        const params = [];
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        where += sc.clause;
        params.push(...sc.params);
        const rows = await db.all(
            `SELECT p.*, e.first_name, e.last_name, cs.name AS context_skill_name
             FROM coaching_plans p
             JOIN employees e ON e.id=p.employee_id
             LEFT JOIN skills cs ON cs.id = p.skill_id
             WHERE ${where} ORDER BY p.updated_at DESC`,
            params
        );
        return rows.map((p) => ({ ...p, contextLabel: this._rowContextLabel(p) }));
    }
    /** Manager monitoring: state counts + overdue list. */
    async monitor(user) {
        let where = '1=1';
        const params = [];
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        where += sc.clause;
        params.push(...sc.params);
        const byState = await db.all(
            `SELECT p.state, COUNT(*)::int n FROM coaching_plans p JOIN employees e ON e.id=p.employee_id WHERE ${where} GROUP BY p.state ORDER BY 1`,
            params
        );
        const overdue = await db.all(
            `SELECT p.id, p.title, p.kind, p.target_date, p.progress, e.first_name, e.last_name
                                      FROM coaching_plans p JOIN employees e ON e.id=p.employee_id
                                      WHERE ${where} AND p.state='active' AND p.target_date IS NOT NULL AND p.target_date < CURRENT_DATE
                                      ORDER BY p.target_date`,
            params
        );
        return { byState, overdue };
    }
}

module.exports = new CoachingPlanService();
