'use strict';

/**
 * HandoverService — knowledge continuity (Phase 2).
 *
 * Captures critical knowledge + transition tasks when someone leaves or moves
 * roles, so business continuity survives the departure. Plans are auto-created
 * (best-effort) from leaver/mover lifecycle events and can also be created
 * manually; each plan holds `handover_items` (knowledge / task / contact / access).
 */
const db = require('../config/database');

// How long an auto-created handover has to be completed. A leaver's knowledge
// evaporates the day they go, so their window is the tighter of the two.
const DUE_DAYS_LEAVER = Number(process.env.HANDOVER_DUE_DAYS_LEAVER) || 14;
const DUE_DAYS_MOVER = Number(process.env.HANDOVER_DUE_DAYS_MOVER) || 30;

const DEFAULT_ITEMS = [
    {
        title: 'In-flight work & deadlines',
        kind: 'task',
        detail: 'Open tasks, projects and commitments with dates.',
    },
    {
        title: 'Key contacts & stakeholders',
        kind: 'contact',
        detail: 'Internal and external people the successor must know.',
    },
    {
        title: 'Systems, accounts & access',
        kind: 'access',
        detail: 'Tools, shared mailboxes, licences and credentials to transfer or revoke.',
    },
    {
        title: 'Recurring duties & cadence',
        kind: 'knowledge',
        detail: 'Regular reports, meetings and operational routines.',
    },
    {
        title: 'Tacit knowledge & gotchas',
        kind: 'knowledge',
        detail: 'Undocumented context, workarounds and lessons learned.',
    },
];

class HandoverService {
    static get DUE_DAYS_LEAVER() {
        return DUE_DAYS_LEAVER;
    }
    static get DUE_DAYS_MOVER() {
        return DUE_DAYS_MOVER;
    }

    /** `YYYY-MM-DD`, N days after `from` (UTC-safe; `due_date` is a DATE column). */
    static dueDateFor(kind, from = new Date()) {
        const days = kind === 'mover' ? DUE_DAYS_MOVER : DUE_DAYS_LEAVER;
        const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }

