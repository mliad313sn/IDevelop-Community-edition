'use strict';

const db = require('../config/database');

/**
 *   LifecycleService — handles Joiner / Mover / Leaver events recorded
 *   into `lifecycle_events`. Triggered by the BullMQ worker registered
 *   in src/jobs/index.js.
 *
 *   joiner  : enrol into active cycle, create self_assessments shell
 *             for the role's required skills (level 0).
 *   mover   : on role/scope change, snapshot prior role data
 *             (assessments stay; new role's role_skill_requirements
 *             determine future gaps).
 *   leaver  : deactivate accounts, schedule pii_cleanup_jobs.
 *
 *   revert  : super-admin correction of an event recorded by mistake —
 *             undoes the side effects above and stamps the event with
 *             reverted_at / reverted_by (the row is kept for audit).
 */

// Rows the cascades may stamp as processed: not a pending REQUEST (a manager
// asked, no admin decided yet) and not a departure SCHEDULED for later
// (migration 109). Both look "unprocessed" on purpose until their time comes.
const ACTIONABLE = `(requested_by IS NULL OR decision = 'approved') AND (effective_at IS NULL OR effective_at <= now())`;

class LifecycleService {
    static async handle(kind, data) {
        switch (kind) {
            case 'joiner':
                return this.onJoiner(data);
            case 'mover':
                return this.onMover(data);
            case 'leaver':
                return this.onLeaver(data);
            default:
                throw new Error(`Unknown lifecycle kind: ${kind}`);
        }
    }

    // -----------------------------------------------------------------------
    // recording, requesting, scheduling
    // -----------------------------------------------------------------------

    /** 'admin:5' / 'employee:12' for a req.user-shaped actor, or a ready string. */
    static actorRef(who) {
        if (!who) return null;
        if (typeof who === 'string') return who;
        return who.id == null ? null : `${who.userType || 'admin'}:${who.id}`;
    }

    /**
     * Record a JML event from any application path — the employee form
     * (mover), onboarding approval / employee creation (joiner), the JML page —
     * and run its cascade at once when no queue is configured (the contract
     * the /v2/lifecycle route always had). A leaver with a FUTURE effective
     * date is only recorded: processDue executes it on the hour it is due.
     * Returns { id, scheduled }.
     */
    static async record(
        kind,
        employeeId,
        { payload = {}, reason = null, effectiveAt = null, actorRef = null } = {}
    ) {
        const id = Number(employeeId);
        // 3.23.17 (A-2): the id the CALLER scope-checked is the subject — a
        // payload naming ANOTHER person is refused, never merged over it.
        const pl = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        if (pl.employeeId != null && Number(pl.employeeId) !== id) {
            const e = new Error('payload_employee_mismatch');
            e.status = 400;
            e.code = 'payload_employee_mismatch';
            throw e;
        }
        payload = pl;
        const eff = effectiveAt ? new Date(effectiveAt) : null;
        const future = !!(eff && !Number.isNaN(eff.getTime()) && eff.getTime() > Date.now());
        const row = await db.get(
            `INSERT INTO lifecycle_events (employee_id, kind, payload, reason, effective_at)
             VALUES (?, ?, ?::jsonb, ?, ?) RETURNING id`,
            [
                id,
                kind,
                JSON.stringify({ ...(payload || {}), ...(actorRef ? { actorRef } : {}) }),
                reason || null,
                eff && !Number.isNaN(eff.getTime()) ? eff.toISOString() : null,
            ]
        );
        const eventId = row ? Number(row.id) : null;
        if (future) return { id: eventId, scheduled: true };
        if (!process.env.REDIS_URL) {
            try {
                await this.handle(kind, { ...(payload || {}), employeeId: id });
            } catch (e) {
                console.warn('[lifecycle inline]', kind, id, e && e.message);
            }
        }
        return { id: eventId, scheduled: false };
    }

    /**
     * A manager may only ASK for a departure (same rule as the
     * cancellations queue): the row waits for an admin holding edit_employees
     * (decide). Nothing is switched off here.
     */
    static async requestLeaver(employeeId, { requestedBy, reason, effectiveAt = null }) {
        const why = String(reason == null ? '' : reason).trim();
        if (!why) {
            const e = new Error('lc_reason_required');
            e.status = 400;
            e.code = 'lc_reason_required';
            throw e;
        }
        const eff = effectiveAt ? new Date(effectiveAt) : null;
        const row = await db.get(
            `INSERT INTO lifecycle_events (employee_id, kind, payload, reason, effective_at, requested_by)
             VALUES (?, 'leaver', '{}'::jsonb, ?, ?, ?) RETURNING id`,
            [
                Number(employeeId),
                why,
                eff && !Number.isNaN(eff.getTime()) ? eff.toISOString() : null,
                this.actorRef(requestedBy),
            ]
        );
        return { id: row ? Number(row.id) : null, requested: true };
    }

    /**
     * Admin decision on a requested departure. 'approved' executes it now (or
     * leaves it scheduled when its effective date is ahead); 'declined' closes
     * the row (processed_at stamped, nothing done) so it stops waiting.
     */
    static async decide(eventId, { adminId, decision, note = null }) {
        if (!['approved', 'declined'].includes(decision)) {
            const e = new Error('lc_bad_decision');
            e.status = 400;
            e.code = 'lc_bad_decision';
            throw e;
        }
        const ev = await db.get(
            `SELECT id, employee_id, kind, payload, requested_by, decided_at, reverted_at, effective_at
               FROM lifecycle_events WHERE id = ?`,
            [Number(eventId)]
        );
        if (!ev) {
            const e = new Error('event_not_found');
            e.status = 404;
            e.code = 'event_not_found';
            throw e;
        }
        if (!ev.requestedBy || ev.decidedAt || ev.revertedAt) {
            const e = new Error('lc_not_a_request');
            e.status = 409;
            e.code = 'lc_not_a_request';
            throw e;
        }
        await db.run(
            `UPDATE lifecycle_events
                SET decided_by = ?, decided_at = now(), decision = ?,
                    payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('decisionNote', ?::text),
                    processed_at = CASE WHEN ? = 'declined' THEN now() ELSE processed_at END
              WHERE id = ?`,
            [adminId, decision, note, decision, ev.id]
        );
        if (decision === 'declined') return { id: Number(ev.id), declined: true };
        const eff = ev.effectiveAt ? new Date(ev.effectiveAt) : null;
        if (eff && eff.getTime() > Date.now())
            return { id: Number(ev.id), approved: true, scheduled: true };
        if (!process.env.REDIS_URL) {
            try {
                // The row's subject wins over anything stored in its payload.
                await this.handle(ev.kind, {
                    ...(ev.payload || {}),
                    employeeId: Number(ev.employeeId),
                });
            } catch (e) {
                console.warn('[lifecycle decide]', e && e.message);
            }
        }
        return { id: Number(ev.id), approved: true, scheduled: false };
    }

    /**
     * Execute departures (and any other event) whose effective date has come.
     * Called by the hourly reminders tick. Idempotent: a processed row is
     * excluded by processed_at; a request still undecided is excluded by
     * ACTIONABLE. Returns the number of events executed.
     */
    static async processDue() {
        const due = await db.all(
            `SELECT id, employee_id, kind, payload FROM lifecycle_events
              WHERE processed_at IS NULL AND reverted_at IS NULL
                AND effective_at IS NOT NULL AND effective_at <= now()
                AND ${ACTIONABLE}
              ORDER BY effective_at, id LIMIT 200`
        );
        let n = 0;
        for (const ev of due) {
            try {
                // The row's subject wins over anything stored in its payload.
                await this.handle(ev.kind, {
                    ...(ev.payload || {}),
                    employeeId: Number(ev.employeeId),
                });
                n++;
            } catch (e) {
                console.error('[lifecycle] due event failed', ev.id, e && e.message);
            }
        }
        return n;
    }

