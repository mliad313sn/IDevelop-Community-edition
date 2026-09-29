'use strict';
/**
 * IDevelop — Wave 1 read repositories (API-first seam).
 *
 * A thin, documented data-access layer for the versioned JSON API. It is the
 * strangler-fig foundation for retiring ad-hoc query code: API handlers depend
 * on these repositories, not on inline SQL. Reads are RBAC-scoped where the
 * resource is people-bound. All queries are parameterised.
 *
 * @module api/v1/repository
 */
const db = require('../../config/database');
const RBACService = require('../../services/RBACService');
const NineBoxService = require('../../services/NineBoxService');

const clampLimit = (n, def = 200, max = 1000) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) && v > 0 ? Math.min(v, max) : def;
};
const clampOffset = (n) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
};

// PostgreSQL BIGINT comes back as a string and SMALLINT booleans as 0/1 through
// the driver. Coerce to real JSON types so responses match the OpenAPI schema.
const int = (v) => (v == null ? null : Number(v));
const num = (v) => (v == null ? null : Number(v));
const bool = (v) => (v == null ? null : Number(v) === 1 || v === true);

/**
 * Merged duplicate skills are SOFT-retired (`skills.is_active = false`) so old
 * assessments stay readable. This feed published them anyway and did not expose the
 * flag, so a Power BI model received 1 142 skills where the JSON export publishes
 * 1 126, joined to 55 domains of which 49 are inactive: a "skills in the framework"
 * measure was simply wrong, and a LOOKUP by name landed on a retired twin with no
 * way for the consumer to tell. The API contradicted the export.
 *
 * Active-only is now the default (matching the export). `?includeInactive=true`
 * returns the retired rows for anyone who needs history, and every row carries
 * `isActive` either way, so a consumer is never guessing.
 */
const SkillsRepository = {
    /** @returns {Promise<Array<{id,name,category,domainId,domainName,isActive}>>} */
    async list({ limit, offset, includeInactive = false } = {}) {
        const where = includeInactive ? '' : ' WHERE s.is_active = true';
        const rows = await db.all(
            `SELECT s.id, s.name, s.category, s.domain_id AS domainId, d.name AS domainName,
                    s.is_active AS isActive
               FROM skills s
               LEFT JOIN domains d ON d.id = s.domain_id${where}
              ORDER BY s.name
              LIMIT ? OFFSET ?`,
            [clampLimit(limit), clampOffset(offset)]
        );
        return rows.map((r) => ({
            id: int(r.id),
            name: r.name,
            category: r.category,
            domainId: int(r.domainId),
            domainName: r.domainName,
            isActive: bool(r.isActive),
        }));
    },
    // Must apply the SAME predicate as list, or the pagination envelope reports a
    // total that does not match what the pages contain.
    async count({ includeInactive = false } = {}) {
        const r = await db.get(
            `SELECT COUNT(*) AS total FROM skills s${includeInactive ? '' : ' WHERE s.is_active = true'}`
        );
        return Number(r && r.total) || 0;
    },
};

