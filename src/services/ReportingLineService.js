'use strict';

/**
 * ReportingLineService — WHO a notification about a person goes to (3.23.18, R2).
 *
 * THE MODEL
 *   employees.supervisor_id              → the DIRECT REVIEWER (an employee).
 *   employees.manager_id + manager_type  → the MANAGER, polymorphic: an employee
 *                                          ('employee') or an admin ('admin'). The
 *                                          manager alone validates / arbitrates.
 *
 * THE DEFECT THIS REPLACES
 *   Every notification path resolved the recipient with
 *       COALESCE(supervisor_id, CASE WHEN manager_type = 'employee' THEN manager_id END)
 *   which (a) happily returned a supervisor who had LEFT — the reminder went to a
 *   deactivated account and nobody else heard of it — (b) never reached an
 *   ADMIN manager, and (c) never reached the manager at all when a supervisor
 *   existed, so a file awaiting the manager's validation was announced only to
 *   the person who could not validate it.
 *
 * THE RULE (one definition, every caller)
 *   effectiveReviewer = the ACTIVE supervisor, else the ACTIVE employee-manager,
 *                       else the ACTIVE admin-manager, else null.
 *   lineRecipients    = the effective reviewer + the manager (employee or admin)
 *                       when different — for events the manager must act on or
 *                       know about. Deduplicated; never the person themselves;
 *                       never an inactive / voided / erased account.
 *
 * "Active" for an employee is the same bar as GovernanceService.activePersonSql:
 * is_active, not voided (cancelled_at), not erased (erased_at). For an admin it
 * is is_active (NULL read as active, like every other admin query here).
 */

const db = require('../config/database');
const { personNameSql } = require('../utils/personName');

/** An employee row that can still RECEIVE something about someone else. */
function activeEmployeeSql(x) {
    return `${x}.is_active = true AND ${x}.cancelled_at IS NULL AND ${x}.erased_at IS NULL`;
}

/** An admin row that can still receive something. */
function activeAdminSql(x) {
    return `COALESCE(${x}.is_active, true) = true`;
}

const CHUNK = 500;

/*
 * One row per employee: the live supervisor, the live employee-manager and the
 * live admin-manager, each already filtered for activity and for "not the
 * person themselves". `manager_type` NULL is read as 'employee' (legacy rows),
 * the same reading GovernanceService uses; an admin id is NEVER joined against
 * employees (the two id spaces overlap).
 */
function lineSql(placeholders) {
    return `SELECT e.id AS "employeeId",
                   (${activeEmployeeSql('e')}) AS "employeeActive",
                   sup.id AS "supId", ${personNameSql('sup')} AS "supName",
                   mge.id AS "mgrEmpId", ${personNameSql('mge')} AS "mgrEmpName",
                   mga.id AS "mgrAdmId",
                   COALESCE(NULLIF(${personNameSql('mgal')}, ''), mga.username::text) AS "mgrAdmName",
                   mga.linked_employee_id AS "mgrAdmLinkedEmpId"
              FROM employees e
              LEFT JOIN employees sup
                     ON sup.id = e.supervisor_id AND sup.id <> e.id AND ${activeEmployeeSql('sup')}
              LEFT JOIN employees mge
                     ON COALESCE(e.manager_type, 'employee') = 'employee'
                    AND mge.id = e.manager_id AND mge.id <> e.id AND ${activeEmployeeSql('mge')}
              LEFT JOIN admins mga
                     ON e.manager_type = 'admin' AND mga.id = e.manager_id AND ${activeAdminSql('mga')}
                    AND (mga.linked_employee_id IS NULL OR mga.linked_employee_id <> e.id)
              LEFT JOIN employees mgal ON mgal.id = mga.linked_employee_id
             WHERE e.id IN (${placeholders})`;
}

function toLine(r) {
    const num = (v) => (v == null ? null : Number(v) || null);
    const supervisor = num(r.supId)
        ? { type: 'employee', id: num(r.supId), name: r.supName || null }
        : null;
    let manager = null;
    if (num(r.mgrEmpId))
        manager = { type: 'employee', id: num(r.mgrEmpId), name: r.mgrEmpName || null };
    else if (num(r.mgrAdmId))
        manager = {
            type: 'admin',
            id: num(r.mgrAdmId),
            name: r.mgrAdmName || null,
            linkedEmployeeId: num(r.mgrAdmLinkedEmpId),
        };
    return {
        employeeId: num(r.employeeId),
        employeeActive: r.employeeActive === true || r.employeeActive === 't',
        supervisor,
        manager,
    };
}

function reviewerOfLine(line) {
    if (!line) return null;
    if (line.supervisor) return { ...line.supervisor, via: 'supervisor' };
    if (line.manager) {
        const { linkedEmployeeId, ...m } = line.manager; // eslint-disable-line no-unused-vars
        return { ...m, via: 'manager' };
    }
    return null;
}

/** Same human on both ends (an admin account linked to the reviewer's employee row). */
function samePerson(a, b) {
    if (!a || !b) return false;
    if (a.type === b.type && Number(a.id) === Number(b.id)) return true;
    if (a.type === 'employee' && b.type === 'admin' && b.linkedEmployeeId === a.id) return true;
    return false;
}

function recipientsOfLine(line, { includeManager = true } = {}) {
    if (!line) return [];
    const out = [];
    const reviewer = line.supervisor || line.manager;
    if (reviewer)
        out.push({
            userType: reviewer.type,
            id: reviewer.id,
            role: line.supervisor ? 'reviewer' : 'manager',
        });
    if (includeManager && line.manager && !samePerson(reviewer, line.manager)) {
        out.push({ userType: line.manager.type, id: line.manager.id, role: 'manager' });
    }
    // Never the person themselves (belt: the SQL already excludes self-links).
    return out.filter((r) => !(r.userType === 'employee' && r.id === line.employeeId));
}