    /**
     * Emit a MOVER from a real placement change made in the employee form
     *: the JML ledger, the handover plan and the notification used to
     * exist only when somebody remembered to record the move by hand. `before`
     * / `after` are { siteId, departmentId, serviceId, roleId }; returns null
     * when nothing moved.
     */
    static async moverFromChanges(
        employeeId,
        before,
        after,
        { actorRef = null, reason = null, source = 'employee_form' } = {}
    ) {
        const FIELDS = ['siteId', 'departmentId', 'serviceId', 'roleId'];
        const changed = FIELDS.filter((f) => String(before[f] ?? '') !== String(after[f] ?? ''));
        if (!changed.length) return null;
        const labels = async (p) => {
            const one = async (table, id) => {
                if (id == null || id === '') return null;
                const r = await db
                    .get(`SELECT name FROM ${table} WHERE id = ?`, [Number(id)])
                    .catch(() => null);
                return r ? r.name : null;
            };
            return {
                siteId: p.siteId == null ? null : Number(p.siteId),
                site: await one('sites', p.siteId),
                departmentId: p.departmentId == null ? null : Number(p.departmentId),
                department: await one('departments', p.departmentId),
                serviceId: p.serviceId == null ? null : Number(p.serviceId),
                service: await one('services', p.serviceId),
                roleId: p.roleId == null ? null : Number(p.roleId),
                role: await one('roles', p.roleId),
            };
        };
        const from = await labels(before);
        const to = await labels(after);
        return this.record('mover', employeeId, {
            payload: {
                from,
                to,
                changed,
                source: source || 'employee_form',
                fromRoleId: from.roleId,
                toRoleId: to.roleId,
            },
            reason,
            actorRef,
        });
    }

    /**
     * The state a reader sees: never a bare dash.
     *   reverted · declined · requested · scheduled · skipped · done · pending
     */
    static stateOf(ev) {
        if (!ev) return 'pending';
        if (ev.revertedAt) return 'reverted';
        if (ev.decision === 'declined') return 'declined';
        if (ev.requestedBy && !ev.decidedAt) return 'requested';
        if (!ev.processedAt && ev.effectiveAt && new Date(ev.effectiveAt).getTime() > Date.now())
            return 'scheduled';
        if (ev.processedAt && ev.payload && ev.payload.skipped) return 'skipped';
        return ev.processedAt ? 'done' : 'pending';
    }

