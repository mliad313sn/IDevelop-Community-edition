'use strict';
/**
 * Feedback360Service — 360° (multi-rater) feedback rounds.
 *
 * FLOW
 *   1. An HR admin (within their scope) or a manager (for their reporting line)
 *      launches a round for one person or a campaign of several. Each subject
 *      gets a questionnaire snapshot (their role skills + the behaviour
 *      statements), and two automatic raters: themselves and their manager.
 *   2. The subject nominates peers, direct reports and others.
 *   3. The manager (or HR within scope, or the launcher) approves or edits the
 *      nominations; the raters are notified.
 *   4. Raters answer: each skill 0–4 or "not observed", each behaviour, and
 *      three open comments (keep doing / start / stop).
 *   5. The round closes (by hand or at the deadline — jobs/feedback360.js) and
 *      the report is produced. The subject reads it once it is released
 *      (manager release, or automatically at close — per round).
 *
 * ANONYMITY
 *   A response row stores the rater GROUP only — no rater id, no timestamp, a
 *   random UUID key — and is written in the same transaction that flips the
 *   nomination's `responded` flag. So the launcher, the manager and HR can see
 *   WHO has answered (to remind the others) and never WHAT anyone answered. The
 *   report is computed by Feedback360Report (small-cell floor, merging, "not
 *   observed" ≠ 0) and exposes no rater identity: the only names it carries are
 *   the subject's and their manager's, as users expect.
 *
 * ACCESS (every refusal of a stranger is a 404 — the round does not exist for them)
 *   subject      their own nominations; their report once closed AND released
 *   manager      approve nominations, response status, report after close, release
 *   HR in scope  same as the manager (admin whose clearance covers the subject;
 *                a read-only viewer reads but never writes)
 *   launcher     manage the round (close, remind, status); not the report unless
 *                they are also the manager or HR in scope
 *   rater        their own questionnaire, once, while the round is open
 */
const db = require('../config/database');
const C = require('../config/feedback360');
const Report = require('./Feedback360Report');
const RBACService = require('./RBACService');
const GovernanceService = require('./GovernanceService');
const EmployeeModel = require('../models/EmployeeModel');

const MAX_SKILLS = 40;
const MAX_SUBJECTS = 200;
const MAX_NOMINATIONS = 30;

function refuse(status, code) {
    const e = new Error(code);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}
const notFound = () => refuse(404, 'f360_not_found');