const ReportingLineService = {
    activeEmployeeSql,
    activeAdminSql,

    /**
     * The reporting line of many people in one pass (chunked).
     * @param {number[]} employeeIds
     * @returns {Promise<Map<number, {employeeId:number, employeeActive:boolean,
     *   supervisor:object|null, manager:object|null}>>}
     */
    async linesFor(employeeIds) {
        const ids = [
            ...new Set((employeeIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)),
        ];
        const map = new Map();
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const rows = await db.all(lineSql(slice.map(() => '?').join(',')), slice);
            for (const r of rows || []) {
                const line = toLine(r);
                if (line.employeeId) map.set(line.employeeId, line);
            }
        }
        return map;
    },

    async lineOf(employeeId) {
        const m = await this.linesFor([employeeId]);
        return m.get(Number(employeeId)) || null;
    },

    /**
     * ACTIVE supervisor → ACTIVE employee-manager → ACTIVE admin-manager → null.
     * @returns {Promise<{type:'employee'|'admin', id:number, name:string|null, via:string}|null>}
     */
    async effectiveReviewer(employeeId) {
        return reviewerOfLine(await this.lineOf(employeeId));
    },

    /** @returns {Promise<Map<number, object|null>>} */
    async effectiveReviewerMany(employeeIds) {
        const lines = await this.linesFor(employeeIds);
        const out = new Map();
        for (const [id, line] of lines) out.set(id, reviewerOfLine(line));
        return out;
    },

    /** The ACTIVE manager (employee or admin) — the validator / arbitrator — or null. */
    async managerOf(employeeId) {
        const line = await this.lineOf(employeeId);
        if (!line || !line.manager) return null;
        const { linkedEmployeeId, ...m } = line.manager; // eslint-disable-line no-unused-vars
        return m;
    },

    /**
     * Deduplicated ACTIVE recipients for an event about `employeeId`:
     * the effective reviewer, plus the manager when different and
     * `includeManager` (default true). Never the person themselves.
     * @returns {Promise<Array<{userType:'employee'|'admin', id:number, role:'reviewer'|'manager'}>>}
     */
    async lineRecipients(employeeId, { includeManager = true } = {}) {
        return recipientsOfLine(await this.lineOf(employeeId), { includeManager });
    },

    /** @returns {Promise<Map<number, Array<{userType:string, id:number, role:string}>>>} */
    async lineRecipientsMany(employeeIds, { includeManager = true } = {}) {
        const lines = await this.linesFor(employeeIds);
        const out = new Map();
        for (const [id, line] of lines) out.set(id, recipientsOfLine(line, { includeManager }));
        return out;
    },

    /**
     * SQL for set-based queries: a LEFT JOIN LATERAL exposing the effective
     * reviewer of the employees row aliased `e` as `<as>.kind` ('employee' |
     * 'admin') and `<as>.id`. Same priority and activity bar as effectiveReviewer.
     */
    effectiveReviewerJoinSql(e = 'e', as = 'rl') {
        return `LEFT JOIN LATERAL (
                    SELECT c.kind, c.id FROM (
                        SELECT 10 AS prio, 'employee'::text AS kind, lx.id AS id FROM employees lx
                         WHERE lx.id = ${e}.supervisor_id AND lx.id <> ${e}.id AND ${activeEmployeeSql('lx')}
                        UNION ALL
                        SELECT 20, 'employee'::text, lm.id FROM employees lm
                         WHERE COALESCE(${e}.manager_type, 'employee') = 'employee'
                           AND lm.id = ${e}.manager_id AND lm.id <> ${e}.id AND ${activeEmployeeSql('lm')}
                        UNION ALL
                        SELECT 30, 'admin'::text, la.id FROM admins la
                         WHERE ${e}.manager_type = 'admin' AND la.id = ${e}.manager_id AND ${activeAdminSql('la')}
                           AND (la.linked_employee_id IS NULL OR la.linked_employee_id <> ${e}.id)
                    ) c ORDER BY c.prio LIMIT 1
                ) ${as} ON true`;
    },

    /**
     * ACTIVE people whose reporting line points at `employeeId` — as supervisor
     * or as employee-typed manager. Used by the leaver cascade to say who is
     * left without a line.
     */
    async directReportsOf(employeeId) {
        const id = Number(employeeId);
        if (!id) return [];
        const rows = await db.all(
            `SELECT e.id, ${personNameSql('e')} AS "name", e.employee_number AS "employeeNumber",
                    (e.supervisor_id = ?) AS "viaSupervisor",
                    (COALESCE(e.manager_type, 'employee') = 'employee' AND e.manager_id = ?) AS "viaManager"
               FROM employees e
              WHERE e.id <> ? AND ${activeEmployeeSql('e')}
                AND (e.supervisor_id = ?
                     OR (COALESCE(e.manager_type, 'employee') = 'employee' AND e.manager_id = ?))
              ORDER BY e.id`,
            [id, id, id, id, id]
        );
        return (rows || []).map((r) => ({
            id: Number(r.id),
            name: r.name || null,
            employeeNumber: r.employeeNumber || null,
            viaSupervisor: r.viaSupervisor === true,
            viaManager: r.viaManager === true,
        }));
    },
};

module.exports = ReportingLineService;
module.exports.__test = { toLine, reviewerOfLine, recipientsOfLine };