const ReadinessRepository = {
    /**
     * RBAC-scoped list of per-employee role readiness.
     *
     * ONE NUMBER (Wave 2): `readinessPercent` is
     * v_employee_assessment_coverage.readiness_assessed_only — the identical
     * figure the dashboard, the Report Builder and the departmental digest
     * publish. It used to be v_employee_readiness.readiness, which counts a
     * never-rated requirement as a scored 0, so Power BI reported a different
     * number from the dashboard for the same person on the same day.
     *
     * The coverage denominators (assessedSkills / expectedSkills /
     * coveragePercent / assessmentStatus) are ALWAYS emitted alongside — a
     * consumer must be able to tell "62 % of everything" from "62 % of the 14
     * requirements out of 96 that anyone has actually assessed". The
     * all-requirements figure stays available under the distinct name
     * `readinessAllRequirementsPercent`; it is never silently swapped in.
     * @param {object} user req.user
     */
    async list(user, { limit, offset } = {}) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const rows = await db.all(
            `SELECT ${ReadinessRepository.READINESS_COLS}
               FROM v_employee_readiness v
               JOIN employees e ON e.id = v.employee_id
               LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = v.employee_id
              WHERE 1=1 ${sc.clause}
              ORDER BY v.full_name
              LIMIT ? OFFSET ?`,
            [...sc.params, clampLimit(limit), clampOffset(offset)]
        );
        return rows.map(this._mapReadiness);
    },

    /** Canonical readiness projection — one definition, used by every read below. */
    READINESS_COLS: `v.employee_id   AS employeeId,
                    v.full_name     AS employeeName,
                    v.site_name     AS siteName,
                    v.department_name AS departmentName,
                    v.role_name     AS roleName,
                    c.readiness_assessed_only AS readinessPercent,
                    v.readiness     AS readinessAllRequirementsPercent,
                    v.is_role_ready AS isReady,
                    v.total_required AS totalRequired,
                    v.skills_met    AS skillsMet,
                    COALESCE(c.assessed_skills, 0)       AS assessedSkills,
                    COALESCE(c.expected_skills, 0)       AS expectedSkills,
                    COALESCE(c.never_assessed_skills, 0) AS neverAssessedSkills,
                    c.coverage      AS coveragePercent,
                    CASE WHEN COALESCE(c.assessed_skills, 0) = 0 THEN 'never_assessed'
                         WHEN COALESCE(c.validated_skills, 0) = 0 THEN 'self_only'
                         ELSE 'assessed' END AS assessmentStatus`,

    async count(user) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const r = await db.get(
            `SELECT COUNT(*) AS total FROM v_employee_readiness v
               JOIN employees e ON e.id = v.employee_id WHERE 1=1 ${sc.clause}`,
            [...sc.params]
        );
        return Number(r && r.total) || 0;
    },

    /** Readiness for a single employee (caller must already be RBAC-authorised). */
    async forEmployee(employeeId) {
        const r = await db.get(
            `SELECT ${ReadinessRepository.READINESS_COLS},
                    v.total_critical AS criticalTotal,
                    v.critical_met  AS criticalMet
               FROM v_employee_readiness v
               LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = v.employee_id
              WHERE v.employee_id = ?`,
            [employeeId]
        );
        if (!r) return null;
        return {
            ...ReadinessRepository._mapReadiness(r),
            criticalTotal: int(r.criticalTotal),
            criticalMet: int(r.criticalMet),
        };
    },

    _mapReadiness(r) {
        return {
            employeeId: int(r.employeeId),
            employeeName: r.employeeName,
            siteName: r.siteName,
            departmentName: r.departmentName,
            roleName: r.roleName,
            // The canonical number. null — never 0 — when nothing was assessed.
            readinessPercent: num(r.readinessPercent),
            isReady: bool(r.isReady),
            totalRequired: int(r.totalRequired),
            skillsMet: int(r.skillsMet),
            // Coverage always travels with the score.
            assessedSkills: int(r.assessedSkills),
            expectedSkills: int(r.expectedSkills),
            neverAssessedSkills: int(r.neverAssessedSkills),
            coveragePercent: num(r.coveragePercent),
            assessmentStatus: r.assessmentStatus,
            // Distinct label — the all-requirements figure, never a stand-in.
            readinessAllRequirementsPercent: num(r.readinessAllRequirementsPercent),
        };
    },
};

const EmployeesRepository = {
    /** RBAC-scoped employee directory. */
    async list(user, { limit, offset } = {}) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const rows = await db.all(
            `SELECT e.id, e.employee_number AS employeeNumber,
                    e.first_name AS firstName, e.last_name AS lastName,
                    r.name AS roleName, s.name AS siteName, d.name AS departmentName,
                    e.is_active AS isActive
               FROM employees e
               LEFT JOIN roles r ON r.id = e.role_id
               LEFT JOIN sites s ON s.id = e.site_id
               LEFT JOIN departments d ON d.id = e.department_id
              WHERE 1=1 ${sc.clause}
              ORDER BY e.last_name, e.first_name
              LIMIT ? OFFSET ?`,
            [...sc.params, clampLimit(limit), clampOffset(offset)]
        );
        return rows.map((r) => ({
            id: int(r.id),
            employeeNumber: r.employeeNumber,
            firstName: r.firstName,
            lastName: r.lastName,
            roleName: r.roleName,
            siteName: r.siteName,
            departmentName: r.departmentName,
            isActive: bool(r.isActive),
        }));
    },
    async count(user) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const r = await db.get(`SELECT COUNT(*) AS total FROM employees e WHERE 1=1 ${sc.clause}`, [
            ...sc.params,
        ]);
        return Number(r && r.total) || 0;
    },
};

