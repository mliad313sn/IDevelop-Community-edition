'use strict';
/**
 * OneOnOneService — the shared one-to-one space of a person and their manager.
 *
 * Built on check_ins (kind 'one_on_one'): the pair's 'scheduled' row is the
 * NEXT meeting, 'completed' rows are the history — and TeamRosterService reads
 * those for the "last 1:1" column of the manager's roster. Around it:
 *   one_on_one_agenda_items  topics either side adds before the meeting
 *   one_on_one_notes         per author: 'shared' (both read) or 'private'
 *   check_in_items           action items (owner, due date, optional link to
 *                            an IDP objective or a goal)
 *
 * WHO SEES WHAT (strict)
 *   the employee      all their one-to-ones; writes with their current manager
 *   the manager       the meetings they held with this person (manager_id = them)
 *   HR within scope   the SHARED content of the person's meetings, read-only
 *   anybody else      404 — the space does not exist for them
 *   private notes     ONLY their author. Every query that reads them filters on
 *                     author = the person signed in; no role, admin or
 *                     SuperAdmin included, has a path to someone else's.
 */
const db = require('../config/database');
const RBACService = require('./RBACService');
const GovernanceService = require('./GovernanceService');
const EmployeeModel = require('../models/EmployeeModel');

const TOPIC_MAX = 1000;
const NOTE_MAX = 10000;
const ACTION_MAX = 500;
const HISTORY_LIMIT = 24;

function refuse(status, code) {
    const e = new Error(code);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}
