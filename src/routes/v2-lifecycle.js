'use strict';

/**
 * /v2/lifecycle — the Joiner / Mover / Leaver ledger.
 *
 *   GET  /                       filterable, paged history (kind / state / site /
 *                                search) + the record form with a searchable picker.
 *   POST /events                 record an event. A LEAVER needs a reason and
 *                                the edit_employees capability; a manager (or an
 *                                admin without it) may only REQUEST it — the row
 *                                waits for an admin decision.
 *                                A future effective date schedules the departure;
 *                                the hourly tick executes it.
 *   POST /events/:id/decide      approve / decline a requested departure.
 *   POST /events/:id/revert      leaver: an admin holding edit_employees, inside
 *                                scope; joiner / mover: SuperAdmin.
 *
 * Every JSON refusal carries a stable `code` and the sentence translated in
 * the caller's language (talentx:lc_err_<code>) — never English on a French page.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const RBACService = require('../services/RBACService');
const LifecycleService = require('../services/LifecycleService');
const LogService = require('../services/LogService');
const ah = require('../utils/asyncHandler');
const { parsePage, buildPager } = require('../utils/listTools');

const KINDS = ['joiner', 'mover', 'leaver'];
const STATES = ['requested', 'scheduled', 'pending', 'done', 'skipped', 'declined', 'reverted'];
const PER_PAGE = [25, 50, 100];

function say(req, code, params) {
    return req.t
        ? req.t(`talentx:lc_err_${code}`, { defaultValue: code, ...(params || {}) })
        : code;
}
function refuse(req, res, status, code, params) {
    return res.status(status).json({ ok: false, code, error: say(req, code, params) });
}

/** May this caller execute or undo a departure (not merely request one)? */
function canDecideLeaver(user) {
    return (
        user.userType === 'admin' &&
        (RBACService.isSuperAdmin(user) || RBACService.hasPermission(user, 'edit_employees'))
    );
}

async function inScope(user, employeeId) {
    if (RBACService.isSuperAdmin(user)) return true;
    if (user.userType === 'admin') return RBACService.canAccessEmployee(user, Number(employeeId));
    return (await RBACService.getFilteredEmployees(user)).some(
        (e) => Number(e.id) === Number(employeeId)
    );
}

// SQL predicate for a state filter (mirrors LifecycleService.stateOf).
const STATE_SQL = {
    requested: `le.requested_by IS NOT NULL AND le.decided_at IS NULL AND le.reverted_at IS NULL`,
    scheduled: `le.processed_at IS NULL AND le.reverted_at IS NULL AND le.effective_at > now() AND (le.requested_by IS NULL OR le.decision = 'approved')`,
    pending: `le.processed_at IS NULL AND le.reverted_at IS NULL AND (le.effective_at IS NULL OR le.effective_at <= now()) AND (le.requested_by IS NULL OR le.decision = 'approved')`,
    done: `le.processed_at IS NOT NULL AND le.reverted_at IS NULL AND NOT (le.payload ? 'skipped') AND COALESCE(le.decision, '') <> 'declined'`,
    skipped: `le.processed_at IS NOT NULL AND le.reverted_at IS NULL AND (le.payload ? 'skipped')`,
    declined: `le.decision = 'declined' AND le.reverted_at IS NULL`,
    reverted: `le.reverted_at IS NOT NULL`,
};