    /**
     * Who owns this handover. `handover_plans.owner_admin_id` is an ADMIN FK, so a
     * manager (an employees row) cannot be stored here — the manager is reached
     * through the nudge instead (see jobs/reminders.js handover section). The
     * resolution walks from the most specific accountable admin to the least:
     *
     *   1. the owner of the succession plan for the outgoing person's role,
     *   2. the admin who designated that role critical,
     *   3. the longest-standing active superadmin.
     *
     * Returning null was the old behaviour and is what made every auto-created
     * plan ownerless; null now only happens when the install has no admin at all.
     */
    static async resolveOwnerAdminId(outgoingEmployeeId) {
        try {
            const row = await db.get(
                `SELECT COALESCE(
                          (SELECT sp.owner_admin_id FROM succession_plans sp
                            WHERE sp.position_role_id = e.role_id AND sp.status <> 'archived'
                              AND sp.owner_admin_id IS NOT NULL
                            ORDER BY sp.updated_at DESC LIMIT 1),
                          (SELECT rc.designated_by FROM role_criticality rc
                            WHERE rc.role_id = e.role_id AND rc.designated_by IS NOT NULL),
                          (SELECT a.id FROM admins a
                            WHERE a.role = 'superadmin' AND COALESCE(a.is_active, true) = true
                            ORDER BY a.id LIMIT 1)
                        ) AS owner_id
                   FROM employees e WHERE e.id = ?`,
                [outgoingEmployeeId]
            );
            return row && row.ownerId ? Number(row.ownerId) : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Plans that need chasing — the input to the weekly handover nudge.
     *
     *   overdue   : past its due date and not finished.
     *   dueSoon   : due within `dueWithinDays` AND still carrying open items.
     *   stale     : no due date at all and older than `staleDays` with open items
     *               (the ownerless shells created before the lifecycle fix).
     *
     * A freshly created plan is deliberately NOT due: every plan is seeded with
     * five open items, so "has incomplete items" on its own would nudge every
     * owner every week from day one, which is the noise this ledger exists to
     * avoid. Each row carries BOTH accountable parties — the owning admin and
     * the outgoing person's manager — so the caller can aggregate per recipient.
     */
    static async listDue({ dueWithinDays = 14, staleDays = 30 } = {}) {
        const within = Number(dueWithinDays) > 0 ? Number(dueWithinDays) : 14;
        const stale = Number(staleDays) > 0 ? Number(staleDays) : 30;
        const rows = await db.all(
            `SELECT h.id, h.outgoing_employee_id, h.owner_admin_id,
                    to_char(h.due_date, 'YYYY-MM-DD') AS due_ymd,
                    (h.due_date IS NOT NULL AND h.due_date < CURRENT_DATE) AS is_overdue,
                    (SELECT COUNT(*) FROM handover_items i
                      WHERE i.handover_id = h.id AND i.status <> 'completed')::int AS open_items
               FROM handover_plans h
               JOIN employees e ON e.id = h.outgoing_employee_id
              WHERE h.status IN ('open', 'in_progress')
                AND (
                      (h.due_date IS NOT NULL AND h.due_date < CURRENT_DATE)
                   OR (h.due_date IS NOT NULL
                       AND h.due_date <= (CURRENT_DATE + (? || ' days')::interval)::date
                       AND EXISTS (SELECT 1 FROM handover_items i2
                                    WHERE i2.handover_id = h.id AND i2.status <> 'completed'))
                   OR (h.due_date IS NULL
                       AND h.created_at < now() - (? || ' days')::interval
                       AND EXISTS (SELECT 1 FROM handover_items i3
                                    WHERE i3.handover_id = h.id AND i3.status <> 'completed'))
                    )
              ORDER BY h.due_date NULLS LAST, h.id`,
            [within, stale]
        );
        // The outgoing person's LINE (3.23.18 R2): ACTIVE effective reviewer +
        // the manager (employee or admin) when different. The outgoing person is
        // usually a LEAVER — the line is theirs, and a departed supervisor is
        // skipped for the next live link instead of swallowing the nudge.
        // `manager_id` is kept (first EMPLOYEE recipient) for older readers.
        const list = Array.isArray(rows) ? rows : [];
        let lines = new Map();
        try {
            lines = await require('./ReportingLineService').lineRecipientsMany(
                list.map((r) => Number(r.outgoingEmployeeId ?? r.outgoing_employee_id)),
                { includeManager: true }
            );
        } catch (_) {
            lines = new Map();
        }
        return list.map((r) => {
            const rec = lines.get(Number(r.outgoingEmployeeId ?? r.outgoing_employee_id)) || [];
            const firstEmp = rec.find((x) => x.userType === 'employee');
            return {
                ...r,
                managerId: firstEmp ? firstEmp.id : null,
                lineRecipients: rec.map((x) => ({ userType: x.userType, userId: x.id })),
            };
        });
    }

    /**
     * Idempotent: one open plan per (outgoing employee, lifecycle event).
     *
     * On an EXISTING plan the supplied successor / due date / owner backfill the
     * NULLs only — a value already set by a human is never clobbered. That is what
     * repairs the empty shells created before LifecycleService started resolving
     * these three fields.
     */
    static async ensureForEvent({
        lifecycleEventId = null,
        outgoingEmployeeId,
        incomingEmployeeId = null,
        dueDate = null,
        ownerAdminId = null,
        seed = true,
    } = {}) {
        if (!outgoingEmployeeId) return null;
        // Branch instead of passing a param to `IS NULL` (Postgres cannot infer
        // the parameter type otherwise — "could not determine data type").
        const existing =
            lifecycleEventId == null
                ? await db.get(
                      `SELECT * FROM handover_plans
                 WHERE outgoing_employee_id = ? AND status <> 'cancelled' AND lifecycle_event_id IS NULL
                 ORDER BY created_at DESC LIMIT 1`,
                      [outgoingEmployeeId]
                  )
                : await db.get(
                      `SELECT * FROM handover_plans
                 WHERE outgoing_employee_id = ? AND status <> 'cancelled' AND lifecycle_event_id = ?
                 ORDER BY created_at DESC LIMIT 1`,
                      [outgoingEmployeeId, lifecycleEventId]
                  );
        if (existing)
            return this._backfill(existing, { incomingEmployeeId, dueDate, ownerAdminId });
        const plan = await db.get(
            `INSERT INTO handover_plans (lifecycle_event_id, outgoing_employee_id, incoming_employee_id, due_date, owner_admin_id)
             VALUES (?, ?, ?, ?, ?) RETURNING *`,
            [lifecycleEventId, outgoingEmployeeId, incomingEmployeeId, dueDate, ownerAdminId]
        );
        if (seed) await this.seedDefaultItems(plan.id);
        return plan;
    }

    /**
     * Fill ONLY the fields that are still NULL on an existing plan (COALESCE per
     * column, and the UPDATE is skipped entirely when nothing would change), then
     * return the refreshed row. Never overwrites a successor, deadline or owner a
     * human already chose.
     */
    static async _backfill(
        plan,
        { incomingEmployeeId = null, dueDate = null, ownerAdminId = null } = {}
    ) {
        const wants = (current, next) => next != null && current == null;
        if (
            !wants(plan.incomingEmployeeId, incomingEmployeeId) &&
            !wants(plan.dueDate, dueDate) &&
            !wants(plan.ownerAdminId, ownerAdminId)
        )
            return plan;
        const updated = await db.get(
            `UPDATE handover_plans
                SET incoming_employee_id = COALESCE(incoming_employee_id, ?),
                    due_date             = COALESCE(due_date, ?::date),
                    owner_admin_id       = COALESCE(owner_admin_id, ?),
                    updated_at           = now()
              WHERE id = ? RETURNING *`,
            [incomingEmployeeId, dueDate, ownerAdminId, plan.id]
        );
        return updated || plan;
    }

    static async createManual({
        outgoingEmployeeId,
        incomingEmployeeId = null,
        dueDate = null,
        ownerAdminId = null,
    }) {
        return this.ensureForEvent({
            outgoingEmployeeId,
            incomingEmployeeId,
            dueDate,
            ownerAdminId,
            seed: true,
        });
    }

    static async seedDefaultItems(handoverId) {
        const existing = await db.get(
            'SELECT COUNT(*) AS n FROM handover_items WHERE handover_id = ?',
            [handoverId]
        );
        if (existing && Number(existing.n) > 0) return { added: 0 };
        for (const it of DEFAULT_ITEMS) {
            await db.run(
                'INSERT INTO handover_items (handover_id, title, detail, kind) VALUES (?, ?, ?, ?)',
                [handoverId, it.title, it.detail, it.kind]
            );
        }
        return { added: DEFAULT_ITEMS.length };
    }

    static async list() {
        return db.all(
            `SELECT h.*, eo.first_name AS out_first, eo.last_name AS out_last,
                    ei.first_name AS in_first, ei.last_name AS in_last,
                    (SELECT COUNT(*) FROM handover_items i WHERE i.handover_id = h.id) AS item_count,
                    (SELECT COUNT(*) FROM handover_items i WHERE i.handover_id = h.id AND i.status = 'completed') AS done_count
             FROM handover_plans h
             JOIN employees eo ON eo.id = h.outgoing_employee_id
             LEFT JOIN employees ei ON ei.id = h.incoming_employee_id
             WHERE h.status <> 'cancelled'
             ORDER BY CASE h.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, h.created_at DESC`
        );
    }

    static async get(handoverId) {
        const plan = await db.get(
            `SELECT h.*, eo.first_name AS out_first, eo.last_name AS out_last,
                    ei.first_name AS in_first, ei.last_name AS in_last
             FROM handover_plans h
             JOIN employees eo ON eo.id = h.outgoing_employee_id
             LEFT JOIN employees ei ON ei.id = h.incoming_employee_id
             WHERE h.id = ?`,
            [handoverId]
        );
        if (!plan) return null;
        plan.items = await db.all(
            'SELECT * FROM handover_items WHERE handover_id = ? ORDER BY id',
            [handoverId]
        );
        return plan;
    }

    static async setIncoming(handoverId, incomingEmployeeId) {
        await db.run(
            'UPDATE handover_plans SET incoming_employee_id = ?, updated_at = now() WHERE id = ?',
            [incomingEmployeeId || null, handoverId]
        );
    }

    static async addItem(handoverId, { title, detail, kind = 'knowledge' }) {
        if (!title) throw new Error('title required');
        return db.get(
            'INSERT INTO handover_items (handover_id, title, detail, kind) VALUES (?, ?, ?, ?) RETURNING *',
            [handoverId, title, detail || null, kind]
        );
    }

    static async setItemStatus(itemId, status) {
        await db.run('UPDATE handover_items SET status = ? WHERE id = ?', [status, itemId]);
        // Roll the plan to in_progress on first completion (best-effort).
        const it = await db.get('SELECT handover_id FROM handover_items WHERE id = ?', [itemId]);
        if (it) await this._reconcileStatus(it.handoverId);
    }

    static async _reconcileStatus(handoverId) {
        const c = await db.get(
            `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='completed') AS done
             FROM handover_items WHERE handover_id = ?`,
            [handoverId]
        );
        if (!c || Number(c.total) === 0) return;
        const done = Number(c.done),
            total = Number(c.total);
        if (done === total) {
            await db.run(
                "UPDATE handover_plans SET status='completed', updated_at=now() WHERE id=? AND status NOT IN ('cancelled','completed')",
                [handoverId]
            );
        } else if (done > 0) {
            // Some (not all) complete. Also rolls a 'completed' plan back to in_progress
            // when an item is reopened or a new item is added after completion.
            await db.run(
                "UPDATE handover_plans SET status='in_progress', updated_at=now() WHERE id=? AND status IN ('open','completed')",
                [handoverId]
            );
        } else {
            // Nothing complete (e.g. every item reopened) — return to 'open'.
            await db.run(
                "UPDATE handover_plans SET status='open', updated_at=now() WHERE id=? AND status IN ('in_progress','completed')",
                [handoverId]
            );
        }
    }

    /**
     * Completing a handover means the knowledge actually moved. Marking it
     * 'completed' with open items dropped it out of `listDue` — whose filter is
     * `status IN ('open','in_progress')` — so the weekly tick never chased it
     * again and the knowledge left with the person. The route accepted
     * 'completed' with no check at all.
     *
     * Returns { ok } or { ok:false, reason, openItems } so the caller can say why.
     */
    static async setStatus(handoverId, status) {
        if (status === 'completed') {
            const r = await db.get(
                // An item is settled when it is completed or explicitly cancelled;
                // 'open' and 'in_progress' both mean the knowledge has not moved.
                `SELECT COUNT(*)::int AS open FROM handover_items
                  WHERE handover_id = ? AND COALESCE(status, 'open') NOT IN ('completed', 'cancelled')`,
                [handoverId]
            );
            const open = r ? Number(r.open) : 0;
            if (open > 0) {
                return { ok: false, reason: 'open_items', openItems: open };
            }
        }
        await db.run('UPDATE handover_plans SET status = ?, updated_at = now() WHERE id = ?', [
            status,
            handoverId,
        ]);
        return { ok: true };
    }
}

module.exports = HandoverService;