const TalentRepository = {
    /** Latest APPROVED 9-box placement per employee, RBAC-scoped. */
    async nineBox(user, { limit, offset } = {}) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const rows = await db.all(
            `SELECT DISTINCT ON (nb.employee_id)
                    nb.employee_id AS employeeId,
                    e.first_name AS firstName, e.last_name AS lastName,
                    nb.performance, nb.potential,
                    COALESCE(nb.approved_at, nb.updated_at, nb.created_at) AS placedAt
               FROM nine_box_evaluations nb
               JOIN employees e ON e.id = nb.employee_id
              WHERE nb.status = 'approved' ${sc.clause}
              ORDER BY nb.employee_id, COALESCE(nb.approved_at, nb.updated_at, nb.created_at) DESC
              LIMIT ? OFFSET ?`,
            [...sc.params, clampLimit(limit), clampOffset(offset)]
        );
        return rows.map((r) => {
            let box = null;
            let label = null;
            try {
                const b = NineBoxService.computeBox(r.performance, r.potential);
                box = b.box;
                label = b.label;
            } catch (_) {
                /* invalid bands */
            }
            return {
                employeeId: int(r.employeeId),
                employeeName: `${r.firstName || ''} ${r.lastName || ''}`.trim(),
                performance: r.performance,
                potential: r.potential,
                box,
                label,
                placedAt: r.placedAt,
            };
        });
    },
    async nineBoxCount(user) {
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        // DISTINCT employees with an approved placement — matches the DISTINCT ON list.
        const r = await db.get(
            `SELECT COUNT(DISTINCT nb.employee_id) AS total
               FROM nine_box_evaluations nb JOIN employees e ON e.id = nb.employee_id
              WHERE nb.status = 'approved' ${sc.clause}`,
            [...sc.params]
        );
        return Number(r && r.total) || 0;
    },
};

const DevelopmentRepository = {
    /** Coaching/mentoring + IDP (with objective/action counts) + PIP for one employee. */
    async forEmployee(employeeId) {
        const coaching = await db.all(
            `SELECT id, kind, title, state, COALESCE(progress,0) AS progress,
                    context_type AS contextType, target_date AS targetDate, created_at AS createdAt
               FROM coaching_plans WHERE employee_id = ? ORDER BY created_at DESC`,
            [employeeId]
        );
        const idps = await db.all(
            `SELECT i.id, i.status, i.priority, i.created_at AS createdAt,
                    (SELECT COUNT(*) FROM idp_objectives o WHERE o.idp_id = i.id) AS objTotal,
                    (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = i.id) AS actTotal,
                    (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = i.id AND a.status = 'completed') AS actDone
               FROM idp_plans i WHERE i.employee_id = ? ORDER BY i.created_at DESC`,
            [employeeId]
        );
        const pips = await db.all(
            `SELECT id, state, summary, outcome, created_at AS createdAt
               FROM pips WHERE employee_id = ? ORDER BY created_at DESC`,
            [employeeId]
        );
        return {
            coaching: coaching.map((c) => ({
                id: int(c.id),
                kind: c.kind,
                title: c.title,
                state: c.state,
                progress: int(c.progress),
                contextType: c.contextType,
                targetDate: c.targetDate,
                createdAt: c.createdAt,
            })),
            idps: idps.map((i) => ({
                id: int(i.id),
                status: i.status,
                priority: i.priority,
                createdAt: i.createdAt,
                objectives: int(i.objTotal),
                actions: int(i.actTotal),
                actionsCompleted: int(i.actDone),
            })),
            pips: pips.map((p) => ({
                id: int(p.id),
                state: p.state,
                summary: p.summary,
                outcome: p.outcome,
                createdAt: p.createdAt,
            })),
        };
    },
};