router.get(
    '/',
    requireAuth,
    ah(async (req, res) => {
        const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });
        const kind = KINDS.includes(req.query.kind) ? req.query.kind : '';
        const state = STATES.includes(req.query.state) ? req.query.state : '';
        const siteId = parseInt(req.query.siteId, 10) || null;
        const q = String(req.query.q || '').trim();
        const { page, perPage, offset } = parsePage(req.query, {
            perPageOptions: PER_PAGE,
            defaultPerPage: 25,
        });

        const where = ['1=1' + sc.clause];
        const params = [...sc.params];
        if (kind) {
            where.push('le.kind = ?');
            params.push(kind);
        }
        if (state) where.push(`(${STATE_SQL[state]})`);
        if (siteId) {
            where.push('e.site_id = ?');
            params.push(siteId);
        }
        if (q) {
            where.push(
                `((e.first_name || ' ' || e.last_name) ILIKE ? OR e.employee_number ILIKE ?)`
            );
            params.push(`%${q}%`, `%${q}%`);
        }
        const W = where.join(' AND ');

        const total =
            Number(
                (
                    (await db.get(
                        `SELECT COUNT(*)::int AS cnt FROM lifecycle_events le JOIN employees e ON e.id = le.employee_id WHERE ${W}`,
                        params
                    )) || {}
                ).cnt
            ) || 0;
        const rows = await db.all(
            `SELECT le.id, le.kind, le.occurred_at, le.processed_at, le.reverted_at, le.reason, le.effective_at,
                le.requested_by, le.decided_at, le.decision, le.payload,
                e.id AS employee_id, e.first_name, e.last_name, e.employee_number, e.cancelled_at, e.erased_at,
                s.name AS site_name,
                a.username AS reverted_by_name, a2.username AS decided_by_name
           FROM lifecycle_events le
           JOIN employees e ON e.id = le.employee_id
           LEFT JOIN sites s ON s.id = e.site_id
           LEFT JOIN admins a ON a.id = le.reverted_by
           LEFT JOIN admins a2 ON a2.id = le.decided_by
          WHERE ${W}
          ORDER BY le.occurred_at DESC, le.id DESC
          LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );
        const canDecide = canDecideLeaver(req.user);
        const isSuper = RBACService.isSuperAdmin(req.user);
        const events = rows.map((ev) => ({
            ...ev,
            state: LifecycleService.stateOf(ev),
            // A voided or erased subject must never offer a "revert".
            canRevert:
                !ev.revertedAt &&
                !ev.cancelledAt &&
                !ev.erasedAt &&
                (ev.kind === 'leaver' ? canDecide : isSuper) &&
                (ev.processedAt || (ev.requestedBy && ev.decidedAt)),
            canDecideRow: canDecide && !!ev.requestedBy && !ev.decidedAt && !ev.revertedAt,
        }));

        const employees = (await RBACService.getFilteredEmployees(req.user)).map((e) => ({
            id: Number(e.id),
            name: `${e.firstName} ${e.lastName}`,
            number: e.employeeNumber || '',
        }));
        // Site filter options follow the caller's reach (never the whole org).
        let sites;
        if (req.user.userType === 'admin') sites = await RBACService.getFilteredSites(req.user);
        else {
            const seen = new Map();
            (await RBACService.getFilteredEmployees(req.user)).forEach((e) => {
                if (e.siteId && !seen.has(Number(e.siteId)))
                    seen.set(Number(e.siteId), { id: Number(e.siteId), name: e.siteName });
            });
            sites = [...seen.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
        }
        const pendingRequests = canDecide
            ? Number(
                  (
                      (await db.get(
                          `SELECT COUNT(*)::int AS cnt FROM lifecycle_events le JOIN employees e ON e.id = le.employee_id WHERE 1=1 ${sc.clause} AND ${STATE_SQL.requested}`,
                          sc.params
                      )) || {}
                  ).cnt
              ) || 0
            : 0;

        res.render('pages/lifecycle/index', {
            title: req.t ? req.t('chrome:nav_lifecycle_title') : 'Joiner / Mover / Leaver',
            events,
            employees,
            sites,
            filters: { kind, state, siteId, q, perPage },
            kinds: KINDS,
            states: STATES,
            perPageOptions: PER_PAGE,
            total,
            pager: buildPager(req.query, { page, total, perPage, basePath: '/v2/lifecycle' }),
            isSuperAdmin: isSuper,
            canDecide,
            isManagerUser: req.user.userType !== 'admin',
            pendingRequests,
        });
    })
);

router.post(
    '/events',
    requireAuth,
    ah(async (req, res) => {
        const { employeeId, kind, payload } = req.body;
        if (!employeeId || !kind) return refuse(req, res, 400, 'employee_and_kind_required');
        // lifecycle_events.kind is an enum — validate up front so a bad value is a
        // clean 400, not a PG enum error → 500.
        if (!KINDS.includes(kind)) return refuse(req, res, 400, 'bad_kind');
        // 3.23.17 (A-2): a Viewer is read-only — recording (or requesting) a JML
        // event is a write whatever its kind.
        if (RBACService.isViewer(req.user)) return refuse(req, res, 403, 'read_only_account');
        // The scope check below is made on `employeeId`; a payload naming another
        // person used to be spread OVER it in the cascade. Refuse it outright.
        if (payload != null && (typeof payload !== 'object' || Array.isArray(payload)))
            return refuse(req, res, 400, 'bad_payload');
        if (
            payload &&
            payload.employeeId != null &&
            String(payload.employeeId) !== String(employeeId)
        ) {
            return refuse(req, res, 400, 'payload_employee_mismatch');
        }
        if (!(await inScope(req.user, employeeId)))
            return refuse(req, res, 403, 'not_authorized_employee');
        const reason =
            String(req.body.reason || '')
                .trim()
                .slice(0, 500) || null;
        const effectiveAt = req.body.effectiveAt ? new Date(req.body.effectiveAt) : null;
        if (effectiveAt && Number.isNaN(effectiveAt.getTime()))
            return refuse(req, res, 400, 'bad_effective_date');
        const actorRef = LifecycleService.actorRef(req.user);

        if (kind === 'leaver') {
            // A departure without a stated reason is not auditable (same rule as
            // every cancellation in the product).
            if (!reason) return refuse(req, res, 400, 'lc_reason_required');
            const subject = await db.get(
                'SELECT is_active, cancelled_at, erased_at FROM employees WHERE id = ?',
                [Number(employeeId)]
            );
            if (!subject || subject.cancelledAt || subject.erasedAt)
                return refuse(req, res, 409, 'subject_not_leavable');
            if (!subject.isActive) return refuse(req, res, 409, 'already_left');
            if (!canDecideLeaver(req.user)) {
                // Request-only path: a manager (or an admin without edit_employees)
                // asks; nothing is switched off until an admin decides.
                const r = await LifecycleService.requestLeaver(Number(employeeId), {
                    requestedBy: req.user,
                    reason,
                    effectiveAt,
                });
                await LogService.log({
                    adminId: req.user.userType === 'admin' ? req.user.id : null,
                    actorRef,
                    action: 'LIFECYCLE_LEAVER_REQUESTED',
                    entityType: 'employee',
                    entityId: Number(employeeId),
                    details: `Departure requested for employee #${employeeId} — ${reason}${effectiveAt ? ` (effective ${effectiveAt.toISOString().slice(0, 10)})` : ''}`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                return res.status(202).json({
                    ok: true,
                    requested: true,
                    id: r.id,
                    message: say(req, 'leaver_requested'),
                });
            }
            const r = await LifecycleService.record('leaver', Number(employeeId), {
                payload: payload || {},
                reason,
                effectiveAt,
                actorRef,
            });
            await LogService.log({
                adminId: req.user.id,
                actorRef,
                action: r.scheduled ? 'LIFECYCLE_LEAVER_SCHEDULED' : 'LIFECYCLE_LEAVER_RECORDED',
                entityType: 'employee',
                entityId: Number(employeeId),
                details: `Departure ${r.scheduled ? 'scheduled for ' + effectiveAt.toISOString().slice(0, 10) : 'recorded'} for employee #${employeeId} — ${reason}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            return res.json({
                ok: true,
                scheduled: r.scheduled,
                id: r.id,
                message: say(req, r.scheduled ? 'leaver_scheduled' : 'leaver_recorded'),
            });
        }
        const r = await LifecycleService.record(kind, Number(employeeId), {
            payload: payload || {},
            reason,
            effectiveAt: null,
            actorRef,
        });
        res.json({
            ok: true,
            id: r.id,
            message: say(req, kind === 'joiner' ? 'joiner_recorded' : 'mover_recorded'),
        });
    })
);

// Admin decision on a requested departure (edit_employees, inside scope).
router.post(
    '/events/:id/decide',
    requireAuth,
    ah(async (req, res) => {
        if (!canDecideLeaver(req.user))
            return refuse(req, res, 403, 'decide_requires_edit_employees');
        const eventId = Number(req.params.id);
        if (!Number.isInteger(eventId) || eventId <= 0)
            return refuse(req, res, 400, 'invalid_event_id');
        const ev = await db.get('SELECT employee_id FROM lifecycle_events WHERE id = ?', [eventId]);
        if (!ev) return refuse(req, res, 404, 'event_not_found');
        if (!(await inScope(req.user, ev.employeeId)))
            return refuse(req, res, 403, 'not_authorized_employee');
        const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : null;
        try {
            const out = await LifecycleService.decide(eventId, {
                adminId: req.user.id,
                decision: req.body.decision,
                note,
            });
            await LogService.log({
                adminId: req.user.id,
                actorRef: LifecycleService.actorRef(req.user),
                action: out.declined ? 'LIFECYCLE_LEAVER_DECLINED' : 'LIFECYCLE_LEAVER_APPROVED',
                entityType: 'lifecycle_event',
                entityId: eventId,
                details: `${out.declined ? 'Declined' : 'Approved'} departure request #${eventId} for employee #${ev.employeeId}${note ? ` — ${note}` : ''}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            res.json({
                ok: true,
                ...out,
                message: say(
                    req,
                    out.declined
                        ? 'request_declined'
                        : out.scheduled
                          ? 'leaver_scheduled'
                          : 'leaver_recorded'
                ),
            });
        } catch (e) {
            if (e.status) return refuse(req, res, e.status, e.code || 'decide_failed');
            throw e;
        }
    })
);