function lang(locale) {
    return String(locale || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'fr';
}
function actorType(user) {
    return user && user.userType === 'admin' ? 'admin' : 'employee';
}
function fullName(r) {
    if (!r) return '';
    return `${r.firstName || ''} ${r.lastName || ''}`.trim();
}
function isoDate(v) {
    const s = String(v || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : s;
}
function todayIso() {
    return new Date().toISOString().slice(0, 10);
}
function toInt(v, def) {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) ? n : def;
}
function parseJson(v, def) {
    if (v == null) return def;
    if (typeof v === 'object') return v;
    try {
        return JSON.parse(v);
    } catch (_) {
        return def;
    }
}

async function notify(userId, kind, payload) {
    if (!userId) return;
    try {
        await require('./NotificationService').notify({
            userType: 'employee',
            userId: Number(userId),
            kind,
            category: 'talent',
            payload,
        });
    } catch (_) {
        /* best-effort */
    }
}

const SUBJECT_SQL = `SELECT s.id, s.round_id, s.employee_id, s.manager_employee_id, s.status, s.skills,
           s.nominated_at, s.approved_at, s.released_at,
           r.title, r.kind, r.status AS round_status, r.deadline, r.min_raters,
           r.anonymity_threshold, r.release_mode, r.behaviours, r.created_by_type, r.created_by_id,
           r.closed_at,
           e.first_name, e.last_name,
           m.first_name AS manager_first_name, m.last_name AS manager_last_name
      FROM feedback360_subjects s
      JOIN feedback360_rounds r ON r.id = s.round_id
      JOIN employees e ON e.id = s.employee_id
      LEFT JOIN employees m ON m.id = s.manager_employee_id`;

function mapSubject(r) {
    if (!r) return null;
    return {
        id: Number(r.id),
        roundId: Number(r.roundId),
        employeeId: Number(r.employeeId),
        managerEmployeeId: r.managerEmployeeId != null ? Number(r.managerEmployeeId) : null,
        status: r.status,
        skills: parseJson(r.skills, []),
        nominatedAt: r.nominatedAt || null,
        approvedAt: r.approvedAt || null,
        releasedAt: r.releasedAt || null,
        name: fullName(r),
        managerName:
            r.managerEmployeeId != null
                ? `${r.managerFirstName || ''} ${r.managerLastName || ''}`.trim()
                : null,
        round: {
            id: Number(r.roundId),
            title: r.title,
            kind: r.kind,
            status: r.roundStatus,
            deadline: r.deadline,
            minRaters: Number(r.minRaters),
            threshold: Report.floorOf(r.anonymityThreshold),
            releaseMode: r.releaseMode,
            behaviours: parseJson(r.behaviours, []),
            createdByType: r.createdByType,
            createdById: r.createdById != null ? Number(r.createdById) : null,
            closedAt: r.closedAt || null,
        },
    };
}

class Feedback360Service {
    // ------------------------------------------------------------------
    // Authority
    // ------------------------------------------------------------------

    /** Is this admin account HR for this employee (superadmin, or clearance covers them)? */
    async _hrCovers(user, employeeId) {
        if (!user || user.userType !== 'admin') return false;
        if (RBACService.isSuperAdmin(user)) return true;
        const emp = await EmployeeModel.findById(employeeId);
        if (!emp) return false;
        try {
            return Boolean(await RBACService.canAccessEmployeeData(user, emp));
        } catch (_) {
            return false;
        }
    }

    /**
     * What `user` may do on subject `s`. The subject never gets a manager/HR
     * power over their own round, whatever account they sign in with.
     */
    async roleFor(user, s) {
        const personId = await GovernanceService.actingPersonId(user);
        const isSubject = personId != null && Number(personId) === s.employeeId;
        const r = {
            personId,
            isSubject,
            isManager: false,
            isHr: false,
            isLauncher: false,
            canWrite: !RBACService.isViewer(user),
        };
        if (isSubject) return r;
        r.isManager =
            personId != null &&
            s.managerEmployeeId != null &&
            Number(personId) === s.managerEmployeeId;
        r.isHr = await this._hrCovers(user, s.employeeId);
        r.isLauncher =
            s.round.createdByType === actorType(user) &&
            s.round.createdById != null &&
            Number(s.round.createdById) === Number(user.id);
        return r;
    }

    /** May `user` launch a round for this employee? */
    async canLaunchFor(user, employeeId) {
        if (!user || RBACService.isViewer(user)) return false;
        const personId = await GovernanceService.actingPersonId(user);
        if (personId != null && Number(personId) === Number(employeeId)) return false;
        if (await this._hrCovers(user, employeeId)) return true;
        const line = await GovernanceService.lineAuthorityEmployeeIds(user);
        return line.some((id) => Number(id) === Number(employeeId));
    }

    /** The people a user may launch a round for (id + name), for the form. */
    async launchCandidates(user) {
        if (!user || RBACService.isViewer(user)) return [];
        const ids = new Set();
        if (user.userType === 'admin') {
            const scoped = await RBACService.getFilteredEmployees(user);
            for (const e of scoped || []) ids.add(Number(e.id));
        }
        for (const id of await GovernanceService.lineAuthorityEmployeeIds(user))
            ids.add(Number(id));
        const personId = await GovernanceService.actingPersonId(user);
        if (personId != null) ids.delete(Number(personId));
        if (!ids.size) return [];
        return db.all(
            `SELECT id, first_name, last_name, employee_number FROM employees
              WHERE id = ANY(?) AND is_active = true AND cancelled_at IS NULL
              ORDER BY last_name, first_name, id LIMIT 1000`,
            [[...ids]]
        );
    }

    /** The direct manager of a person, as a PERSON (employee id), or null. */
    async directManagerPerson(employeeId) {
        return GovernanceService.directManagerPersonId(employeeId);
    }

    /** Role skills (required level > 0) — the questionnaire's skill part. */
    async skillsFor(employeeId) {
        const rows = await db.all(
            `SELECT s.id, s.name, rsr.required_level, rsr.is_critical
               FROM employees e
               JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
               JOIN skills s ON s.id = rsr.skill_id
              WHERE e.id = ? AND rsr.required_level > 0 AND s.is_active = true
              ORDER BY rsr.is_critical DESC, rsr.required_level DESC, s.name, s.id
              LIMIT ${MAX_SKILLS}`,
            [employeeId]
        );
        return rows.map((r) => ({
            skillId: Number(r.id),
            name: r.name,
            required: Number(r.requiredLevel),
        }));
    }

    // ------------------------------------------------------------------
    // Launch
    // ------------------------------------------------------------------

    /**
     * Launch a round. Refuses the whole launch if any chosen person is outside
     * the launcher's authority (no partial round).
     * @returns {Promise<{roundId:number, subjects:number}>}
     */
    async launchRound(user, input = {}) {
        if (!user || RBACService.isViewer(user)) throw refuse(403, 'f360_forbidden');
        const title = String(input.title || '')
            .trim()
            .slice(0, 200);
        if (!title) throw refuse(400, 'f360_title_required');
        const deadline = isoDate(input.deadline);
        if (!deadline || deadline < todayIso()) throw refuse(400, 'f360_deadline_invalid');
        const minRaters = Math.min(20, Math.max(1, toInt(input.minRaters, C.DEFAULT_MIN_RATERS)));
        const threshold = Math.min(
            20,
            Math.max(C.MIN_THRESHOLD, toInt(input.threshold, C.DEFAULT_THRESHOLD))
        );
        const releaseMode = input.releaseMode === 'on_close' ? 'on_close' : 'manager';
        const raw = Array.isArray(input.employeeIds) ? input.employeeIds : [input.employeeIds];
        const ids = [...new Set(raw.map((v) => toInt(v, 0)).filter((n) => n > 0))];
        if (!ids.length) throw refuse(400, 'f360_subjects_required');
        if (ids.length > MAX_SUBJECTS) throw refuse(400, 'f360_too_many_subjects');
        for (const id of ids) {
            if (!(await this.canLaunchFor(user, id))) throw refuse(403, 'f360_forbidden');
        }
        const people = await db.all(
            `SELECT id FROM employees WHERE id = ANY(?) AND is_active = true AND cancelled_at IS NULL`,
            [ids]
        );
        if (people.length !== ids.length) throw refuse(400, 'f360_subject_inactive');

        const behaviours = C.DEFAULT_BEHAVIOURS.map((b) => ({ key: b.key, fr: b.fr, en: b.en }));
        const created = [];
        const roundId = await db.runTransaction(async () => {
            const round = await db.get(
                `INSERT INTO feedback360_rounds (title, kind, deadline, min_raters, anonymity_threshold,
                                                 release_mode, behaviours, created_by_type, created_by_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING id`,
                [
                    title,
                    ids.length > 1 ? 'campaign' : 'individual',
                    deadline,
                    minRaters,
                    threshold,
                    releaseMode,
                    JSON.stringify(behaviours),
                    actorType(user),
                    Number(user.id),
                ]
            );
            const rid = Number(round.id);
            for (const eid of ids) {
                const managerId = await this.directManagerPerson(eid);
                const skills = await this.skillsFor(eid);
                const s = await db.get(
                    `INSERT INTO feedback360_subjects (round_id, employee_id, manager_employee_id, skills)
                     VALUES (?, ?, ?, ?::jsonb) RETURNING id`,
                    [rid, eid, managerId, JSON.stringify(skills)]
                );
                const sid = Number(s.id);
                await db.run(
                    `INSERT INTO feedback360_nominations (subject_id, rater_employee_id, rater_group, status, proposed_by)
                     VALUES (?, ?, 'self', 'approved', 'system')`,
                    [sid, eid]
                );
                if (managerId) {
                    await db.run(
                        `INSERT INTO feedback360_nominations (subject_id, rater_employee_id, rater_group, status, proposed_by)
                         VALUES (?, ?, 'manager', 'approved', 'system')`,
                        [sid, managerId]
                    );
                }
                created.push({ subjectId: sid, employeeId: eid });
            }
            return rid;
        });
        for (const c of created) {
            await notify(c.employeeId, 'feedback360.nominate', {
                link: `/feedback-360/subjects/${c.subjectId}`,
                deadline,
            });
        }
        await this._audit(user, 'F360_ROUND_LAUNCHED', roundId, {
            subjects: created.length,
            deadline,
            threshold,
            releaseMode,
        });
        return { roundId, subjects: created.length };
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    async _subject(subjectId) {
        const id = toInt(subjectId, 0);
        if (!id) return null;
        return mapSubject(await db.get(`${SUBJECT_SQL} WHERE s.id = ?`, [id]));
    }

    /** The subject row, or a 404 when `user` has no part in it. */
    async _subjectFor(user, subjectId) {
        const s = await this._subject(subjectId);
        if (!s) throw notFound();
        const role = await this.roleFor(user, s);
        if (!role.isSubject && !role.isManager && !role.isHr && !role.isLauncher) throw notFound();
        return { s, role };
    }

    /**
     * The nominations page model. The subject sees what THEY proposed and, once
     * approved, only a count per group; managers/HR/launcher see the list with
     * who has responded (for reminders) — never what anyone answered.
     */
    async subjectView(user, subjectId) {
        const { s, role } = await this._subjectFor(user, subjectId);
        const rows = await db.all(
            `SELECT n.id, n.rater_employee_id, n.rater_group, n.status, n.proposed_by, n.responded,
                    e.first_name, e.last_name
               FROM feedback360_nominations n
               JOIN employees e ON e.id = n.rater_employee_id
              WHERE n.subject_id = ?
              ORDER BY n.rater_group, e.last_name, e.first_name, n.id`,
            [s.id]
        );
        const counts = {};
        for (const g of C.GROUPS) counts[g] = 0;
        for (const r of rows) if (r.status === 'approved') counts[r.raterGroup]++;
        const staff = role.isManager || role.isHr || role.isLauncher;
        let nominations;
        if (staff) {
            nominations = rows.map((r) => ({
                id: Number(r.id),
                employeeId: Number(r.raterEmployeeId),
                name: fullName(r),
                group: r.raterGroup,
                status: r.status,
                proposedBy: r.proposedBy,
                responded: r.responded === true,
            }));
        } else {
            // The subject: their own proposals only, and nothing about responses.
            nominations = rows
                .filter((r) => r.proposedBy === 'subject')
                .map((r) => ({
                    id: Number(r.id),
                    employeeId: Number(r.raterEmployeeId),
                    name: fullName(r),
                    group: r.raterGroup,
                    status:
                        s.status === 'nominating' || s.status === 'awaiting_approval'
                            ? r.status
                            : null,
                }));
        }
        return {
            subject: s,
            role: {
                isSubject: role.isSubject,
                isManager: role.isManager,
                isHr: role.isHr,
                isLauncher: role.isLauncher,
                canWrite: role.canWrite,
            },
            counts,
            nominations,
            canNominate: role.isSubject && s.status === 'nominating' && s.round.status === 'open',
            canApprove:
                !role.isSubject &&
                role.canWrite &&
                (role.isManager || role.isHr || role.isLauncher) &&
                ['nominating', 'awaiting_approval', 'collecting'].includes(s.status) &&
                s.round.status === 'open',
            canRelease:
                !role.isSubject &&
                role.canWrite &&
                (role.isManager || role.isHr) &&
                s.round.status === 'closed' &&
                s.round.releaseMode === 'manager' &&
                !s.releasedAt,
            reportReady: s.round.status === 'closed',
            reportVisible: await this._canReadReport(role, s),
        };
    }

    async _canReadReport(role, s) {
        if (s.round.status !== 'closed') return false;
        if (role.isSubject) return s.round.releaseMode === 'on_close' || Boolean(s.releasedAt);
        return role.isManager || role.isHr;
    }

    /** Everything on the person's 360 home: as subject, as rater, to approve. */
    async home(user) {
        const personId = await GovernanceService.actingPersonId(user);
        const out = { asSubject: [], toAnswer: [], toApprove: [], personId };
        if (personId == null) return out;
        const mine = await db.all(
            `${SUBJECT_SQL} WHERE s.employee_id = ? ORDER BY r.created_at DESC`,
            [personId]
        );
        out.asSubject = mine.map(mapSubject).map((s) => ({
            ...s,
            reportVisible:
                s.round.status === 'closed' &&
                (s.round.releaseMode === 'on_close' || Boolean(s.releasedAt)),
        }));
        const toAnswer = await db.all(
            `SELECT n.id, n.rater_group, s.id AS subject_id, r.title, r.deadline,
                    e.first_name, e.last_name
               FROM feedback360_nominations n
               JOIN feedback360_subjects s ON s.id = n.subject_id
               JOIN feedback360_rounds r ON r.id = s.round_id
               JOIN employees e ON e.id = s.employee_id
              WHERE n.rater_employee_id = ? AND n.status = 'approved' AND n.responded = false
                AND s.status = 'collecting' AND r.status = 'open'
              ORDER BY r.deadline, n.id`,
            [personId]
        );
        out.toAnswer = toAnswer.map((r) => ({
            nominationId: Number(r.id),
            group: r.raterGroup,
            subjectName: r.raterGroup === 'self' ? null : fullName(r),
            title: r.title,
            deadline: r.deadline,
        }));
        const toApprove = await db.all(
            `${SUBJECT_SQL} WHERE s.manager_employee_id = ? AND s.status = 'awaiting_approval'
                             AND r.status = 'open' ORDER BY r.deadline, s.id`,
            [personId]
        );
        out.toApprove = toApprove.map(mapSubject);
        return out;
    }

    /** Counts for the "To do" list (/api/my-actions). Never throws. */
    async pendingCounts(user) {
        try {
            const personId = await GovernanceService.actingPersonId(user);
            if (personId == null) return { answer: 0, nominate: 0, approve: 0 };
            // One parameter, the person's own id (the to-do list is keyed on it alone).
            const row = await db.get(
                `WITH me AS (SELECT ?::bigint AS id)
                 SELECT
                   (SELECT COUNT(*) FROM feedback360_nominations n
                      JOIN feedback360_subjects s ON s.id = n.subject_id
                      JOIN feedback360_rounds r ON r.id = s.round_id
                     WHERE n.rater_employee_id = (SELECT id FROM me) AND n.status = 'approved'
                       AND n.responded = false AND s.status = 'collecting' AND r.status = 'open')::int AS answer,
                   (SELECT COUNT(*) FROM feedback360_subjects s
                      JOIN feedback360_rounds r ON r.id = s.round_id
                     WHERE s.employee_id = (SELECT id FROM me) AND s.status = 'nominating'
                       AND r.status = 'open')::int AS nominate,
                   (SELECT COUNT(*) FROM feedback360_subjects s
                      JOIN feedback360_rounds r ON r.id = s.round_id
                     WHERE s.manager_employee_id = (SELECT id FROM me) AND s.status = 'awaiting_approval'
                       AND r.status = 'open')::int AS approve`,
                [personId]
            );
            return {
                answer: Number((row && row.answer) || 0),
                nominate: Number((row && row.nominate) || 0),
                approve: Number((row && row.approve) || 0),
            };
        } catch (_) {
            return { answer: 0, nominate: 0, approve: 0 };
        }
    }

    /** Rounds the console lists: HR scope, the line, or launched by the user. */
    async consoleRounds(user) {
        const personId = await GovernanceService.actingPersonId(user);
        const params = [];
        const or = [];
        if (RBACService.isSuperAdmin(user)) {
            or.push('true');
        } else {
            const visible = new Set();
            if (user.userType === 'admin') {
                const scoped = await RBACService.getFilteredEmployees(user);
                for (const e of scoped || []) visible.add(Number(e.id));
            }
            for (const id of await GovernanceService.lineAuthorityEmployeeIds(user))
                visible.add(Number(id));
            if (personId != null) visible.delete(Number(personId));
            if (visible.size) {
                or.push('s.employee_id = ANY(?)');
                params.push([...visible]);
            }
            if (personId != null) {
                or.push('s.manager_employee_id = ?');
                params.push(personId);
            }
            or.push('(r.created_by_type = ? AND r.created_by_id = ?)');
            params.push(actorType(user), Number(user.id));
        }
        // A subject never sees their own round in the console (only on "My 360").
        const selfClause = personId != null ? ' AND s.employee_id <> ?' : '';
        if (personId != null) params.push(personId);
        const rows = await db.all(
            `SELECT r.id, r.title, r.kind, r.status, r.deadline, r.release_mode, r.created_at,
                    COUNT(DISTINCT s.id)::int AS subjects,
                    COUNT(n.id) FILTER (WHERE n.status = 'approved')::int AS raters,
                    COUNT(n.id) FILTER (WHERE n.status = 'approved' AND n.responded)::int AS responded
               FROM feedback360_rounds r
               JOIN feedback360_subjects s ON s.round_id = r.id
               LEFT JOIN feedback360_nominations n ON n.subject_id = s.id
              WHERE (${or.join(' OR ')})${selfClause}
              GROUP BY r.id
              ORDER BY (r.status = 'open') DESC, r.deadline DESC, r.id DESC
              LIMIT 200`,
            params
        );
        return rows.map((r) => ({
            id: Number(r.id),
            title: r.title,
            kind: r.kind,
            status: r.status,
            deadline: r.deadline,
            releaseMode: r.releaseMode,
            subjects: Number(r.subjects),
            raters: Number(r.raters),
            responded: Number(r.responded),
        }));
    }

    /**
     * One round for the console: its subjects the user may manage, with the
     * response status per rater (who, not what).
     */
    async roundView(user, roundId) {
        const rid = toInt(roundId, 0);
        if (!rid) throw notFound();
        const rows = await db.all(
            `${SUBJECT_SQL} WHERE s.round_id = ? ORDER BY e.last_name, e.first_name, s.id`,
            [rid]
        );
        if (!rows.length) throw notFound();
        const subjects = [];
        let canClose = false;
        for (const row of rows) {
            const s = mapSubject(row);
            const role = await this.roleFor(user, s);
            if (role.isSubject || !(role.isManager || role.isHr || role.isLauncher)) continue;
            const view = await this.subjectView(user, s.id);
            if ((role.isHr || role.isLauncher) && role.canWrite) canClose = true;
            subjects.push(view);
        }
        if (!subjects.length) throw notFound();
        const round = subjects[0].subject.round;
        return { round, subjects, canClose: canClose && round.status === 'open' };
    }

    // ------------------------------------------------------------------
    // Nominations
    // ------------------------------------------------------------------

    async _validateRaters(s, list, { allowManager = false } = {}) {
        const out = [];
        const seen = new Set();
        for (const item of list) {
            const id = toInt(item && item.employeeId, 0);
            const group = String((item && item.group) || '');
            if (!id || !C.NOMINABLE_GROUPS.includes(group))
                throw refuse(400, 'f360_bad_nomination');
            if (id === s.employeeId) throw refuse(400, 'f360_cannot_nominate_self');
            if (!allowManager && s.managerEmployeeId != null && id === s.managerEmployeeId)
                throw refuse(400, 'f360_manager_already_rater');
            if (seen.has(id)) throw refuse(400, 'f360_duplicate_rater');
            seen.add(id);
            out.push({ employeeId: id, group });
        }
        if (out.length > MAX_NOMINATIONS) throw refuse(400, 'f360_too_many_raters');
        if (out.length) {
            const live = await db.all(
                `SELECT id, supervisor_id, manager_id, manager_type FROM employees
                  WHERE id = ANY(?) AND is_active = true AND cancelled_at IS NULL`,
                [out.map((o) => o.employeeId)]
            );
            if (live.length !== out.length) throw refuse(400, 'f360_rater_inactive');
            const byId = new Map(live.map((r) => [Number(r.id), r]));
            for (const o of out) {
                if (o.group !== 'direct_report') continue;
                const r = byId.get(o.employeeId);
                const reports =
                    Number(r.supervisorId) === s.employeeId ||
                    (r.managerType === 'employee' && Number(r.managerId) === s.employeeId);
                if (!reports) throw refuse(400, 'f360_not_a_direct_report');
            }
        }
        return out;
    }

    /**
     * The subject proposes their raters (replacing their earlier proposals), and
     * optionally submits them for approval.
     */
    async nominate(user, subjectId, { raters = [], submit = false } = {}) {
        const { s, role } = await this._subjectFor(user, subjectId);
        if (!role.isSubject) throw refuse(403, 'f360_forbidden');
        if (s.status !== 'nominating' || s.round.status !== 'open')
            throw refuse(409, 'f360_nominations_closed');
        const list = await this._validateRaters(s, Array.isArray(raters) ? raters : []);
        if (submit) {
            const anon = list.length;
            if (anon < s.round.minRaters) throw refuse(400, 'f360_not_enough_raters');
        }
        await db.runTransaction(async () => {
            await db.run(
                `DELETE FROM feedback360_nominations WHERE subject_id = ? AND proposed_by = 'subject' AND status = 'proposed'`,
                [s.id]
            );
            for (const o of list) {
                await db.run(
                    `INSERT INTO feedback360_nominations (subject_id, rater_employee_id, rater_group, status, proposed_by)
                     VALUES (?, ?, ?, 'proposed', 'subject')
                     ON CONFLICT (subject_id, rater_employee_id) DO NOTHING`,
                    [s.id, o.employeeId, o.group]
                );
            }
            if (submit) {
                await db.run(
                    `UPDATE feedback360_subjects SET status = 'awaiting_approval', nominated_at = now() WHERE id = ?`,
                    [s.id]
                );
            }
        });
        if (submit && s.managerEmployeeId) {
            await notify(s.managerEmployeeId, 'feedback360.approve', {
                link: `/feedback-360/subjects/${s.id}`,
            });
        }
        return { saved: list.length, submitted: Boolean(submit) };
    }

    /**
     * Manager / HR / launcher: decide the proposals, add raters, and start
     * collecting. Every newly approved rater is notified.
     */
    async approve(user, subjectId, { decisions = [], additions = [] } = {}) {
        const { s, role } = await this._subjectFor(user, subjectId);
        if (role.isSubject || !role.canWrite || !(role.isManager || role.isHr || role.isLauncher))
            throw refuse(403, 'f360_forbidden');
        if (
            !['nominating', 'awaiting_approval', 'collecting'].includes(s.status) ||
            s.round.status !== 'open'
        )
            throw refuse(409, 'f360_nominations_closed');
        const adds = await this._validateRaters(s, Array.isArray(additions) ? additions : []);
        const invited = [];
        await db.runTransaction(async () => {
            for (const d of Array.isArray(decisions) ? decisions : []) {
                const nid = toInt(d && d.nominationId, 0);
                const status = d && d.status === 'declined' ? 'declined' : 'approved';
                if (!nid) continue;
                // Self and manager are fixed raters: never declined.
                await db.run(
                    `UPDATE feedback360_nominations SET status = ?
                      WHERE id = ? AND subject_id = ? AND rater_group NOT IN ('self','manager')
                        AND responded = false`,
                    [status, nid, s.id]
                );
            }
            for (const o of adds) {
                await db.run(
                    `INSERT INTO feedback360_nominations (subject_id, rater_employee_id, rater_group, status, proposed_by)
                     VALUES (?, ?, ?, 'approved', 'manager')
                     ON CONFLICT (subject_id, rater_employee_id)
                     DO UPDATE SET status = 'approved', rater_group = EXCLUDED.rater_group
                     WHERE feedback360_nominations.responded = false`,
                    [s.id, o.employeeId, o.group]
                );
            }
            // Anything still merely proposed is approved by this decision.
            await db.run(
                `UPDATE feedback360_nominations SET status = 'approved' WHERE subject_id = ? AND status = 'proposed'`,
                [s.id]
            );
            await db.run(
                `UPDATE feedback360_subjects
                    SET status = 'collecting',
                        approved_at = COALESCE(approved_at, now()),
                        approved_by_type = COALESCE(approved_by_type, ?),
                        approved_by_id = COALESCE(approved_by_id, ?)
                  WHERE id = ?`,
                [actorType(user), Number(user.id), s.id]
            );
            const fresh = await db.all(
                `UPDATE feedback360_nominations SET invited_at = now()
                  WHERE subject_id = ? AND status = 'approved' AND invited_at IS NULL
                  RETURNING id, rater_employee_id`,
                [s.id]
            );
            for (const f of fresh)
                invited.push({ id: Number(f.id), raterId: Number(f.raterEmployeeId) });
        });
        for (const i of invited) {
            await notify(i.raterId, 'feedback360.invited', {
                link: `/feedback-360/answer/${i.id}`,
                deadline: s.round.deadline,
            });
        }
        await this._audit(user, 'F360_NOMINATIONS_APPROVED', s.roundId, {
            subjectId: s.id,
            invited: invited.length,
        });
        return { invited: invited.length };
    }

    // ------------------------------------------------------------------
    // Answering
    // ------------------------------------------------------------------

    async _nominationFor(user, nominationId) {
        const nid = toInt(nominationId, 0);
        if (!nid) throw notFound();
        const personId = await GovernanceService.actingPersonId(user);
        const n = await db.get(
            `SELECT n.id, n.subject_id, n.rater_employee_id, n.rater_group, n.status, n.responded
               FROM feedback360_nominations n WHERE n.id = ?`,
            [nid]
        );
        // Somebody else's nomination does not exist for this user.
        if (!n || personId == null || Number(n.raterEmployeeId) !== Number(personId))
            throw notFound();
        if (n.status !== 'approved') throw notFound();
        const s = await this._subject(n.subjectId);
        if (!s) throw notFound();
        return { n, s };
    }

    /** The questionnaire a rater fills in, in the reader's language. */
    async questionnaire(user, nominationId, locale) {
        const { n, s } = await this._nominationFor(user, nominationId);
        const L = lang(locale);
        return {
            nominationId: Number(n.id),
            group: n.raterGroup,
            responded: n.responded === true,
            open: s.status === 'collecting' && s.round.status === 'open',
            subjectName: n.raterGroup === 'self' ? null : s.name,
            round: { title: s.round.title, deadline: s.round.deadline },
            skills: s.skills.map((k) => ({ key: String(k.skillId), label: k.name })),
            behaviours: s.round.behaviours.map((b) => ({
                key: b.key,
                label: b[L] || b.fr || b.en,
            })),
            comments: C.COMMENT_KINDS,
        };
    }

    /**
     * Record one questionnaire. `ratings` maps 'skill:<id>' / 'behaviour:<key>'
     * to '0'..'4' or 'na' (not observed; also what a missing answer means).
     * Written with NO rater id and NO timestamp; the nomination only learns that
     * it has been answered — in the same transaction, so neither can exist
     * without the other.
     */
    async submitResponse(user, nominationId, { ratings = {}, comments = {} } = {}) {
        const { n, s } = await this._nominationFor(user, nominationId);
        if (s.status !== 'collecting' || s.round.status !== 'open')
            throw refuse(409, 'f360_round_closed');
        const answers = [];
        const r = ratings && typeof ratings === 'object' ? ratings : {};
        for (const k of s.skills) {
            const v = r[`skill:${k.skillId}`];
            if (v !== undefined && v !== 'na' && v !== '' && Report.ratingOf(v) === null)
                throw refuse(400, 'f360_bad_rating');
            answers.push({
                type: 'skill',
                key: String(k.skillId),
                rating: Report.ratingOf(v),
                body: null,
            });
        }
        for (const b of s.round.behaviours) {
            const v = r[`behaviour:${b.key}`];
            if (v !== undefined && v !== 'na' && v !== '' && Report.ratingOf(v) === null)
                throw refuse(400, 'f360_bad_rating');
            answers.push({ type: 'behaviour', key: b.key, rating: Report.ratingOf(v), body: null });
        }
        const cm = comments && typeof comments === 'object' ? comments : {};
        for (const k of C.COMMENT_KINDS) {
            const body = typeof cm[k] === 'string' ? cm[k].trim() : '';
            if (body.length > C.COMMENT_MAX) throw refuse(400, 'f360_comment_too_long');
            if (body) answers.push({ type: 'comment', key: k, rating: null, body });
        }
        await db.runTransaction(async () => {
            const locked = await db.get(
                `SELECT responded FROM feedback360_nominations WHERE id = ? FOR UPDATE`,
                [n.id]
            );
            if (!locked || locked.responded === true) throw refuse(409, 'f360_already_answered');
            const resp = await db.get(
                `INSERT INTO feedback360_responses (subject_id, rater_group) VALUES (?, ?) RETURNING id`,
                [s.id, n.raterGroup]
            );
            for (const a of answers) {
                await db.run(
                    `INSERT INTO feedback360_answers (response_id, item_type, item_key, rating, body)
                     VALUES (?::uuid, ?, ?, ?, ?)`,
                    [resp.id, a.type, a.key, a.rating, a.body]
                );
            }
            await db.run(`UPDATE feedback360_nominations SET responded = true WHERE id = ?`, [
                n.id,
            ]);
        });
        return { ok: true };
    }

    // ------------------------------------------------------------------
    // Close, release, remind
    // ------------------------------------------------------------------

    /**
     * Close a round: by its launcher or HR within scope (or `system` at the
     * deadline). Subjects become 'closed'; with release_mode 'on_close' they
     * are released at once, otherwise their manager is told to release.
     */
    async closeRound(user, roundId, { system = false } = {}) {
        const rid = toInt(roundId, 0);
        const round = rid
            ? await db.get(
                  `SELECT id, status, release_mode, created_by_type, created_by_id FROM feedback360_rounds WHERE id = ?`,
                  [rid]
              )
            : null;
        if (!round) throw notFound();
        if (!system) {
            const view = await this.roundView(user, rid); // 404 for a stranger
            if (!view.canClose && round.status === 'open') throw refuse(403, 'f360_forbidden');
        }
        if (round.status !== 'open') throw refuse(409, 'f360_round_closed');
        const onClose = round.releaseMode === 'on_close';
        const subjects = await db.runTransaction(async () => {
            await db.run(
                `UPDATE feedback360_rounds SET status = 'closed', closed_at = now(), closed_by_type = ?, closed_by_id = ?
                  WHERE id = ? AND status = 'open'`,
                [system ? 'system' : actorType(user), system ? null : Number(user.id), rid]
            );
            return db.all(
                `UPDATE feedback360_subjects
                    SET status = 'closed'${onClose ? ', released_at = COALESCE(released_at, now())' : ''}
                  WHERE round_id = ? RETURNING id, employee_id, manager_employee_id`,
                [rid]
            );
        });
        for (const s of subjects) {
            const link = `/feedback-360/subjects/${Number(s.id)}/report`;
            if (onClose) await notify(s.employeeId, 'feedback360.released', { link });
            else if (s.managerEmployeeId)
                await notify(s.managerEmployeeId, 'feedback360.closed', { link });
        }
        if (!system)
            await this._audit(user, 'F360_ROUND_CLOSED', rid, { subjects: subjects.length });
        return { closed: subjects.length };
    }

    /** Manager / HR: let the subject read their report. */
    async release(user, subjectId) {
        const { s, role } = await this._subjectFor(user, subjectId);
        if (role.isSubject || !role.canWrite || !(role.isManager || role.isHr))
            throw refuse(403, 'f360_forbidden');
        if (s.round.status !== 'closed') throw refuse(409, 'f360_round_open');
        if (s.releasedAt) return { released: false };
        await db.run(
            `UPDATE feedback360_subjects SET released_at = now(), released_by_type = ?, released_by_id = ?
              WHERE id = ? AND released_at IS NULL`,
            [actorType(user), Number(user.id), s.id]
        );
        await notify(s.employeeId, 'feedback360.released', {
            link: `/feedback-360/subjects/${s.id}/report`,
        });
        await this._audit(user, 'F360_REPORT_RELEASED', s.roundId, { subjectId: s.id });
        return { released: true };
    }

    /** Remind the raters who have not answered yet (one round, or all by the tick). */
    async remindNonResponders(roundId, { force = false } = {}) {
        const rows = await db.all(
            `SELECT n.id, n.rater_employee_id, r.deadline
               FROM feedback360_nominations n
               JOIN feedback360_subjects s ON s.id = n.subject_id
               JOIN feedback360_rounds r ON r.id = s.round_id
              WHERE r.id = ? AND r.status = 'open' AND s.status = 'collecting'
                AND n.status = 'approved' AND n.responded = false
                AND (? OR (n.last_reminded_at IS NULL AND n.invited_at < now() - interval '3 days')
                        OR n.last_reminded_at < now() - interval '6 days')`,
            [toInt(roundId, 0), Boolean(force)]
        );
        for (const r of rows) {
            await db.run(
                `UPDATE feedback360_nominations SET last_reminded_at = now() WHERE id = ?`,
                [r.id]
            );
            await notify(r.raterEmployeeId, 'feedback360.reminder', {
                link: `/feedback-360/answer/${Number(r.id)}`,
                deadline: r.deadline,
            });
        }
        return { reminded: rows.length };
    }

    /** Console "remind now": the round's launcher, manager or HR only. */
    async remind(user, roundId) {
        const view = await this.roundView(user, roundId); // 404 for a stranger
        if (!view.subjects.some((v) => v.role.canWrite)) throw refuse(403, 'f360_forbidden');
        const out = await this.remindNonResponders(view.round.id, { force: true });
        await this._audit(user, 'F360_REMINDED', view.round.id, out);
        return out;
    }

    // ------------------------------------------------------------------
    // Report
    // ------------------------------------------------------------------

    /**
     * The report. Refuses a stranger (404) and a subject whose report is not
     * released yet (403). The JSON carries no rater identity.
     */
    async report(user, subjectId, locale) {
        const { s, role } = await this._subjectFor(user, subjectId);
        if (s.round.status !== 'closed') throw refuse(403, 'f360_report_not_ready');
        if (!(await this._canReadReport(role, s))) {
            throw refuse(
                role.isSubject ? 403 : 404,
                role.isSubject ? 'f360_report_not_released' : 'f360_not_found'
            );
        }
        const L = lang(locale);
        const rows = await db.all(
            `SELECT r.id, r.rater_group, a.item_type, a.item_key, a.rating, a.body
               FROM feedback360_responses r
               LEFT JOIN feedback360_answers a ON a.response_id = r.id
              WHERE r.subject_id = ?`,
            [s.id]
        );
        const byResp = new Map();
        for (const row of rows) {
            if (!byResp.has(row.id)) byResp.set(row.id, { group: row.raterGroup, answers: [] });
            if (row.itemType)
                byResp.get(row.id).answers.push({
                    itemType: row.itemType,
                    itemKey: row.itemKey,
                    rating: row.rating,
                    body: row.body,
                });
        }
        const items = [
            ...s.skills.map((k) => ({
                type: 'skill',
                key: String(k.skillId),
                label: k.name,
                required: k.required,
            })),
            ...s.round.behaviours.map((b) => ({
                type: 'behaviour',
                key: b.key,
                label: b[L] || b.fr || b.en,
            })),
        ];
        const built = Report.buildReport({
            items,
            responses: [...byResp.values()],
            threshold: s.round.threshold,
        });
        return {
            subject: { id: s.id, name: s.name, managerName: s.managerName },
            round: {
                id: s.round.id,
                title: s.round.title,
                deadline: s.round.deadline,
                closedAt: s.round.closedAt,
                releaseMode: s.round.releaseMode,
            },
            released: Boolean(s.releasedAt) || s.round.releaseMode === 'on_close',
            viewer: { isSubject: role.isSubject },
            ...built,
        };
    }

    /**
     * "Add to my development plan": the subject turns chosen skills of their
     * released report into IDP objectives (IDPService).
     */
    async addToIdp(user, subjectId, skillIds, locale) {
        const report = await this.report(user, subjectId, locale);
        if (!report.viewer.isSubject) throw refuse(403, 'f360_forbidden');
        const wanted = new Set(
            (Array.isArray(skillIds) ? skillIds : [skillIds])
                .map((v) => toInt(v, 0))
                .filter(Boolean)
        );
        const items = report.skills
            .filter((k) => wanted.has(k.skillId))
            .map((k) => ({ skillId: k.skillId, skillName: k.label, required: k.required }));
        if (!items.length) throw refuse(400, 'f360_nothing_to_add');
        const personId = await GovernanceService.actingPersonId(user);
        const IDPService = require('./IDPService');
        return IDPService.addObjectivesFromFeedback({ employeeId: personId, items, locale, user });
    }

    /** People a subject (or approver) may pick as raters: active colleagues. */
    async searchPeople(user, q) {
        const personId = await GovernanceService.actingPersonId(user);
        if (personId == null && user.userType !== 'admin') return [];
        const term = String(q || '')
            .trim()
            .slice(0, 60);
        if (term.length < 2) return [];
        const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
        const rows = await db.all(
            `SELECT id, first_name, last_name FROM employees
              WHERE is_active = true AND cancelled_at IS NULL
                AND (first_name || ' ' || last_name ILIKE ? OR last_name ILIKE ?)
              ORDER BY last_name, first_name, id LIMIT 20`,
            [like, like]
        );
        return rows.map((r) => ({ id: Number(r.id), name: fullName(r) }));
    }

    // ------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------

    /** Close rounds past their deadline, and remind non-responders weekly. */
    async tick() {
        const out = { closed: 0, reminded: 0 };
        const due = await db.all(
            `SELECT id FROM feedback360_rounds WHERE status = 'open' AND deadline < CURRENT_DATE`
        );
        for (const r of due) {
            try {
                const c = await this.closeRound(null, r.id, { system: true });
                out.closed += c.closed ? 1 : 0;
            } catch (_) {
                /* one round never blocks the others */
            }
        }
        const open = await db.all(`SELECT id FROM feedback360_rounds WHERE status = 'open'`);
        for (const r of open) {
            try {
                out.reminded += (await this.remindNonResponders(r.id)).reminded;
            } catch (_) {
                /* idem */
            }
        }
        return out;
    }

    async _audit(user, action, roundId, details) {
        try {
            await require('./LogService').log({
                category: 'audit',
                action,
                entityType: 'feedback360_round',
                entityId: Number(roundId),
                adminId: user && user.userType === 'admin' ? Number(user.id) : null,
                actorRef:
                    user && user.userType !== 'admin' && user.id != null
                        ? `${user.userType}:${user.id}`
                        : null,
                details,
            });
        } catch (_) {
            /* audit best-effort */
        }
    }
}

module.exports = new Feedback360Service();
module.exports.refuse = refuse;