    static async onJoiner({ employeeId }) {
        const cycle = await db.get(
            `SELECT id FROM assessment_cycles WHERE status='open' ORDER BY closes_at LIMIT 1`
        );
        if (!cycle) {
            // Honest ledger: the arrival is PROCESSED — there was simply
            // no campaign to enrol into. Left unstamped, the row read "pending"
            // for months and kept a revert button it did not deserve.
            await db.run(
                `UPDATE lifecycle_events
                    SET processed_at = now(),
                        payload = COALESCE(payload, '{}'::jsonb) || '{"skipped":"no_open_cycle"}'::jsonb
                  WHERE employee_id = ? AND kind = 'joiner' AND processed_at IS NULL AND ${ACTIONABLE}`,
                [employeeId]
            );
            return { skipped: 'no_open_cycle' };
        }

        // Enrol the arrival in the open campaign. The whole campaign dashboard reads
        // FROM cycle_participants, so a joiner who was never enrolled is absent from
        // the DENOMINATOR: the campaign can report 100% complete while they have
        // submitted nothing, and no reminder reaches them. The roster was only ever
        // built at the draft->open transition, so the gap was corrected solely if an
        // administrator happened to click "reconcile".
        // `enrolParticipants` is ON CONFLICT DO NOTHING, so this is idempotent and
        // also repairs anyone else missing from the roster.
        try {
            await require('./CycleService').enrolParticipants(cycle.id);
        } catch (e) {
            console.error(
                '[lifecycle] joiner enrolment failed for employee',
                employeeId,
                e && e.message
            );
        }
        const skills = await db.all(
            `SELECT rsr.skill_id
             FROM employees e
             JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
             WHERE e.id = ?`,
            [employeeId]
        );
        // NULL, not 0. On the 0-4 scale 0 is a real answer ("None"), so seeding it
        // made the joiner read as fully rated the moment they were created: the
        // campaign showed them `in_progress` with every skill answered, and the
        // "you have not started" reminder — which looks for the ABSENCE of rows —
        // could never see them again. NULL means "not yet rated".
        for (const s of skills) {
            await db.run(
                `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, cycle_id, locked_state)
                 VALUES (?, ?, NULL, 'draft', ?, 'provisional')
                 ON CONFLICT DO NOTHING`,
                [employeeId, s.skillId, cycle.id]
            );
        }
        // RECORD WHICH CAMPAIGN THE ARRIVAL WAS ENROLLED INTO.
        // `revert('joiner')` has to undo exactly this enrolment, possibly months
        // later, when a different campaign is the open one. Without the cycle id on
        // the event there is nothing left tying the shells to the event that made
        // them, and the revert fell back to "whatever is open now" — see revert.
        await db.run(
            `UPDATE lifecycle_events
                SET processed_at = now(),
                    payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('cycleId', ?::bigint)
             WHERE employee_id = ? AND kind = 'joiner' AND processed_at IS NULL AND ${ACTIONABLE}`,
            [cycle.id, employeeId]
        );
        try {
            await require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: Number(employeeId),
                    kind: 'lifecycle.joiner',
                    category: 'lifecycle',
                    payload: { link: '/employee/dashboard' },
                })
                .catch(() => {});
        } catch (_) {
            /* never block JML */
        }
        return { skillsEnrolled: skills.length };
    }

    static async onMover({ employeeId, fromRoleId, toRoleId }) {
        // Historical assessments stay (nothing deleted). F10 (3.23.18 R2): a ROLE
        // change during an OPEN campaign seeds the new role's missing skill
        // shells for that campaign — the same mechanism as onJoiner — so the
        // mover is asked about the skills of the job they now hold instead of
        // finishing the campaign on the old role's grid.
        let seeded = null;
        const roleChanged =
            toRoleId != null && String(toRoleId) !== String(fromRoleId == null ? '' : fromRoleId);
        if (roleChanged) {
            try {
                seeded = await this._seedMoverShells(employeeId);
            } catch (e) {
                console.error(
                    '[lifecycle] mover shell seeding failed for employee',
                    employeeId,
                    e && e.message
                );
            }
        }
        await db.run(
            `UPDATE lifecycle_events
                SET processed_at = now(),
                    payload = COALESCE(payload, '{}'::jsonb) || ?::jsonb
             WHERE employee_id = ? AND kind = 'mover' AND processed_at IS NULL AND ${ACTIONABLE}`,
            [
                JSON.stringify(
                    seeded ? { cycleId: seeded.cycleId, shellsSeeded: seeded.seeded } : {}
                ),
                employeeId,
            ]
        );
        // F2 (3.23.21): an expatriate incumbent who changed role leaves their
        // nationalisation plan pointing at the former position — flagged on the
        // plan's journal for a human decision (never closed automatically).
        if (roleChanged) {
            try {
                await db.runInSavepoint(() =>
                    require('./NationalisationService').flagPlansForEmployee(
                        employeeId,
                        'mover',
                        'system'
                    )
                );
            } catch (e) {
                console.error(
                    '[lifecycle] nationalisation plan flag FAILED for mover',
                    employeeId,
                    e && e.message
                );
            }
        }
        // Knowledge continuity: a role change leaves the prior role's duties behind.
        await this._ensureHandover(employeeId, 'mover');
        try {
            await require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: Number(employeeId),
                    kind: 'lifecycle.mover',
                    category: 'lifecycle',
                    payload: { link: '/employee/dashboard' },
                })
                .catch(() => {});
        } catch (_) {
            /* never block JML */
        }
        return { from: fromRoleId, to: toRoleId, seeded };
    }

    /**
     * seed the CURRENT role's skill shells into the open campaign for a
     * mover: unrated (NULL) provisional drafts, ON CONFLICT DO NOTHING, so a
     * skill the person already has a current row for (old role in common, or
     * already answered) is left exactly as it is. Enrols the person in the
     * roster when missing (idempotent). Returns null when no campaign is open.
     */
    static async _seedMoverShells(employeeId) {
        const cycle = await db.get(
            `SELECT id FROM assessment_cycles WHERE status='open' ORDER BY closes_at LIMIT 1`
        );
        if (!cycle) return null;
        try {
            await require('./CycleService').enrolParticipants(cycle.id);
        } catch (_) {
            /* roster repair is best-effort, like onJoiner */
        }
        const skills = await db.all(
            `SELECT rsr.skill_id
               FROM employees e
               JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
              WHERE e.id = ? AND e.is_active = true`,
            [employeeId]
        );
        let seeded = 0;
        for (const s of skills || []) {
            const r = await db.run(
                `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, cycle_id, locked_state)
                 VALUES (?, ?, NULL, 'draft', ?, 'provisional')
                 ON CONFLICT DO NOTHING`,
                [employeeId, s.skillId, cycle.id]
            );
            seeded += r && r.changes ? Number(r.changes) : 0;
        }
        return { cycleId: Number(cycle.id), seeded };
    }

    /**
     * Best-effort knowledge-handover plan for a leaver/mover. Never blocks the
     * lifecycle transition if the continuity module is unavailable.
     *
     * It used to pass ONLY outgoingEmployeeId, so every auto-created plan was an
     * empty shell: no successor, no deadline, no owner — a row nobody was
     * accountable for and nothing could chase. All three are now resolved:
     *
     *   successor — the top of the bench on the succession plan for the person's
     *               role (ContinuityService.topSuccessorForRole); null when the
     *               role has no plan or no bench, which is itself the signal the
     *               succession-review tick raises.
     *   due date  — 14 days for a leaver, 30 for a mover (HandoverService).
     *   owner     — succession-plan owner → criticality designator → superadmin.
     *
     * Each resolution is independently guarded: a missing succession module must
     * still produce a dated, owned plan rather than no plan at all.
     */
    static async _ensureHandover(employeeId, kind) {
        try {
            const ev = await db.get(
                'SELECT id FROM lifecycle_events WHERE employee_id = ? AND kind = ? ORDER BY occurred_at DESC LIMIT 1',
                [employeeId, kind]
            );
            const HandoverService = require('./HandoverService');

            let incomingEmployeeId = null;
            try {
                const emp = await db.get('SELECT role_id FROM employees WHERE id = ?', [
                    employeeId,
                ]);
                if (emp && emp.roleId) {
                    incomingEmployeeId = await require('./ContinuityService').topSuccessorForRole(
                        emp.roleId,
                        { excludeEmployeeId: employeeId }
                    );
                }
            } catch (_) {
                /* no bench → plan is created without a named successor */
            }

            let ownerAdminId = null;
            try {
                ownerAdminId = await HandoverService.resolveOwnerAdminId(employeeId);
            } catch (_) {
                /* unowned */
            }

            await HandoverService.ensureForEvent({
                lifecycleEventId: ev ? ev.id : null,
                outgoingEmployeeId: employeeId,
                incomingEmployeeId,
                dueDate: HandoverService.dueDateFor(kind),
                ownerAdminId,
            });
        } catch (_) {
            /* continuity optional — never block JML */
        }
    }

    /**
     * THE deactivation entry point for every non-JML path (SCIM deprovision,
     * the admin "delete" button, …). Records a leaver event so the departure is
     * on the same audit trail — and revertable through the same revert — and
     * then runs the COMPLETE cascade below. Before this existed each path
     * re-implemented a subset: SCIM flipped two flags and stopped; delete
     * flipped one, so the person's password still logged in and their linked
     * admin account and API keys kept working (both reproduced by rolled-back
     * probe). A departure must not be a weaker gate depending on which screen
     * recorded it.
     *
     * @param {number} employeeId
     * @param {{source?:string, actorRef?:string|null}} [opts]
     */
    /**
     * Switch an account off and revoke everything it could still sign in with.
     *
     * `departure` (default true) says whether this is a real DEPARTURE or only
     * an administrative switch-off. A departure additionally schedules the PII
     * cleanup job, opens a handover plan and tells the manager. The SuperAdmin
     * "deactivate" toggle is NOT a departure — it is reversible and must not
     * quietly start a GDPR erasure clock — but it needs the identical access
     * revocation, so it passes `departure: false`.
     *
     * The event is recorded either way, with the ids of what was revoked, so
     * reinstate → revert puts back exactly that and nothing else.
     */
    static async deprovision(
        employeeId,
        { source = 'system', actorRef = null, departure = true } = {}
    ) {
        const id = Number(employeeId);
        await db.run(
            `INSERT INTO lifecycle_events (employee_id, kind, payload)
             VALUES (?, 'leaver', ?::jsonb)`,
            [id, JSON.stringify({ source, actorRef, departure: departure !== false })]
        );
        return this.onLeaver({ employeeId: id, departure });
    }

    /**
     * Reinstate an account switched off by deprovision/onLeaver — the
     * counterpart SCIM `active:true` needs. Goes through revert of the most
     * recent un-reverted leaver event when there is one, so the linked admin
     * accounts and API keys that departure switched off come back too (and the
     * pending PII job is dropped); falls back to the plain employee flags when
     * no event exists (a legacy deactivation). Both paths refuse an ERASED or
     * VOIDED record — see _assertReinstatable.
     */
    static async reinstate(employeeId, { source = 'system', adminId = null, actor } = {}) {
        const id = Number(employeeId);
        await this._assertReinstatable(id);
        const ev = await db.get(
            `SELECT id FROM lifecycle_events
              WHERE employee_id = ? AND kind = 'leaver' AND reverted_at IS NULL AND processed_at IS NOT NULL
              ORDER BY occurred_at DESC, id DESC LIMIT 1`,
            [id]
        );
        if (ev)
            return {
                via: 'revert',
                ...(await this.revert(Number(ev.id), {
                    adminId,
                    note: `reinstated via ${source}`,
                    ...(actor !== undefined ? { actor } : {}),
                })),
            };
        const r = await db.run(
            `UPDATE employees SET is_active = true, is_account_active = true
              WHERE id = ? AND cancelled_at IS NULL AND erased_at IS NULL`,
            [id]
        );
        if (!r || !r.changes) await this._assertReinstatable(id); // race: re-check and name the reason
        return { via: 'flags', reactivated: true };
    }

    /**
     * An erased subject (DSRService.erase) or a voided record (MaintenanceService
     * voidEmployee) must never come back to life through a reactivation path:
     * "Erased 84" back in the headcount, or a created-in-error record active
     * AND cancelled at once (which the void then refuses to re-void). Throws a
     * 409 with a stable code the callers can localise.
     */
    static async _assertReinstatable(employeeId) {
        const row = await db.get('SELECT cancelled_at, erased_at FROM employees WHERE id = ?', [
            employeeId,
        ]);
        // No row → nothing to refuse; the caller's UPDATE simply affects 0 rows
        // (a legacy event whose employee was hard-deleted).
        if (!row) return;
        if (row.erasedAt) {
            const e = new Error('erased_record_cannot_be_reinstated');
            e.status = 409;
            e.code = 'erased_record_cannot_be_reinstated';
            throw e;
        }
        if (row.cancelledAt) {
            const e = new Error('void_record_cannot_be_reinstated');
            e.status = 409;
            e.code = 'void_record_cannot_be_reinstated';
            throw e;
        }
    }

    static async onLeaver({ employeeId, departure = true }) {
        // `departure === false` is an administrative switch-off (the SuperAdmin
        // deactivate toggle): identical access revocation, none of the
        // consequences that only make sense when somebody has actually left.
        const isDeparture = departure !== false;
        const emp = await db.get(
            `SELECT e.id, c.code AS country_code, c.dsr_sla_days
             FROM employees e
             LEFT JOIN sites s     ON s.id = e.site_id
             LEFT JOIN countries c ON c.id = s.country_id
             WHERE e.id = ?`,
            [employeeId]
        );
        await db.run(
            `UPDATE employees SET is_active = false, is_account_active = false WHERE id = ?`,
            [employeeId]
        );
        // Kill any live session immediately (the deserialize gate would also catch
        // it on the next request, but an active leaver shouldn't keep reading HR data
        // even for one more click). An employee may be session-typed 'employee' or
        // 'manager'; revoke both buckets for this id.
        try {
            const SessionService = require('./SessionService');
            await SessionService.revokeAllForUser(employeeId, 'employee');
            await SessionService.revokeAllForUser(employeeId, 'manager');
        } catch (_) {
            /* session revoke is best-effort; deserialize gate is the backstop */
        }

        // An employee who was promoted to admin has a SECOND account
        // (admins.linked_employee_id). Deactivating the employee row did nothing to
        // it: `deserializeUser` gates on `admins.is_active`, which stayed true, so a
        // leaver kept a fully valid admin login with full HR reach — and their
        // `/api/v1` keys kept resolving, because ApiKeyService.validate tests the
        // OWNING ADMIN's is_active. Verified by probe before this was added:
        // employee is_active=false, admin is_active=true.
        //
        // This is the same cascade AdminController performs when an admin is
        // deleted; a departure must not be a weaker gate than an admin deletion.
        // What this departure actually switched off, so the revert can switch back
        // exactly that and nothing else (see revert('leaver')).
        const revokedAdminIds = [];
        const revokedApiKeyIds = [];
        try {
            const SessionService = require('./SessionService');
            const linked = await db.all(
                'SELECT id FROM admins WHERE linked_employee_id = ? AND is_active = true',
                [employeeId]
            );
            for (const a of linked) {
                await db.run('UPDATE admins SET is_active = false WHERE id = ?', [a.id]);
                revokedAdminIds.push(Number(a.id));
                // Capture the key ids BEFORE revoking: revokeByOwner returns a count,
                // and after the fact a revoked key is indistinguishable from one that
                // was already revoked for an unrelated reason.
                try {
                    const keys = await db.all(
                        'SELECT id FROM api_keys WHERE owner_admin_id = ? AND revoked_at IS NULL',
                        [a.id]
                    );
                    for (const k of keys) revokedApiKeyIds.push(Number(k.id));
                } catch (_) {
                    /* key inventory is best-effort */
                }
                try {
                    await require('./ApiKeyService').revokeByOwner(Number(a.id));
                } catch (_) {
                    /* best-effort */
                }
                try {
                    await SessionService.revokeAllForUser(Number(a.id), 'admin');
                } catch (_) {
                    /* best-effort */
                }
            }
            if (linked.length) {
                try {
                    await require('./LogService').log({
                        action: 'lifecycle.leaver.admin_revoked',
                        entityType: 'employee',
                        entityId: Number(employeeId),
                        details: `Deactivated ${linked.length} linked admin account(s) and revoked their API keys`,
                    });
                } catch (_) {
                    /* audit is best-effort, the revoke already happened */
                }
            }
        } catch (e) {
            // Never block the JML event, but this one must be visible: a leaver
            // retaining admin access is a standing privilege, not a missed notice.
            console.error(
                '[lifecycle] leaver admin-account revoke FAILED for employee',
                employeeId,
                e && e.message
            );
        }
        // F8 (3.23.18 R2) — what the departure leaves behind.
        //   (b) the leaver's OWN open plans and pending applications are closed
        //       with the system reason 'leaver' (states, never deletes), and the
        //       exact list is journaled on the event so revert re-opens THAT
        //       and nothing else. Only for a real departure: an administrative
        //       switch-off is reversible and changes nobody's development file.
        //   (a) the people whose line points at the leaver are NOT rewired —
        //       they keep pointing at the leaver until a human reassigns them —
        //       but they are listed on the event and announced below.
        const actorRef = await this._pendingLeaverActor(employeeId);
        // F11 (3.23.21): what else the leaver held (OKRs, authored postings,
        // reviewer assignments, local-content plans) — read BEFORE anything is
        // closed, journaled on the event and named in the leaver notice.
        let leftovers = null;
        try {
            leftovers = await this.leaverLeftovers(employeeId);
        } catch (_) {
            leftovers = null;
        }
        // F2 (3.23.21): the local-content nationalisation plans the leaver is on
        // are flagged for a human decision (journal), never closed silently.
        if (isDeparture && leftovers && leftovers.nationalisationPlans.length) {
            try {
                await db.runInSavepoint(() =>
                    require('./NationalisationService').flagPlansForEmployee(
                        employeeId,
                        'leaver',
                        actorRef
                    )
                );
            } catch (e) {
                console.error(
                    '[lifecycle] nationalisation plan flag FAILED for employee',
                    employeeId,
                    e && e.message
                );
            }
        }
        let leaverClosed = null;
        if (isDeparture) {
            try {
                leaverClosed = await this._closeLeaverPlans(employeeId, actorRef);
            } catch (e) {
                console.error(
                    '[lifecycle] leaver plan closure FAILED for employee',
                    employeeId,
                    e && e.message
                );
            }
        }
        let orphanedReports = [];
        try {
            orphanedReports = await require('./ReportingLineService').directReportsOf(employeeId);
        } catch (_) {
            orphanedReports = [];
        }
        // Only a real departure starts the retention clock. A reversible
        // administrative deactivation must never schedule an erasure.
        if (isDeparture && emp && emp.countryCode) {
            await db.run(
                `INSERT INTO pii_cleanup_jobs (employee_id, country_code, due_at)
                 VALUES (?, ?, now() + (interval '1 day' * ?))
                 ON CONFLICT (employee_id) DO NOTHING`,
                [employeeId, emp.countryCode, emp.dsrSlaDays || 30]
            );
            // F11 (3.23.21): a legal hold set on the employee BEFORE the departure
            // (migration 157) is carried into the retention job, which the
            // retention purge skips. A job already held keeps its own hold.
            try {
                await db.runInSavepoint(() =>
                    db.run(
                        `UPDATE pii_cleanup_jobs j
                            SET legal_hold_at = e.legal_hold_at, legal_hold_by = e.legal_hold_by,
                                legal_hold_reason = e.legal_hold_reason
                           FROM employees e
                          WHERE j.employee_id = e.id AND e.id = ? AND e.legal_hold_at IS NOT NULL
                            AND j.legal_hold_at IS NULL AND j.completed_at IS NULL`,
                        [employeeId]
                    )
                );
            } catch (e) {
                console.error(
                    '[lifecycle] legal hold carry-over FAILED for employee',
                    employeeId,
                    e && e.message
                );
            }
        }
        await db.run(
            `UPDATE lifecycle_events
                SET processed_at = now(),
                    payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
                        'revokedAdminIds', ?::jsonb, 'revokedApiKeyIds', ?::jsonb,
                        'leaverClosed', ?::jsonb, 'reportsToReassign', ?::jsonb,
                        'leftovers', ?::jsonb)
             WHERE employee_id = ? AND kind = 'leaver' AND processed_at IS NULL AND ${ACTIONABLE}`,
            [
                JSON.stringify(revokedAdminIds),
                JSON.stringify(revokedApiKeyIds),
                JSON.stringify(leaverClosed),
                JSON.stringify(orphanedReports.map((r) => r.id)),
                JSON.stringify(leftovers),
                employeeId,
            ]
        );
        // (a) Nobody is left without a line SILENTLY: the leaver's own line and
        // the admins covering them are told who needs a new reviewer/manager —
        // and what else the leaver held that someone must take over.
        const leftoverTotal =
            isDeparture && leftovers
                ? Object.values(this.leftoverCounts(leftovers)).reduce((a, n) => a + n, 0)
                : 0;
        if (orphanedReports.length || leftoverTotal)
            await this._announceOrphanedReports(
                employeeId,
                orphanedReports,
                isDeparture ? leftovers : null
            );
        // Knowledge continuity: capture critical knowledge before the leaver goes.
        // Nobody is leaving on an administrative switch-off, so there is no
        // knowledge to hand over and no manager to summon.
        if (!isDeparture) {
            return {
                deactivated: true,
                departure: false,
                revoked: { adminIds: revokedAdminIds, apiKeyIds: revokedApiKeyIds },
                reportsToReassign: orphanedReports.map((r) => r.id),
            };
        }
        await this._ensureHandover(employeeId, 'leaver');
        // The leaver is deactivated → notify their LINE (a handover plan awaits):
        // the ACTIVE effective reviewer and the manager (employee OR admin) when
        // different — 3.23.18 R2. A departed supervisor is skipped, never
        // addressed; an admin manager is no longer forgotten.
        try {
            const recipients = await require('./ReportingLineService').lineRecipients(employeeId, {
                includeManager: true,
            });
            for (const r of recipients) {
                await require('./NotificationService')
                    .notify({
                        userType: r.userType,
                        userId: r.id,
                        kind: 'lifecycle.leaver',
                        category: 'lifecycle',
                        payload: { link: '/v2/continuity' },
                    })
                    .catch(() => {});
            }
        } catch (_) {
            /* never block JML */
        }
        return {
            deactivated: true,
            departure: true,
            revoked: { adminIds: revokedAdminIds, apiKeyIds: revokedApiKeyIds },
            closed: leaverClosed,
            reportsToReassign: orphanedReports.map((r) => r.id),
        };
    }

    /**
     * Who is executing the departure being processed, as an actor ref
     * ('admin:5' / 'employee:12'), from the pending leaver event: the payload's
     * actorRef (record/deprovision), else the admin who approved a
     * requested departure. 'system' when neither is known (scheduled/SCIM).
     */
    static async _pendingLeaverActor(employeeId) {
        try {
            const ev = await db.get(
                `SELECT payload, decided_by FROM lifecycle_events
                  WHERE employee_id = ? AND kind = 'leaver' AND processed_at IS NULL AND ${ACTIONABLE}
                  ORDER BY id DESC LIMIT 1`,
                [employeeId]
            );
            const p = (ev && ev.payload) || {};
            if (p.actorRef) return String(p.actorRef).slice(0, 64);
            if (ev && ev.decidedBy) return `admin:${Number(ev.decidedBy)}`;
        } catch (_) {
            /* unknown actor */
        }
        return 'system';
    }

    /**
     * F8(b) — close the leaver's own open development/talent items with the
     * system reason 'leaver'. States only, nothing deleted; the per-row prior
     * state is returned so revert can re-open exactly these rows.
     *
     *   PIPs      proposed|approved|active   → cancelled (closed_at, closed_by_ref)
     *   IDPs      draft|active               → cancelled (close_reason 'leaver') and
     *             their open objectives/actions → cancelled — the same shape
     *             CancellationService.cascadePlanCancellation leaves, with ids kept
     *   coaching  draft|active               → cancelled
     *   mobility  applied                    → withdrawn (decision_note 'leaver')
     */
    static async _closeLeaverPlans(employeeId, actorRef = 'system') {
        const id = Number(employeeId);
        const ref = actorRef || 'system';
        const m = /^(admin|employee):(\d+)$/.exec(ref);
        const closed = {
            reason: 'leaver',
            closedByRef: ref,
            pips: [],
            idps: [],
            coaching: [],
            applications: [],
        };
        const rows = (r) => (Array.isArray(r) ? r : []);

        for (const r of rows(
            await db.all(
                `UPDATE pips p SET state = 'cancelled', closed_at = now(), closed_by_ref = ?
                   FROM (SELECT id, state::text AS prev FROM pips
                          WHERE employee_id = ? AND state IN ('proposed', 'approved', 'active')
                          FOR UPDATE) o
                  WHERE p.id = o.id
              RETURNING p.id, o.prev`,
                [ref, id]
            )
        ))
            closed.pips.push({ id: Number(r.id), prev: r.prev });

        for (const r of rows(
            await db.all(
                `UPDATE idp_plans p SET status = 'cancelled', closed_at = now(),
                        closed_by_type = ?, closed_by_id = ?, close_reason = 'leaver'
                   FROM (SELECT id, status::text AS prev FROM idp_plans
                          WHERE employee_id = ? AND status IN ('draft', 'active')
                          FOR UPDATE) o
                  WHERE p.id = o.id
              RETURNING p.id, o.prev`,
                [m ? m[1] : null, m ? Number(m[2]) : null, id]
            )
        )) {
            const idpId = Number(r.id);
            const objectives = rows(
                await db.all(
                    `UPDATE idp_objectives x SET state = 'cancelled', updated_at = now()
                       FROM (SELECT id, state::text AS prev FROM idp_objectives
                              WHERE idp_id = ? AND state IN ('pending', 'in_progress') FOR UPDATE) o
                      WHERE x.id = o.id
                  RETURNING x.id, o.prev`,
                    [idpId]
                )
            ).map((o) => ({ id: Number(o.id), prev: o.prev }));
            const actions = rows(
                await db.all(
                    `UPDATE idp_actions x SET status = 'cancelled', updated_at = now()
                       FROM (SELECT id, status::text AS prev FROM idp_actions
                              WHERE idp_id = ? AND status IN ('pending', 'in_progress') FOR UPDATE) o
                      WHERE x.id = o.id
                  RETURNING x.id, o.prev`,
                    [idpId]
                )
            ).map((a) => ({ id: Number(a.id), prev: a.prev }));
            closed.idps.push({ id: idpId, prev: r.prev, objectives, actions });
        }

        for (const r of rows(
            await db.all(
                `UPDATE coaching_plans c SET state = 'cancelled', updated_at = now()
                   FROM (SELECT id, state AS prev FROM coaching_plans
                          WHERE employee_id = ? AND state IN ('draft', 'active') FOR UPDATE) o
                  WHERE c.id = o.id
              RETURNING c.id, o.prev`,
                [id]
            )
        ))
            closed.coaching.push({ id: Number(r.id), prev: r.prev });

        for (const r of rows(
            await db.all(
                `UPDATE opportunity_applications SET status = 'withdrawn', decided_at = now(),
                        decision_note = 'leaver'
                  WHERE employee_id = ? AND status = 'applied'
              RETURNING id`,
                [id]
            )
        ))
            closed.applications.push(Number(r.id));

        const n =
            closed.pips.length +
            closed.idps.length +
            closed.coaching.length +
            closed.applications.length;
        if (n) {
            try {
                await db.runInSavepoint(() =>
                    require('./LogService').log({
                        adminId: m && m[1] === 'admin' ? Number(m[2]) : null,
                        actorRef: ref,
                        action: 'lifecycle.leaver.plans_closed',
                        entityType: 'employee',
                        entityId: id,
                        details: `reason leaver: ${closed.pips.length} PIP, ${closed.idps.length} IDP, ${closed.coaching.length} coaching, ${closed.applications.length} application(s) closed`,
                    })
                );
            } catch (_) {
                /* the closure is journaled on the event itself */
            }
        }
        return closed;
    }

    /**
     * revert('leaver') counterpart of _closeLeaverPlans: re-open EXACTLY the rows
     * the departure closed, each only while it is still in the state the
     * departure left it in (nobody has touched it since). Each row in its own
     * savepoint: one row that can no longer be re-opened is reported, it does
     * not block the reinstatement.
     */
    static async _reopenLeaverPlans(closed) {
        const out = { plansReopened: 0, plansNotReopened: 0 };
        if (!closed || typeof closed !== 'object') return out;
        const list = (a) => (Array.isArray(a) ? a : []);
        const one = async (sql, params) => {
            try {
                const r = await db.runInSavepoint(() => db.run(sql, params));
                if (r && r.changes) out.plansReopened += 1;
                else out.plansNotReopened += 1;
            } catch (_) {
                out.plansNotReopened += 1;
            }
        };
        for (const p of list(closed.pips))
            await one(
                `UPDATE pips SET state = ?::pip_state, closed_at = NULL, closed_by_ref = NULL
                  WHERE id = ? AND state = 'cancelled' AND closed_by_ref IS NOT DISTINCT FROM ?`,
                [p.prev, Number(p.id), closed.closedByRef || 'system']
            );
        for (const p of list(closed.idps)) {
            await one(
                `UPDATE idp_plans SET status = ?::idp_status, closed_at = NULL, closed_by_type = NULL,
                        closed_by_id = NULL, close_reason = NULL
                  WHERE id = ? AND status = 'cancelled' AND close_reason = 'leaver'`,
                [p.prev, Number(p.id)]
            );
            for (const o of list(p.objectives))
                await db
                    .runInSavepoint(() =>
                        db.run(
                            `UPDATE idp_objectives SET state = ?::idp_objective_state, updated_at = now()
                          WHERE id = ? AND state = 'cancelled'`,
                            [o.prev, Number(o.id)]
                        )
                    )
                    .catch(() => {});
            for (const a of list(p.actions))
                await db
                    .runInSavepoint(() =>
                        db.run(
                            `UPDATE idp_actions SET status = ?::idp_objective_state, updated_at = now()
                          WHERE id = ? AND status = 'cancelled'`,
                            [a.prev, Number(a.id)]
                        )
                    )
                    .catch(() => {});
        }
        for (const c of list(closed.coaching))
            await one(
                `UPDATE coaching_plans SET state = ?, updated_at = now()
                  WHERE id = ? AND state = 'cancelled'`,
                [c.prev, Number(c.id)]
            );
        for (const appId of list(closed.applications))
            await one(
                `UPDATE opportunity_applications SET status = 'applied', decided_at = NULL, decision_note = NULL
                  WHERE id = ? AND status = 'withdrawn' AND decision_note = 'leaver'`,
                [Number(appId)]
            );
        return out;
    }

    /**
     * F8(a) — tell the people who can fix it that somebody's line now points at
     * a departed person: the leaver's own line (effective reviewer + manager)
     * and the admins whose scope covers the leaver (SuperAdmins when none).
     * In-app notification with the COUNT and the ids to reassign; nothing is
     * rewired automatically.
     */
    /**
     * F11 (3.23.21) — what a departure leaves behind BESIDES the people whose
     * line points at the leaver, so the leaver notice can name it:
     *   okrs                 the leaver's open OKRs (goals not completed/cancelled/archived)
     *   postings             open mobility postings the leaver authored (as the
     *                        employee, or through a linked admin account)
     *   reviewerAssignments  what the leaver holds as a REVIEWER: assessments
     *                        waiting on them, review delegations granted to them
     *                        (still running), open-campaign participants assigned
     *                        to their linked admin account
     *   nationalisationPlans active local-content plans the leaver is on
     * Each read runs in its own savepoint: a missing optional table reads as an
     * empty list and never breaks the departure.
     */
    static async leaverLeftovers(employeeId) {
        const id = Number(employeeId);
        const safe = async (fn) => {
            try {
                return await db.runInSavepoint(fn);
            } catch (_) {
                return [];
            }
        };
        const okrs = await safe(() =>
            db.all(
                `SELECT id, title FROM goals
                  WHERE employee_id = ? AND COALESCE(status, 'active') NOT IN ('completed', 'cancelled', 'archived')
                  ORDER BY id LIMIT 50`,
                [id]
            )
        );
        const postings = await safe(() =>
            db.all(
                `SELECT o.id, o.title FROM opportunities o
                  WHERE o.state::text = 'open'
                    AND (o.actor_employee_id = ?
                         OR o.posted_by_admin_id IN (SELECT a.id FROM admins a WHERE a.linked_employee_id = ?))
                  ORDER BY o.id LIMIT 50`,
                [id, id]
            )
        );
        const pendingReviews = await safe(() =>
            db.all(
                `SELECT employee_id, count(*)::int AS n FROM self_assessments
                  WHERE current_reviewer_id = ? AND status::text IN ('submitted', 'reviewed')
                  GROUP BY employee_id ORDER BY employee_id LIMIT 50`,
                [id]
            )
        );
        const delegations = await safe(() =>
            db.all(
                `SELECT id, grantor_id FROM review_delegations
                  WHERE grantee_id = ? AND ends_at > now() ORDER BY id LIMIT 50`,
                [id]
            )
        );
        const cycleAssignments = await safe(() =>
            db.all(
                `SELECT cp.cycle_id, cp.employee_id FROM cycle_participants cp
                   JOIN assessment_cycles c ON c.id = cp.cycle_id
                  WHERE c.status::text = 'open' AND cp.completed_at IS NULL
                    AND cp.reviewer_admin_id IN (SELECT a.id FROM admins a WHERE a.linked_employee_id = ?)
                  ORDER BY cp.cycle_id, cp.employee_id LIMIT 50`,
                [id]
            )
        );
        const plans = await safe(() =>
            db.all(
                `SELECT p.id FROM lc_nationalisation_plans p
                  WHERE p.state = 'active'
                    AND (p.incumbent_employee_id = ?
                         OR EXISTS (SELECT 1 FROM lc_nationalisation_successors ns
                                     WHERE ns.plan_id = p.id AND ns.employee_id = ? AND ns.state = 'active'))
                  ORDER BY p.id`,
                [id, id]
            )
        );
        return {
            okrs: okrs.map((g) => ({ id: Number(g.id), title: g.title })),
            postings: postings.map((o) => ({ id: Number(o.id), title: o.title })),
            reviewerAssignments: {
                pendingReviews: pendingReviews.map((r) => ({
                    employeeId: Number(r.employeeId),
                    count: Number(r.n),
                })),
                delegations: delegations.map((d) => ({
                    id: Number(d.id),
                    grantorId: Number(d.grantorId),
                })),
                cycleAssignments: cycleAssignments.map((c) => ({
                    cycleId: Number(c.cycleId),
                    employeeId: Number(c.employeeId),
                })),
            },
            nationalisationPlans: plans.map((p) => Number(p.id)),
        };
    }

    /**
     * The one-line leaver notice (talentx:lc_leftover_*), in the application's
     * language (French first). Null when there is nothing to name.
     */
    static leftoverSummary(reportCount, c, lng = null) {
        let t = null;
        try {
            const i18next = require('i18next');
            if (i18next && typeof i18next.getFixedT === 'function' && i18next.isInitialized)
                t = i18next.getFixedT(lng || 'fr', 'talentx');
        } catch (_) {
            t = null;
        }
        const parts = [];
        const add = (key, n, fr) => {
            if (!n) return;
            const s = t ? t(key, { n }) : null;
            parts.push(s && s !== key ? s : `${fr} : ${n}`);
        };
        add('lc_leftover_reports', reportCount, 'Collaborateurs à réaffecter');
        add('lc_leftover_okrs', c.okrs, 'OKR ouverts');
        add('lc_leftover_postings', c.postings, 'Offres de mobilité publiées');
        add('lc_leftover_reviews', c.reviews, 'Évaluations en attente de sa validation');
        add('lc_leftover_delegations', c.delegations, 'Délégations de validation reçues');
        add(
            'lc_leftover_cycle_assignments',
            c.cycleAssignments,
            'Affectations d’évaluateur (campagne ouverte)'
        );
        add('lc_leftover_nat_plans', c.nationalisationPlans, 'Plans de nationalisation à décider');
        if (!parts.length) return null;
        const head = t ? t('lc_leftover_head') : null;
        return `${head && head !== 'lc_leftover_head' ? head : 'À reprendre'} — ${parts.join(' · ')}`;
    }

    /** Counts of a leftovers object (see leaverLeftovers); all zero → nothing to announce. */
    static leftoverCounts(lo) {
        const l = lo || {};
        const ra = l.reviewerAssignments || {};
        return {
            okrs: (l.okrs || []).length,
            postings: (l.postings || []).length,
            reviews: (ra.pendingReviews || []).reduce((a, r) => a + Number(r.count || 0), 0),
            delegations: (ra.delegations || []).length,
            cycleAssignments: (ra.cycleAssignments || []).length,
            nationalisationPlans: (l.nationalisationPlans || []).length,
        };
    }

    /**
     * F11 (3.23.21) — put an employee on legal hold BEFORE departure (or lift
     * it). Recorded on the employee (migration 157: who / when / why) and carried
     * into the retention job by onLeaver, so the retention purge — which skips a
     * held job — never erases them. Reason mandatory; audited; nothing deleted.
     * When the person has already left, the open retention job is held too.
     */
    static async setEmployeeLegalHold(employeeId, { hold, reason, actorRef = null } = {}) {
        const id = Number(employeeId);
        const why = String(reason || '').trim();
        const fail = (code, status) => {
            const e = new Error(code);
            e.code = code;
            e.status = status;
            e.expose = true;
            return e;
        };
        if (!why) throw fail('reason_required', 400);
        const emp = await db.get('SELECT id, erased_at FROM employees WHERE id = ?', [id]);
        if (!emp) throw fail('employee_not_found', 404);
        if (emp.erasedAt) throw fail('employee_erased', 409);
        const ref = actorRef ? String(actorRef).slice(0, 64) : null;
        await db.runTransaction(async () => {
            if (hold) {
                await db.run(
                    `UPDATE employees SET legal_hold_at = now(), legal_hold_by = ?, legal_hold_reason = ?
                      WHERE id = ?`,
                    [ref, why.slice(0, 2000), id]
                );
                await db.run(
                    `UPDATE pii_cleanup_jobs SET legal_hold_at = now(), legal_hold_by = ?, legal_hold_reason = ?
                      WHERE employee_id = ? AND completed_at IS NULL AND legal_hold_at IS NULL`,
                    [ref, why.slice(0, 2000), id]
                );
            } else {
                await db.run(
                    `UPDATE employees SET legal_hold_at = NULL, legal_hold_by = NULL, legal_hold_reason = NULL
                      WHERE id = ?`,
                    [id]
                );
            }
        });
        try {
            await require('./LogService').log({
                action: hold ? 'EMPLOYEE_LEGAL_HOLD_SET' : 'EMPLOYEE_LEGAL_HOLD_RELEASED',
                entityType: 'employee',
                entityId: id,
                details: `${hold ? 'Legal hold set (before departure)' : 'Legal hold released on the employee'} — reason: ${why}`,
                severity: 'warning',
                category: 'maintenance',
                actorRef: ref,
            });
        } catch (_) {
            /* best-effort */
        }
        return { ok: true, employeeId: id, hold: Boolean(hold) };
    }

    static async _announceOrphanedReports(leaverId, reports, leftovers = null) {
        try {
            const N = require('./NotificationService');
            const recipients = new Map();
            const add = (userType, id) => {
                if (id) recipients.set(`${userType}:${Number(id)}`, { userType, id: Number(id) });
            };
            for (const r of await require('./ReportingLineService').lineRecipients(leaverId, {
                includeManager: true,
            }))
                add(r.userType, r.id);
            let admins = [];
            try {
                admins = await require('./GovernanceService').coveringAdmins(leaverId);
            } catch (_) {
                admins = [];
            }
            for (const a of admins) add('admin', a.adminId);
            if (!admins.length) {
                const supers = await db
                    .all(
                        "SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true ORDER BY id"
                    )
                    .catch(() => []);
                for (const s of supers || []) add('admin', s.id);
            }
            const meta = N.KIND_META || {};
            const kind = meta['lifecycle.reports_to_reassign']
                ? 'lifecycle.reports_to_reassign'
                : 'lifecycle.leaver';
            const payload = {
                link: `/employees/${Number(leaverId)}`,
                leaverId: Number(leaverId),
                count: reports.length,
                employeeIds: reports.map((r) => r.id),
            };
            // the notice also names what else the leaver held — OKRs,
            // authored mobility postings, reviewer assignments, local-content
            // plans — as ids + counts, and as one readable line (the `reason`
            // the notification centre prints under the title).
            if (leftovers) {
                const c = this.leftoverCounts(leftovers);
                payload.leftovers = {
                    okrIds: (leftovers.okrs || []).map((g) => g.id),
                    postingIds: (leftovers.postings || []).map((o) => o.id),
                    reviewerAssignments: leftovers.reviewerAssignments || {},
                    nationalisationPlanIds: leftovers.nationalisationPlans || [],
                    counts: c,
                };
                const summary = this.leftoverSummary(reports.length, c);
                if (summary) payload.reason = summary;
            }
            for (const r of recipients.values()) {
                await N.notify({
                    userType: r.userType,
                    userId: r.id,
                    kind,
                    category: 'lifecycle',
                    // The employee record is an admin surface; a line manager
                    // lands on the continuity page where the departure is shown.
                    payload:
                        r.userType === 'admin' ? payload : { ...payload, link: '/v2/continuity' },
                }).catch(() => {});
            }
            return recipients.size;
        } catch (_) {
            return 0; // never block JML
        }
    }

    /**
     * The campaign a JOINER event enrolled the arrival into.
     *
     *   1. `payload.cycleId`, stamped by onJoiner at the moment of enrolment —
     *      the only source that is actually the truth.
     *   2. legacy events (processed before that stamp existed): the campaign
     *      whose OPEN WINDOW contains the event's occurred_at, chosen by the
     *      same `ORDER BY closes_at LIMIT 1` rule onJoiner used, so the
     *      reconstruction matches what onJoiner would have picked that day.
     *   3. neither → null. The caller must then delete nothing.
     */
    static async _joinerOriginCycleId(ev) {
        const fromPayload =
            ev && ev.payload && ev.payload.cycleId != null ? Number(ev.payload.cycleId) : null;
        if (Number.isFinite(fromPayload) && fromPayload > 0) {
            const exists = await db.get('SELECT id FROM assessment_cycles WHERE id = ?', [
                fromPayload,
            ]);
            if (exists) return Number(exists.id);
        }
        if (!ev || !ev.occurredAt) return null;
        const c = await db.get(
            `SELECT id FROM assessment_cycles
              WHERE opened_at <= ? AND closes_at >= ?
              ORDER BY closes_at LIMIT 1`,
            [ev.occurredAt, ev.occurredAt]
        );
        return c ? Number(c.id) : null;
    }

    /**
     * Undo the ACCESS side of a leaver: the linked admin accounts onLeaver
     * deactivated and the API keys it revoked. Restores exactly the ids the
     * event recorded — never a blanket un-revoke, which would resurrect keys
     * killed for an unrelated reason.
     *
     * A legacy event carries no record. The admin accounts are then recovered
     * from the same selection onLeaver itself used (linked + currently
     * inactive), and the keys are reported as NOT RECORDED rather than guessed
     * at: an unknown is surfaced, never presented as a restored count.
     */
    static async _restoreLeaverAccess(ev) {
        const out = {};
        const p = (ev && ev.payload) || {};
        const adminIds = Array.isArray(p.revokedAdminIds)
            ? p.revokedAdminIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : null;
        const keyIds = Array.isArray(p.revokedApiKeyIds)
            ? p.revokedApiKeyIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : null;

        if (adminIds) {
            let n = 0;
            for (const id of adminIds) {
                const r = await db.run(
                    'UPDATE admins SET is_active = true WHERE id = ? AND is_active = false',
                    [id]
                );
                n += r && r.changes != null ? r.changes : 0;
            }
            out.adminAccountsReactivated = n;
        } else {
            const r = await db.run(
                'UPDATE admins SET is_active = true WHERE linked_employee_id = ? AND is_active = false',
                [ev.employeeId]
            );
            out.adminAccountsReactivated = r && r.changes != null ? r.changes : 0;
            out.adminAccountsInferred = true;
        }

        if (keyIds) {
            let n = 0;
            if (keyIds.length) {
                const rows = await db.all(
                    `UPDATE api_keys SET revoked_at = NULL
                      WHERE id IN (${keyIds.map(() => '?').join(',')}) AND revoked_at IS NOT NULL
                      RETURNING id`,
                    keyIds
                );
                n = Array.isArray(rows) ? rows.length : 0;
            }
            out.apiKeysRestored = n;
        } else {
            // Not measured, so not reported as a number.
            out.apiKeysRestored = null;
            out.apiKeysNotRecorded = true;
        }
        return out;
    }

    /**
     * Super-admin correction: undo the side effects of an event recorded by
     * mistake. The event row is kept (audit trail) and stamped with
     * reverted_at / reverted_by. Runs in a single transaction.
     *
     *   joiner : delete the pristine provisional level-0 draft shells the
     *            enrolment created (rows the employee already touched stay).
     *   mover  : cancel the auto-created handover plan (if not completed).
     *   leaver : reactivate the account, drop the pending PII cleanup job,
     *            cancel the auto-created handover plan.
     */
    static async revert(eventId, { adminId = null, note = null, actor } = {}) {
        return db.runTransaction(async () => {
            const ev = await db.get(
                `SELECT id, employee_id, kind, reverted_at, occurred_at, payload
                   FROM lifecycle_events WHERE id = ?`,
                [eventId]
            );
            if (!ev) {
                const e = new Error('event_not_found');
                e.status = 404;
                throw e;
            }
            if (ev.revertedAt) {
                const e = new Error('already_reverted');
                e.status = 409;
                throw e;
            }

            const summary = { kind: ev.kind, employeeId: Number(ev.employeeId) };

            if (ev.kind === 'joiner') {
                // THE CAMPAIGN THIS ARRIVAL WAS ENROLLED INTO — not the one that
                // happens to be open at the moment somebody clicks "revert".
                //
                // The old sub-select read `assessment_cycles WHERE status = 'open'`
                // AT REVERT TIME. Reproduced by rolled-back probe: the arrival had
                // seeded 50 shells in campaign A, A then closed and an unrelated
                // campaign B opened with 1 shell for the same person —
                //   revert summary -> {"assessmentShellsRemoved":1}
                //   AFTER revert -> origin campaign A still holds: 50
                //                 | unrelated campaign B now holds: 0
                // i.e. it deleted a row from a campaign that had nothing to do with
                // the correction, left all 50 rows it was meant to remove, and
                // reported "1 removed".
                const originCycleId = await this._joinerOriginCycleId(ev);
                if (originCycleId == null) {
                    // Nothing ties the event to a campaign (a legacy event recorded
                    // outside any campaign window). Deleting from an arbitrary cycle
                    // is exactly the defect above — do nothing and SAY so, rather
                    // than report a number that describes the wrong campaign.
                    summary.assessmentShellsRemoved = 0;
                    summary.originCycleUnknown = true;
                } else {
                    const r = await db.run(
                        // Only UNRATED shells. Matching `self_rated_level = 0` deleted
                        // the answers of anyone who had genuinely rated a skill "None"
                        // before the arrival was reverted.
                        // Since migration 113 `self_assessments` is the CURRENT
                        // measurement round, so this can only ever remove a shell
                        // nobody has answered — never an earlier round, which is
                        // what "nothing is deleted" is about.
                        `DELETE FROM self_assessments
                         WHERE employee_id = ? AND status = 'draft' AND workflow_state = 'draft'
                           AND locked_state = 'provisional' AND self_rated_level IS NULL
                           AND cycle_id = ?`,
                        [ev.employeeId, originCycleId]
                    );
                    summary.originCycleId = Number(originCycleId);
                    summary.assessmentShellsRemoved =
                        r && r.changes != null ? r.changes : undefined;
                }
            } else if (ev.kind === 'leaver') {
                // NEVER unconditionally. A record VOIDED after the departure
                // (cancelled_at set — "created in error") or ERASED under GDPR
                // (erased_at set) came back `is_active = true` here: an active AND
                // cancelled row that voidEmployee then refused to re-void, or an
                // "Erased 84" back in every denominator. Reproduced by rolled-back
                // probe: leaver → void → revert answered {"reactivated":true} and
                // the row read is_active=true, voided=true. Refuse, inside the
                // transaction, so the event is not stamped reverted either.
                await this._assertReinstatable(Number(ev.employeeId));
                await db.run(
                    `UPDATE employees SET is_active = true, is_account_active = true
                      WHERE id = ? AND cancelled_at IS NULL AND erased_at IS NULL`,
                    [ev.employeeId]
                );
                await db.run(
                    `DELETE FROM pii_cleanup_jobs WHERE employee_id = ? AND completed_at IS NULL`,
                    [ev.employeeId]
                );
                // A DEPARTURE SWITCHES OFF MORE THAN THE EMPLOYEE ROW.
                // onLeaver also deactivates every linked ADMIN account and revokes
                // that admin's API keys. The revert restored only the employee row
                // and still answered `reactivated: true`. Reproduced by probe:
                //   AFTER leaver  employee.is_active = false | linked admin.is_active = false | api key live = false
                //   revert summary -> {"kind":"leaver","reactivated":true}
                //   AFTER revert  employee.is_active = true  | linked admin.is_active = false | api key live = false
                // So a person "reinstated" after a mistaken departure silently kept
                // no admin login and no working integration key.
                //
                // 3.23.17 (A-2): an ADMIN account is authority, not HR data. A
                // scoped admin holding edit_employees may reinstate a PERSON in
                // their scope, but switching a linked admin account (and its API
                // keys) back on could hand back reach wider than anything they
                // could grant. That part is SuperAdmin-only when a human actor is
                // named; the rest of the reinstatement proceeds and the summary
                // SAYS the access part was left for a SuperAdmin (admin console →
                // "Réactiver"). `actor` undefined = system path (SCIM, legacy).
                if (actor === undefined || require('./RBACService').isSuperAdmin(actor)) {
                    Object.assign(summary, await this._restoreLeaverAccess(ev));
                } else {
                    summary.adminAccessDeferred = true;
                }
                // F8 (3.23.18 R2): re-open EXACTLY what the departure closed —
                // the list journaled on this event, nothing else.
                if (ev.payload && ev.payload.leaverClosed) {
                    Object.assign(summary, await this._reopenLeaverPlans(ev.payload.leaverClosed));
                }
                summary.reactivated = true;
            }
            // mover has no structural side effect beyond the handover plan.

            if (ev.kind === 'mover' || ev.kind === 'leaver') {
                await db.run(
                    `UPDATE handover_plans SET status = 'cancelled', updated_at = now()
                     WHERE lifecycle_event_id = ? AND status <> 'completed'`,
                    [ev.id]
                );
            }

            await db.run(
                `UPDATE lifecycle_events SET reverted_at = now(), reverted_by = ?, revert_note = ?
                 WHERE id = ?`,
                [adminId, note, ev.id]
            );
            return summary;
        });
    }
}

module.exports = LifecycleService;
