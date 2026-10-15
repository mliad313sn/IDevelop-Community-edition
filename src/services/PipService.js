'use strict';

const db = require('../config/database');
const MakerCheckerService = require('./MakerCheckerService');

/**
 *   PipService — proposes a PIP (Maker), HR-BP approves (Checker).
 *   Access to PIP rows is restricted at the route layer: only HR-BP
 *   scoped to the employee's site/department/service may read.
 */
class PipService {
    static register() {
        // Register maker-checker handler — invoked from src/services/maker-checker-handlers.js
        MakerCheckerService.register('pip.create', async ({ payload }) => {
            const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
            await db.run(
                `INSERT INTO pips (employee_id, initiated_by, approved_by, state, starts_on, ends_on, summary)
                 VALUES (?, ?, ?, 'approved', ?, ?, ?)`,
                [p.employeeId, p.initiatedBy, p.checkerId || null, p.startsOn, p.endsOn, p.summary]
            );
        });
    }

    static async propose({ employeeId, initiatedBy, startsOn, endsOn, summary }) {
        return MakerCheckerService.submit({
            kind: 'pip.create',
            payload: { employeeId, initiatedBy, startsOn, endsOn, summary },
            makerId: initiatedBy,
        });
    }

    /**
     * Who may act on a PIP (SA-42): the plan authority, the rule the 9-box
     * approval applies (NineBoxService.resolveAuthority, canApprove):
     *   - the person's direct manager: an employee manager (manager_type
     *     'employee', compared with the person behind the account) or the
     *     admin account named as manager (manager_type 'admin');
     *   - a SuperAdmin, or an administrator whose clearance covers the person.
     * Refused, fail closed: the supervisor (a PIP is the manager's decision),
     * managers higher up the line (they read, they do not act), a read-only
     * delegate, the person themselves from either of their accounts, and
     * anyone when the person cannot be found or a lookup fails.
     */
    static async actingAuthority(user, employeeId) {
        const no = (why) => ({ canAct: false, why });
        try {
            if (!user || employeeId == null) return no('no_user');
            const RBACService = require('./RBACService');
            if (RBACService.isViewer(user)) return no('viewer');
            const GovernanceService = require('./GovernanceService');
            const personId = await GovernanceService.actingPersonId(user);
            if (personId != null && Number(personId) === Number(employeeId)) return no('subject');
            const emp = await require('../models/EmployeeModel').findById(Number(employeeId));
            if (!emp) return no('not_found');
            const isAdmin = user.userType === 'admin';
            if (isAdmin && RBACService.isSuperAdmin(user))
                return { canAct: true, why: 'superadmin' };
            if (isAdmin && (await RBACService.canAccessEmployeeData(user, emp)))
                return { canAct: true, why: 'clearance' };
            if (
                isAdmin &&
                emp.managerType === 'admin' &&
                emp.managerId != null &&
                Number(emp.managerId) === Number(user.id)
            )
                return { canAct: true, why: 'manager' };
            if (
                personId != null &&
                emp.managerType === 'employee' &&
                emp.managerId != null &&
                Number(emp.managerId) === Number(personId)
            )
                return { canAct: true, why: 'manager' };
            return no('not_direct_manager');
        } catch (_) {
            return no('error'); // fail closed
        }
    }

    // pips.initiated_by → admins(id). A manager (employee) isn't an admin, so
    // fall back to the system admin while the manager owns the lifecycle.
    static async _actorAdminId(user) {
        if (user && user.userType === 'admin' && user.id != null) return user.id;
        const a = await db.get("SELECT id FROM admins WHERE username = 'admin'");
        return a ? a.id : null;
    }