const notFound = () => refuse(404, 'oo_not_found');
const toInt = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
};
const fullName = (r) => (r ? `${r.firstName || ''} ${r.lastName || ''}`.trim() : '');
function isoDate(v) {
    const s = String(v || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
        ? s
        : null;
}

class OneOnOneService {
    /**
     * Resolve the caller's part in `employeeId`'s space.
     * @returns {{ role:'employee'|'manager'|'hr', personId:number|null,
     *             employee:object, managerId:number|null, canWrite:boolean }}
     */
    async access(user, employeeId) {
        const eid = toInt(employeeId);
        if (!eid || !user) throw notFound();
        const emp = await EmployeeModel.findById(eid);
        if (!emp || emp.isActive === false) throw notFound();
        const personId = await GovernanceService.actingPersonId(user);
        const managerId = await GovernanceService.directManagerPersonId(eid);
        if (personId != null && Number(personId) === eid)
            return { role: 'employee', personId, employee: emp, managerId, canWrite: true };
        if (personId != null && managerId != null && Number(personId) === managerId)
            return {
                role: 'manager',
                personId,
                employee: emp,
                managerId,
                canWrite: !RBACService.isViewer(user),
            };
        if (user.userType === 'admin') {
            let covers = RBACService.isSuperAdmin(user);
            if (!covers) {
                try {
                    covers = Boolean(await RBACService.canAccessEmployeeData(user, emp));
                } catch (_) {
                    covers = false;
                }
            }
            if (covers) return { role: 'hr', personId, employee: emp, managerId, canWrite: false };
        }
        throw notFound();
    }

    /** The meeting filter for a role: the manager sees only their own meetings. */
    _meetingScope(a) {
        if (a.role === 'manager') return { clause: ' AND c.manager_id = ?', params: [a.personId] };
        return { clause: '', params: [] };
    }

    /** Load one meeting and the caller's part in it (404 when none). */
    async _meeting(user, meetingId) {
        const id = toInt(meetingId);
        if (!id) throw notFound();
        const c = await db.get(
            `SELECT id, employee_id, manager_id, status, scheduled_at, occurred_at
               FROM check_ins WHERE id = ? AND kind = 'one_on_one'`,
            [id]
        );
        if (!c) throw notFound();
        const a = await this.access(user, c.employeeId);
        if (a.role === 'manager' && Number(c.managerId) !== Number(a.personId)) throw notFound();
        const isParty =
            a.personId != null &&
            (Number(a.personId) === Number(c.employeeId) ||
                Number(a.personId) === Number(c.managerId));
        return { c, a, isParty };
    }

    _writable(m) {
        if (!m.isParty || !m.a.canWrite || m.a.role === 'hr') throw refuse(403, 'oo_forbidden');
    }

    /** The pair's next (scheduled) meeting, created on demand. */
    async ensureNext(a) {
        if (!a.managerId) throw refuse(409, 'oo_no_manager');
        const eid = Number(a.employee.id);
        const found = await db.get(
            `SELECT id FROM check_ins
              WHERE employee_id = ? AND manager_id = ? AND kind = 'one_on_one' AND status = 'scheduled'
              ORDER BY COALESCE(scheduled_at, created_at) LIMIT 1`,
            [eid, a.managerId]
        );
        if (found) return Number(found.id);
        const row = await db.get(
            `INSERT INTO check_ins (employee_id, manager_id, kind, status, created_by)
             VALUES (?, ?, 'one_on_one', 'scheduled', ?) RETURNING id`,
            [eid, a.managerId, a.personId]
        );
        return Number(row.id);
    }

    async _detail(ids, personId) {
        if (!ids.length) return new Map();
        const [agenda, shared, mine, actions] = await Promise.all([
            db.all(
                `SELECT g.id, g.check_in_id, g.body, g.discussed, g.author_employee_id, g.created_at,
                        e.first_name, e.last_name
                   FROM one_on_one_agenda_items g
                   LEFT JOIN employees e ON e.id = g.author_employee_id
                  WHERE g.check_in_id = ANY(?) ORDER BY g.created_at, g.id`,
                [ids]
            ),
            db.all(
                `SELECT n.check_in_id, n.author_employee_id, n.body, n.updated_at, e.first_name, e.last_name
                   FROM one_on_one_notes n
                   LEFT JOIN employees e ON e.id = n.author_employee_id
                  WHERE n.check_in_id = ANY(?) AND n.visibility = 'shared' ORDER BY n.id`,
                [ids]
            ),
            // PRIVATE notes: the author's own, and nothing else. No person → none.
            personId == null
                ? Promise.resolve([])
                : db.all(
                      `SELECT check_in_id, body, updated_at FROM one_on_one_notes
                        WHERE check_in_id = ANY(?) AND visibility = 'private' AND author_employee_id = ?`,
                      [ids, personId]
                  ),
            db.all(
                `SELECT i.id, i.check_in_id, i.body, i.done, i.due_on, i.owner_employee_id,
                        i.idp_objective_id, i.goal_id, o.first_name, o.last_name,
                        g.title AS goal_title, io.smart_text AS objective_text
                   FROM check_in_items i
                   LEFT JOIN employees o ON o.id = i.owner_employee_id
                   LEFT JOIN goals g ON g.id = i.goal_id
                   LEFT JOIN idp_objectives io ON io.id = i.idp_objective_id
                  WHERE i.check_in_id = ANY(?) AND i.is_action = true ORDER BY i.done, i.due_on NULLS LAST, i.id`,
                [ids]
            ),
        ]);
        const by = new Map(
            ids.map((id) => [Number(id), { agenda: [], shared: [], mine: null, actions: [] }])
        );
        for (const g of agenda)
            by.get(Number(g.checkInId)).agenda.push({
                id: Number(g.id),
                body: g.body,
                discussed: g.discussed === true,
                author: fullName(g),
                mine: personId != null && Number(g.authorEmployeeId) === Number(personId),
            });
        for (const n of shared)
            by.get(Number(n.checkInId)).shared.push({
                author: fullName(n),
                mine: personId != null && Number(n.authorEmployeeId) === Number(personId),
                body: n.body,
                updatedAt: n.updatedAt,
            });
        for (const n of mine)
            by.get(Number(n.checkInId)).mine = { body: n.body, updatedAt: n.updatedAt };
        for (const i of actions)
            by.get(Number(i.checkInId)).actions.push({
                id: Number(i.id),
                body: i.body,
                done: i.done === true,
                dueOn: i.dueOn || null,
                owner: fullName(i) || null,
                ownerId: i.ownerEmployeeId != null ? Number(i.ownerEmployeeId) : null,
                goal: i.goalId ? { id: Number(i.goalId), title: i.goalTitle } : null,
                objective: i.idpObjectiveId
                    ? { id: Number(i.idpObjectiveId), text: i.objectiveText }
                    : null,
            });
        return by;
    }

    /** Everything the space page shows, for this caller. */
    async space(user, employeeId) {
        const a = await this.access(user, employeeId);
        const eid = Number(a.employee.id);
        const sc = this._meetingScope(a);
        const meetings = await db.all(
            `SELECT c.id, c.manager_id, c.status, c.scheduled_at, c.occurred_at, c.created_at,
                    m.first_name, m.last_name
               FROM check_ins c
               LEFT JOIN employees m ON m.id = c.manager_id
              WHERE c.employee_id = ? AND c.kind = 'one_on_one' AND c.status <> 'cancelled'${sc.clause}
              ORDER BY (c.status = 'scheduled') DESC, COALESCE(c.occurred_at, c.scheduled_at, c.created_at) DESC
              LIMIT ${HISTORY_LIMIT + 1}`,
            [eid, ...sc.params]
        );
        // The pair's next meeting is the one with the CURRENT manager.
        const next = meetings.find(
            (m) =>
                m.status === 'scheduled' &&
                a.managerId != null &&
                Number(m.managerId) === a.managerId
        );
        const history = meetings.filter((m) => m.status === 'completed').slice(0, HISTORY_LIMIT);
        const ids = [...(next ? [Number(next.id)] : []), ...history.map((m) => Number(m.id))];
        const detail = await this._detail(ids, a.personId);
        const shape = (m) => ({
            id: Number(m.id),
            status: m.status,
            scheduledAt: m.scheduledAt || null,
            occurredAt: m.occurredAt || null,
            withName: fullName(m) || null,
            ...detail.get(Number(m.id)),
        });
        let manager = null;
        if (a.managerId) {
            const m = await db.get(`SELECT id, first_name, last_name FROM employees WHERE id = ?`, [
                a.managerId,
            ]);
            manager = m ? { id: Number(m.id), name: fullName(m) } : null;
        }
        const openActions = [];
        for (const m of history)
            for (const act of detail.get(Number(m.id)).actions)
                if (!act.done) openActions.push(act);

        // What an action item may be linked to: the person's live IDP objectives
        // and current goals — both parties' planning material, never HR-only data.
        let objectives = [];
        let goals = [];
        if (a.role !== 'hr') {
            objectives = await db.all(
                `SELECT o.id, o.smart_text FROM idp_objectives o JOIN idp_plans p ON p.id = o.idp_id
                  WHERE p.employee_id = ? AND p.status IN ('draft','active') AND o.state IN ('pending','in_progress')
                  ORDER BY o.id LIMIT 50`,
                [eid]
            );
            goals = await db.all(
                `SELECT id, title FROM goals WHERE employee_id = ? AND status IN ('active','at_risk')
                  ORDER BY id LIMIT 50`,
                [eid]
            );
        }
        return {
            role: a.role,
            canWrite: a.canWrite && a.role !== 'hr',
            employee: { id: eid, name: fullName(a.employee) },
            manager,
            next: next ? shape(next) : null,
            history: history.map(shape),
            openActions,
            links: {
                objectives: objectives.map((o) => ({ id: Number(o.id), text: o.smartText })),
                goals: goals.map((g) => ({ id: Number(g.id), title: g.title })),
            },
        };
    }

    async _notifyOther(a, meetingEmployeeId, meetingManagerId, kind, payload) {
        const other =
            Number(a.personId) === Number(meetingEmployeeId) ? meetingManagerId : meetingEmployeeId;
        if (!other) return;
        try {
            // Digest tier + quiet hours are applied by NotificationService.
            await require('./NotificationService').notify({
                userType: 'employee',
                userId: Number(other),
                kind,
                category: 'talent',
                payload,
            });
        } catch (_) {
            /* best-effort */
        }
    }

    /** Either side adds a topic to the next meeting; the other side is told. */
    async addTopic(user, employeeId, body) {
        const a = await this.access(user, employeeId);
        if (a.role === 'hr' || !a.canWrite) throw refuse(403, 'oo_forbidden');
        const text = String(body || '').trim();
        if (!text) throw refuse(400, 'oo_topic_required');
        if (text.length > TOPIC_MAX) throw refuse(400, 'oo_too_long');
        const meetingId = await this.ensureNext(a);
        const row = await db.get(
            `INSERT INTO one_on_one_agenda_items (check_in_id, author_employee_id, body) VALUES (?, ?, ?) RETURNING id`,
            [meetingId, a.personId, text]
        );
        await this._notifyOther(a, a.employee.id, a.managerId, 'oneonone.topic_added', {
            link: `/one-on-one/${Number(a.employee.id)}`,
        });
        return { id: Number(row.id), meetingId };
    }

    async setTopicDiscussed(user, topicId, discussed) {
        const t = await db.get(`SELECT id, check_in_id FROM one_on_one_agenda_items WHERE id = ?`, [
            toInt(topicId),
        ]);
        if (!t) throw notFound();
        const m = await this._meeting(user, t.checkInId);
        this._writable(m);
        await db.run(`UPDATE one_on_one_agenda_items SET discussed = ? WHERE id = ?`, [
            Boolean(discussed),
            t.id,
        ]);
        return { ok: true };
    }

    /** The author's topic, removable by the author only, before the meeting. */
    async removeTopic(user, topicId) {
        const t = await db.get(
            `SELECT id, check_in_id, author_employee_id FROM one_on_one_agenda_items WHERE id = ?`,
            [toInt(topicId)]
        );
        if (!t) throw notFound();
        const m = await this._meeting(user, t.checkInId);
        this._writable(m);
        if (Number(t.authorEmployeeId) !== Number(m.a.personId)) throw refuse(403, 'oo_forbidden');
        if (m.c.status !== 'scheduled') throw refuse(409, 'oo_meeting_held');
        await db.run(`DELETE FROM one_on_one_agenda_items WHERE id = ?`, [t.id]);
        return { ok: true };
    }

    /**
     * Save the caller's note on a meeting. 'shared' is read by both parties
     * (and HR within scope); 'private' by its author only. Empty = removed.
     */
    async saveNote(user, meetingId, visibility, body) {
        const m = await this._meeting(user, meetingId);
        this._writable(m);
        if (!['shared', 'private'].includes(visibility)) throw refuse(400, 'oo_bad_visibility');
        const text = String(body || '').trim();
        if (text.length > NOTE_MAX) throw refuse(400, 'oo_too_long');
        if (!text) {
            await db.run(
                `DELETE FROM one_on_one_notes WHERE check_in_id = ? AND author_employee_id = ? AND visibility = ?`,
                [m.c.id, m.a.personId, visibility]
            );
            return { ok: true, removed: true };
        }
        await db.run(
            `INSERT INTO one_on_one_notes (check_in_id, author_employee_id, visibility, body)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (check_in_id, author_employee_id, visibility) DO UPDATE SET body = EXCLUDED.body`,
            [m.c.id, m.a.personId, visibility, text]
        );
        return { ok: true };
    }

    /** Add an action item: an owner (either party), a due date, optional links. */
    async addAction(user, meetingId, input = {}) {
        const m = await this._meeting(user, meetingId);
        this._writable(m);
        const text = String(input.body || '').trim();
        if (!text) throw refuse(400, 'oo_action_required');
        if (text.length > ACTION_MAX) throw refuse(400, 'oo_too_long');
        const eid = Number(m.c.employeeId);
        let owner = toInt(input.ownerId) || Number(m.a.personId);
        if (owner !== eid && owner !== Number(m.c.managerId)) throw refuse(400, 'oo_bad_owner');
        const due = input.dueOn ? isoDate(input.dueOn) : null;
        if (input.dueOn && !due) throw refuse(400, 'oo_bad_date');
        let objectiveId = toInt(input.idpObjectiveId) || null;
        if (objectiveId) {
            const ok = await db.get(
                `SELECT 1 AS ok FROM idp_objectives o JOIN idp_plans p ON p.id = o.idp_id
                  WHERE o.id = ? AND p.employee_id = ?`,
                [objectiveId, eid]
            );
            if (!ok) throw refuse(400, 'oo_bad_link');
        }
        let goalId = toInt(input.goalId) || null;
        if (goalId) {
            const ok = await db.get(`SELECT 1 AS ok FROM goals WHERE id = ? AND employee_id = ?`, [
                goalId,
                eid,
            ]);
            if (!ok) throw refuse(400, 'oo_bad_link');
        }
        const row = await db.get(
            `INSERT INTO check_in_items (check_in_id, body, is_action, owner_employee_id, author_employee_id,
                                         due_on, idp_objective_id, goal_id)
             VALUES (?, ?, true, ?, ?, ?, ?, ?) RETURNING id`,
            [m.c.id, text, owner, m.a.personId, due, objectiveId, goalId]
        );
        return { id: Number(row.id) };
    }

    async setActionDone(user, itemId, done) {
        const it = await db.get(
            `SELECT id, check_in_id FROM check_in_items WHERE id = ? AND is_action = true`,
            [toInt(itemId)]
        );
        if (!it) throw notFound();
        const m = await this._meeting(user, it.checkInId);
        this._writable(m);
        await db.run(`UPDATE check_in_items SET done = ? WHERE id = ?`, [Boolean(done), it.id]);
        return { ok: true };
    }

    async schedule(user, meetingId, when) {
        const m = await this._meeting(user, meetingId);
        this._writable(m);
        if (m.c.status !== 'scheduled') throw refuse(409, 'oo_meeting_held');
        const d = new Date(String(when || ''));
        if (!when || Number.isNaN(d.getTime())) throw refuse(400, 'oo_bad_date');
        await db.run(`UPDATE check_ins SET scheduled_at = ? WHERE id = ?`, [
            d.toISOString(),
            m.c.id,
        ]);
        return { ok: true };
    }

    /**
     * Mark the next meeting as held. It becomes history (and the roster's "last
     * 1:1"); the topics nobody got to move to a fresh next meeting.
     */
    async complete(user, meetingId) {
        const m = await this._meeting(user, meetingId);
        this._writable(m);
        if (m.c.status !== 'scheduled') throw refuse(409, 'oo_meeting_held');
        const nextId = await db.runTransaction(async () => {
            await db.run(
                `UPDATE check_ins SET status = 'completed', occurred_at = COALESCE(occurred_at, now()) WHERE id = ?`,
                [m.c.id]
            );
            const left = await db.get(
                `SELECT COUNT(*)::int AS n FROM one_on_one_agenda_items WHERE check_in_id = ? AND discussed = false`,
                [m.c.id]
            );
            if (!left || !Number(left.n)) return null;
            const nx = await db.get(
                `INSERT INTO check_ins (employee_id, manager_id, kind, status, created_by)
                 VALUES (?, ?, 'one_on_one', 'scheduled', ?) RETURNING id`,
                [m.c.employeeId, m.c.managerId, m.a.personId]
            );
            await db.run(
                `UPDATE one_on_one_agenda_items SET check_in_id = ? WHERE check_in_id = ? AND discussed = false`,
                [nx.id, m.c.id]
            );
            return Number(nx.id);
        });
        return { ok: true, nextId };
    }
}

module.exports = new OneOnOneService();