// Revert an event recorded by mistake. Undoes the side effects (see
// LifecycleService.revert) and keeps the row for audit. A leaver may be
// reverted by an admin holding edit_employees inside their scope —
// whoever may deprovision within scope may reinstate within scope; joiner and
// mover corrections stay SuperAdmin.
router.post(
    '/events/:id/revert',
    requireAuth,
    ah(async (req, res) => {
        const eventId = Number(req.params.id);
        if (!Number.isInteger(eventId) || eventId <= 0)
            return refuse(req, res, 400, 'invalid_event_id');
        const ev = await db.get('SELECT employee_id, kind FROM lifecycle_events WHERE id = ?', [
            eventId,
        ]);
        if (!ev) return refuse(req, res, 404, 'event_not_found');
        const allowed =
            ev.kind === 'leaver'
                ? canDecideLeaver(req.user) && (await inScope(req.user, ev.employeeId))
                : RBACService.isSuperAdmin(req.user);
        if (!allowed)
            return refuse(
                req,
                res,
                403,
                ev.kind === 'leaver' ? 'revert_requires_edit_employees' : 'super_admin_only'
            );
        const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : null;
        try {
            // `actor` makes the linked-admin-account restore SuperAdmin-only (A-2).
            const summary = await LifecycleService.revert(eventId, {
                adminId: req.user.id,
                note,
                actor: req.user,
            });
            await LogService.log({
                adminId: req.user.id,
                action: 'LIFECYCLE_REVERT',
                entityType: 'lifecycle_event',
                entityId: eventId,
                details: `Reverted ${summary.kind} for employee #${summary.employeeId}${note ? ` — ${note}` : ''}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            res.json({ ok: true, summary, message: say(req, 'reverted') });
        } catch (e) {
            if (e.status === 404) return refuse(req, res, 404, 'event_not_found');
            if (e.status === 409) return refuse(req, res, 409, e.code || 'already_reverted');
            throw e;
        }
    })
);

module.exports = router;