const GOAL_COLS = `id, employee_id AS employeeId, parent_id AS parentId, kind, title, description,
    metric_unit AS metricUnit, target_value AS targetValue, current_value AS currentValue,
    status, period, due_date AS dueDate, created_at AS createdAt`;

function mapGoal(r) {
    if (!r) return null;
    return {
        id: int(r.id),
        employeeId: int(r.employeeId),
        parentId: r.parentId != null ? int(r.parentId) : null,
        kind: r.kind,
        title: r.title,
        description: r.description,
        metricUnit: r.metricUnit,
        targetValue: r.targetValue != null ? num(r.targetValue) : null,
        currentValue: num(r.currentValue),
        status: r.status,
        period: r.period,
        dueDate: r.dueDate,
        createdAt: r.createdAt,
    };
}

const GoalsRepository = {
    async listForEmployee(employeeId) {
        const rows = await db.all(
            `SELECT ${GOAL_COLS} FROM goals WHERE employee_id = ? ORDER BY parent_id NULLS FIRST, created_at`,
            [employeeId]
        );
        return rows.map(mapGoal);
    },
    async get(id) {
        return mapGoal(await db.get(`SELECT ${GOAL_COLS} FROM goals WHERE id = ?`, [id]));
    },
    async create(g) {
        const r = await db.get(
            `INSERT INTO goals(employee_id, parent_id, kind, title, description, metric_unit, target_value, period, due_date, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [
                g.employeeId,
                g.parentId || null,
                g.kind || 'objective',
                g.title,
                g.description || null,
                g.metricUnit || null,
                g.targetValue != null ? g.targetValue : null,
                g.period || null,
                g.dueDate || null,
                g.createdBy || null,
            ]
        );
        return this.get(Number(r.id));
    },
    /**
     * A KEY RESULT whose progress reaches its target completes itself: it used
     * to stay « active » at 12/10 until somebody remembered to change a status
     * no screen could set. Applies only to a progress update (no explicit
     * status in the call) on a key result with a target that is still
     * active / at risk — an explicit status, a cancelled or a done goal, an
     * objective, or a target-less KR are left exactly as asked.
     */
    async updateProgress(id, currentValue, status) {
        if (!status) {
            const g = await db.get('SELECT kind, target_value, status FROM goals WHERE id = ?', [
                id,
            ]);
            const target = g && g.targetValue != null ? Number(g.targetValue) : null;
            // target > 0: the whole OKR surface reads progress as current/target
            // (an "up" metric); a zero target is not a reachable threshold.
            if (
                g &&
                g.kind === 'key_result' &&
                target != null &&
                Number.isFinite(target) &&
                target > 0 &&
                ['active', 'at_risk'].includes(g.status) &&
                Number.isFinite(Number(currentValue)) &&
                Number(currentValue) >= target
            ) {
                status = 'done';
            }
        }
        if (status)
            await db.run('UPDATE goals SET current_value = ?, status = ? WHERE id = ?', [
                currentValue,
                status,
                id,
            ]);
        else await db.run('UPDATE goals SET current_value = ? WHERE id = ?', [currentValue, id]);
        return this.get(id);
    },
};

const CHECKIN_COLS = `id, employee_id AS employeeId, manager_id AS managerId, kind, title,
    scheduled_at AS scheduledAt, occurred_at AS occurredAt, status, shared_notes AS sharedNotes,
    sentiment, created_by AS createdBy, created_at AS createdAt`;

function mapCheckIn(r) {
    if (!r) return null;
    return {
        id: int(r.id),
        employeeId: int(r.employeeId),
        managerId: r.managerId != null ? int(r.managerId) : null,
        kind: r.kind,
        title: r.title,
        scheduledAt: r.scheduledAt,
        occurredAt: r.occurredAt,
        status: r.status,
        sharedNotes: r.sharedNotes,
        sentiment: r.sentiment != null ? int(r.sentiment) : null,
        createdAt: r.createdAt,
    };
}

function mapItem(r) {
    return {
        id: int(r.id),
        checkInId: int(r.checkInId),
        body: r.body,
        isAction: bool(r.isAction),
        done: bool(r.done),
        position: int(r.position),
    };
}

const CheckInsRepository = {
    /** Check-ins for one employee (caller already RBAC-authorised), newest first, with item counts. */
    async listForEmployee(employeeId) {
        const rows = await db.all(
            `SELECT ${CHECKIN_COLS},
                    (SELECT COUNT(*) FROM check_in_items i WHERE i.check_in_id = c.id) AS itemTotal,
                    (SELECT COUNT(*) FROM check_in_items i WHERE i.check_in_id = c.id AND i.is_action AND i.done) AS actionsDone,
                    (SELECT COUNT(*) FROM check_in_items i WHERE i.check_in_id = c.id AND i.is_action) AS actionsTotal,
                    (SELECT m.first_name || ' ' || m.last_name FROM employees m WHERE m.id = c.manager_id) AS managerName
               FROM check_ins c
              WHERE employee_id = ?
              ORDER BY COALESCE(scheduled_at, created_at) DESC`,
            [employeeId]
        );
        return rows.map((r) => ({
            ...mapCheckIn(r),
            items: int(r.itemTotal),
            actions: int(r.actionsTotal),
            actionsCompleted: int(r.actionsDone),
            managerName: r.managerName || null,
        }));
    },
    async get(id) {
        return mapCheckIn(
            await db.get(`SELECT ${CHECKIN_COLS} FROM check_ins c WHERE id = ?`, [id])
        );
    },
    async create(c) {
        const r = await db.get(
            `INSERT INTO check_ins(employee_id, manager_id, kind, title, scheduled_at, status, shared_notes, sentiment, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [
                c.employeeId,
                c.managerId || null,
                c.kind || 'one_on_one',
                c.title || null,
                c.scheduledAt || null,
                c.status || 'scheduled',
                c.sharedNotes || null,
                c.sentiment != null ? c.sentiment : null,
                c.createdBy || null,
            ]
        );
        return this.get(Number(r.id));
    },
    /** Patch mutable fields; only provided keys are written. */
    async update(id, fields) {
        const sets = [];
        const params = [];
        const map = {
            status: 'status',
            occurredAt: 'occurred_at',
            sharedNotes: 'shared_notes',
            sentiment: 'sentiment',
            title: 'title',
            scheduledAt: 'scheduled_at',
        };
        for (const [k, col] of Object.entries(map)) {
            if (fields[k] !== undefined) {
                sets.push(`${col} = ?`);
                params.push(fields[k]);
            }
        }
        if (sets.length) {
            params.push(id);
            await db.run(`UPDATE check_ins SET ${sets.join(', ')} WHERE id = ?`, params);
        }
        return this.get(id);
    },
    async listItems(checkInId) {
        const rows = await db.all(
            `SELECT id, check_in_id AS checkInId, body, is_action AS isAction, done, position
               FROM check_in_items WHERE check_in_id = ? ORDER BY position, id`,
            [checkInId]
        );
        return rows.map(mapItem);
    },
    async addItem(checkInId, { body, isAction, position }) {
        const r = await db.get(
            `INSERT INTO check_in_items(check_in_id, body, is_action, position)
             VALUES (?, ?, ?, ?) RETURNING id`,
            [checkInId, body, isAction ? true : false, Number.isFinite(position) ? position : 0]
        );
        return mapItem(
            await db.get(
                `SELECT id, check_in_id AS checkInId, body, is_action AS isAction, done, position FROM check_in_items WHERE id = ?`,
                [Number(r.id)]
            )
        );
    },
    async getItem(itemId) {
        return mapItem(
            await db.get(
                `SELECT id, check_in_id AS checkInId, body, is_action AS isAction, done, position FROM check_in_items WHERE id = ?`,
                [itemId]
            )
        );
    },
    async setItemDone(itemId, done) {
        await db.run('UPDATE check_in_items SET done = ? WHERE id = ?', [
            done ? true : false,
            itemId,
        ]);
        return this.getItem(itemId);
    },
};

module.exports = {
    SkillsRepository,
    ReadinessRepository,
    EmployeesRepository,
    TalentRepository,
    DevelopmentRepository,
    GoalsRepository,
    CheckInsRepository,
};