    // Notify the PIP's employee of a state change (best-effort, non-blocking).
    // Returns a promise that NEVER rejects, so a caller running inside a DB
    // transaction can `await` it (and have the notification row commit with the
    // plan) while fire-and-forget callers can keep ignoring it.
    static _notifyEmployee(employeeId, kind, payload = {}) {
        if (!employeeId) return Promise.resolve(null);
        try {
            return require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: employeeId,
                    kind,
                    category: 'talent',
                    payload,
                })
                .catch(() => null);
        } catch (_) {
            /* never block the PIP transition */
        }
        return Promise.resolve(null);
    }

    /**
     * Manager-managed model (no HR maker-checker): create the PIP directly.
     * THE ONLY EMITTER OF 'pip.created' — every code path that opens a PIP must
     * come through here, otherwise the plan exists and nobody is told about it.
     *
     * @param {number}  [originEvaluationId]  provenance: the nine_box_evaluations
     *        row whose approval caused this PIP (migration 72). PROVENANCE ONLY —
     *        never read it in an authorization / disclosure check.
     * @param {boolean} [skipIfOpen]  race guard for the automated 9-box trigger:
     *        adds ON CONFLICT DO NOTHING against uq_pip_open_per_employee so a
     *        concurrent placement cannot raise a unique violation that would
     *        poison the enclosing 9-box approve transaction. Returns null when
     *        an open PIP already existed (nothing inserted, nothing notified).
     */
    /**
     * "This person already has an open PIP" — a 409 the route shows verbatim,
     * never the raw unique-violation text.
     */
    static openPipError(employeeId, existingId) {
        const e = new Error(
            'This employee already has an open performance improvement plan (proposed, approved or active); close or cancel it before opening another.'
        );
        e.code = 'PIP_OPEN_EXISTS';
        e.status = 409;
        e.expose = true;
        e.employeeId = Number(employeeId);
        e.existingId = existingId != null ? Number(existingId) : null;
        return e;
    }

    /** ISO 'YYYY-MM-DD' for a date-ish input, or null when absent/unparseable. */
    static _isoDate(v) {
        if (v == null || v === '') return null;
        if (v instanceof Date)
            return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
        const s = String(v).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }

    /**
     * A PIP judges an employee OVER ITS PERIOD, and the dashboard counts a
     * closure as MEASURED only when that period had elapsed at closure. Nothing
     * validated the period on the way in, so a plan whose whole period predated
     * its own creation (ends_on last month) passed the "period observed" test
     * the moment it was closed and counted as a measured success. Refused here,
     * for every caller: an end date must follow the start date, and must not
     * already be in the past when the plan is opened. Absent dates are left to
     * the caller (the measured filter already fails closed on NULL ends_on).
     */
    static validatePeriod({ startsOn, endsOn }) {
        const s = PipService._isoDate(startsOn);
        const e = PipService._isoDate(endsOn);
        const fail = (msg) => {
            const err = new Error(msg);
            err.code = 'INVALID_PERIOD';
            err.status = 400;
            err.expose = true;
            return err;
        };
        if (endsOn != null && endsOn !== '' && !e)
            throw fail('endsOn must be a valid date (YYYY-MM-DD)');
        if (startsOn != null && startsOn !== '' && !s)
            throw fail('startsOn must be a valid date (YYYY-MM-DD)');
        if (s && e && e <= s) throw fail('The PIP end date must be after its start date');
        if (e) {
            const today = new Date().toISOString().slice(0, 10);
            if (e < today) throw fail('The PIP end date cannot already be in the past');
        }
        return { startsOn: s, endsOn: e };
    }

    static async proposeDirect({
        employeeId,
        actor,
        startsOn,
        endsOn,
        summary,
        objectives,
        successCriteria,
        reviewCheckpoints,
        supportOffered,
        originEvaluationId = null,
        skipIfOpen = false,
    }) {
        const adminId = await this._actorAdminId(actor);
        if (!adminId) throw new Error('No admin account available to initiate PIP');
        const period = PipService.validatePeriod({ startsOn, endsOn });
        const onConflict = skipIfOpen
            ? "ON CONFLICT (employee_id) WHERE state IN ('proposed','approved','active') DO NOTHING "
            : '';
        // ONE open PIP per person (uq_pip_open_per_employee). The automated 9-box
        // path relies on the ON CONFLICT above; the manual path surfaced the raw
        // 23505 as an HTTP 500. Pre-check for the ordinary case, keep the 23505
        // catch as the race fallback — both answer the same 409.
        if (!skipIfOpen) {
            const open = await db.get(
                `SELECT id FROM pips WHERE employee_id = ? AND state IN ('proposed','approved','active') LIMIT 1`,
                [employeeId]
            );
            if (open) throw PipService.openPipError(employeeId, open.id);
        }
        let row;
        try {
            row = await db.get(
                `INSERT INTO pips (employee_id, initiated_by, state, starts_on, ends_on, summary,
                                   objectives, success_criteria, review_checkpoints, support_offered,
                                   origin_evaluation_id)
                 VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict}RETURNING id`,
                [
                    employeeId,
                    adminId,
                    period.startsOn,
                    period.endsOn,
                    summary || 'Performance Improvement Plan',
                    objectives || null,
                    successCriteria || null,
                    reviewCheckpoints || null,
                    supportOffered || null,
                    originEvaluationId || null,
                ]
            );
        } catch (e) {
            if (
                e &&
                e.code === '23505' &&
                /uq_pip_open_per_employee/.test(String(e.constraint || e.message || ''))
            ) {
                throw PipService.openPipError(employeeId, null);
            }
            throw e;
        }
        // Only when a row was actually inserted (skipIfOpen may have swallowed it).
        if (!row) return null;
        // Awaited on purpose: this can run inside the 9-box approve transaction,
        // where a fire-and-forget INSERT could land after the client is released
        // and be silently dropped. _notifyEmployee never rejects, so a failed
        // notification can never roll back the plan.
        await this._notifyEmployee(employeeId, 'pip.created', {
            startsOn: startsOn || null,
            endsOn: endsOn || null,
        });
        return row;
    }

    static async activate(pipId, actor = null, req = null) {
        // Manager activates straight from 'proposed' (or a legacy 'approved').
        // RETURNING + a row check, exactly as `close` below already does. Without
        // it a second click — or activating a PIP that is already active or long
        // closed — changed nothing, returned "ok", and NOTIFIED THE EMPLOYEE AGAIN
        // that their performance-improvement plan had been activated. The caller
        // now learns whether anything actually happened.
        const row = await db.get(
            `UPDATE pips SET state='active' WHERE id=? AND state IN ('proposed','approved') RETURNING id, employee_id`,
            [pipId]
        );
        if (!row) return false;
        // Activation is when the plan starts to run against the person, so it
        // names its author in the journal (actor_ref), as close() and withdraw()
        // already do. It left no trace before.
        await PipService._journal(actor, req, 'PIP_ACTIVATED', pipId, 'activated by its manager');
        // Awaited: un-awaited, this query overlapped the caller's next statement on
        // the same transaction client.
        await this._notifyEmployee(row.employeeId, 'pip.activated', {});
        return true;
    }

    /**
     * `outcome` is a free-text closure note (success/failure lives in `state`),
     * written to an UNBOUNDED text column. Nothing validated it anywhere on the
     * way in: an authenticated caller could POST an object, an array, or a
     * string of arbitrary length. Live data still carries `'rterh'` from that.
     *
     * Normalise at the service, so EVERY caller is bounded and not just the one
     * route — and refuse a non-string rather than stringifying it, because
     * `[object Object]` in an audit-facing note is worse than no note. The route
     * answers 400 for that case so the caller is told, instead of silently
     * dropping what they sent.
     */
    static normaliseOutcome(outcome) {
        if (outcome == null) return null;
        if (typeof outcome !== 'string') {
            const e = new Error('outcome must be text');
            e.code = 'INVALID_OUTCOME';
            throw e;
        }
        const clean = outcome.trim().slice(0, 2000);
        return clean === '' ? null : clean;
    }

    /**
     * WITHDRAW — the owning manager stops a plan that should not run, alone.
     *
     * Rulebook rule 8: a plan opened automatically must be closeable by its owner
     * without a two-person administrative procedure. Cancelling a PIP was a
     * CancellationService request decided by an ADMINISTRATOR
     * (`CancellationService.decide` refuses any non-admin), and there was no
     * cancel route on /v2/pip at all — so the only exits a manager had were
     * "met" and "not met". `closed_failure` is the most damaging word this
     * product writes about a person; it must never be how a plan that never ran
     * is disposed of.
     *
     * A withdrawal is therefore `cancelled`, not a verdict, and the reason is
     * mandatory: it is the entire content of the decision. Returns false when the
     * plan is not open (already closed / bad id), exactly like close.
     */
    static async withdraw(pipId, reason, actor = null, req = null) {
        const why = reason == null ? '' : String(reason).trim();
        if (!why) {
            const e = new Error(
                'Un motif écrit est obligatoire pour retirer un plan d’amélioration.'
            );
            e.code = 'REASON_REQUIRED';
            e.status = 400;
            e.expose = true;
            throw e;
        }
        const note = PipService.normaliseOutcome(why);
        const row = await db.get(
            `UPDATE pips SET state='cancelled', outcome=? WHERE id=? AND state IN ('proposed','approved','active') RETURNING id, employee_id`,
            [note, pipId]
        );
        if (!row) return false;
        await PipService._journal(
            actor,
            req,
            'PIP_WITHDRAWN',
            pipId,
            `withdrawn by its owner — ${note.slice(0, 300)}`
        );
        // The person is told their plan has stopped, and why — a plan that
        // disappears from their page with no word is worse than one that runs.
        await this._notifyEmployee(row.employeeId, 'pip.closed', { outcome: 'withdrawn' });
        return true;
    }

    /** `<type>:<id>` for the audit trail — an employee is never written into admin_id. */
    static actorRefOf(actor) {
        if (!actor || actor.id == null) return null;
        return `${actor.userType === 'admin' ? 'admin' : 'employee'}:${actor.id}`;
    }

    /**
     * The actor is named WITHOUT CONDITION by `actor_ref`; `admin_id` only for
     * an administrator (FK admins — a manager is an employee, and an admin
     * homonym would be credited). Contained in a SAVEPOINT so a swallowed log
     * failure cannot poison a caller's transaction.
     */
    static async _journal(actor, req, action, pipId, details) {
        try {
            await db.runInSavepoint(() =>
                require('./LogService').log({
                    adminId: actor && actor.userType === 'admin' ? actor.id : null,
                    actorRef: PipService.actorRefOf(actor),
                    action,
                    entityType: 'pip',
                    entityId: Number(pipId),
                    details,
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                })
            );
        } catch (_) {
            /* the decision must not fail because the log did */
        }
    }

    /**
     * CLOSE — a verdict on a person, so it carries its author and its journal.
     *
     * Measured: close(#120, true) wrote {closed_success, initiated_by 1 (the
     * system account), approved_by NULL} and NO system_logs row — a closure
     * with no author anywhere. The row now records who closed it and when
     * (migration 130: closed_by_ref, closed_at) and the act is journaled with
     * actor_ref, like withdraw.
     *
     * `closed_failure` is the most damaging word this product writes about a
     * person: a NOT-MET closure requires a written outcome note, for every
     * caller — the console's Cancel button used to send {success:'false',
     * outcome:''} and the plan was closed as failed with nothing behind it.
     */
    static async close(pipId, success, outcome, actor = null, req = null) {
        outcome = PipService.normaliseOutcome(outcome);
        const newState = success ? 'closed_success' : 'closed_failure';
        if (!success && !outcome) {
            const e = new Error(
                'Une note de résultat écrite est obligatoire pour clôturer un plan d’amélioration comme non atteint.'
            );
            e.code = 'REASON_REQUIRED';
            e.status = 400;
            e.expose = true;
            throw e;
        }
        // A verdict (met or not met) only applies to a plan that ran: state
        // 'active'. A proposed or approved plan never ran, so it can neither be
        // met nor failed; it is withdrawn instead (state 'cancelled' with a
        // reason). Returns the closed row, or null when nothing matched (already
        // closed, unknown id); a plan that never ran is refused in words (409).
        const row = await db.get(
            `UPDATE pips SET state=?, outcome=?, closed_by_ref=?, closed_at=now()
              WHERE id=? AND state = 'active' RETURNING id, employee_id`,
            [newState, outcome || null, PipService.actorRefOf(actor), pipId]
        );
        if (!row) {
            const cur = await db.get('SELECT state FROM pips WHERE id = ?', [pipId]);
            if (cur && ['proposed', 'approved'].includes(String(cur.state))) {
                const e = new Error(
                    'This plan was never activated, so it cannot be closed as met or not met. Withdraw it instead, with a reason.'
                );
                e.code = 'PIP_NOT_ACTIVE';
                e.status = 409;
                e.expose = true;
                throw e;
            }
        }
        if (row) {
            await PipService._journal(
                actor,
                req,
                'PIP_CLOSED',
                pipId,
                `closed as ${success ? 'met' : 'not met'}${outcome ? ` — ${outcome.slice(0, 300)}` : ''}`
            );
            await this._notifyEmployee(row.employeeId, 'pip.closed', {
                outcome: success ? 'success' : 'failure',
            });
        }
        return Boolean(row);
    }
}

module.exports = PipService;
