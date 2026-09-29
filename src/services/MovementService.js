/**
 * MovementService — the data behind the one-page "what is happening, where,
 * and who did it" view.
 *
 * Two streams, one shape (see v_movement_feed in migration 60):
 *   - movements   : site / department / service / role / manager / supervisor /
 *                   status changes, captured by a database trigger so imports,
 *                   SCIM, SSO and direct SQL are all covered, not just the UI.
 *   - assessor    : skill assessments recorded and self-assessment reviews.
 *
 * Every query is RBAC-scoped BEFORE it aggregates, through the shared
 * rbacScope helper — a manager must never see a movement or a count that
 * includes somebody outside their governed span.
 */
const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { personNameOf } = require('../utils/personName');

// The last two are written by MaintenanceService, not by the movement trigger:
// a SuperAdmin cancelling an IDP/PIP or a 9-box position belongs in the same
// "what happened to this person" feed as their site and manager changes. They
// must be listed here or the filter silently drops them (feed ignores a kind
// it does not recognise, so an unlisted kind is unfilterable rather than an
// error).
// 'account' is written by recordAccount below:
// credentials issued, login disabled / re-enabled, lockout cleared, policy set.
const KINDS = [
    'site',
    'department',
    'service',
    'role',
    'manager',
    'supervisor',
    'status',
    'plan_cancelled',
    'placement_cancelled',
    'assessment_cancelled',
    'account',
];
const STREAMS = ['movement', 'assessment', 'review'];

/** 'admin:5' / 'employee:12' for a req.user-shaped actor, or null (system). */
function actorRefOf(actor) {
    if (!actor) return null;
    if (typeof actor === 'string') return actor;
    if (actor.id == null) return null;
    return `${actor.userType || 'admin'}:${actor.id}`;
}

/** Resolve 'admin:5' / 'employee:12' into a display name, in one round trip. */
async function resolveActors(refs) {
    const out = new Map();
    const adminIds = [],
        empIds = [];
    for (const r of new Set(refs.filter(Boolean))) {
        const [type, id] = String(r).split(':');
        const n = parseInt(id, 10);
        if (!Number.isFinite(n)) continue;
        if (type === 'admin') adminIds.push(n);
        else if (type === 'employee') empIds.push(n);
    }
    if (adminIds.length) {
        const rows = await db.all(
            `SELECT id, username FROM admins WHERE id IN (${adminIds.map(() => '?').join(',')})`,
            adminIds
        );
        rows.forEach((r) => out.set(`admin:${r.id}`, r.username));
    }
    if (empIds.length) {
        const rows = await db.all(
            `SELECT id, first_name AS "firstName", last_name AS "lastName"
             FROM employees WHERE id IN (${empIds.map(() => '?').join(',')})`,
            empIds
        );
        // one order product-wide (utils/personName) — the movements feed
        // named the same actor « NOVAK, Clara » where every other surface says
        // « Clara Beatrice NOVAK ».
        rows.forEach((r) => out.set(`employee:${r.id}`, personNameOf(r)));
    }
    return out;
}

/**
 * Hard ceiling for a single movement query.
 *
 * The page asks for 200. The CSV export used to be capped at 500 while its own
 * doc comment promised "exactly what the page shows — same scope, same
 * filters": on a 30-day window with 3068 matching rows it silently shipped 500
 * and said nothing, so a reconciliation done from that file was wrong and
 * looked complete. An export now asks for everything its filter matched, with
 * this as the only bound.
 */
const MAX_ROWS = 50000;

const MovementService = {
    MAX_ROWS,

    KINDS,
    STREAMS,
    actorRefOf,

    /**
     * One row of the ACCOUNT stream. The labels are stable
     * tokens (credentials_emailed, login_disabled, unlocked, policy:sso_only…)
     * that the movements page renders through admin:mv_acc_<token>; free text
     * goes in `note`. Best-effort by contract: the feed is a reading surface
     * and must never roll back the account action it describes.
     */
    async recordAccount(employeeId, { actor = null, fromLabel = null, toLabel, note = null } = {}) {
        if (!employeeId || !toLabel) return;
        try {
            await db.run(
                `INSERT INTO employee_movements (employee_id, kind, from_label, to_label, actor_ref, source, note)
                 VALUES (?, 'account', ?, ?, ?, 'account', ?)`,
                [Number(employeeId), fromLabel, toLabel, actorRefOf(actor), note]
            );
        } catch (e) {
            console.error('[MovementService] account row failed:', e && e.message);
        }
    },

    /**
     * The feed itself. Filters: days, stream, kind, siteName, departmentName, q, limit.
     * Returns rows already carrying a human actor name.
     */
    /**
     * The WHERE clause every movement surface must share.
     *
     * The feed applied stream / kind / site / department / q; the summary
     * applied none of them, so filtering the page to one site left the KPI
     * strip reporting the whole organisation — 215 movements above a table
     * showing 8. The strip and the table now cannot describe different sets,
     * because they build that set here.
     *
     * @returns {{where: string[], params: any[], days: number}|null} null when
     *          the caller's scope is empty (nothing to ask the database).
     */
    _scope(ids, opts = {}) {
        const days = Number.isFinite(Number(opts.days))
            ? Math.max(1, Math.min(365, Number(opts.days)))
            : 30;
        if (Array.isArray(ids) && ids.length === 0) return null;

        const where = [`f.occurred_at >= now() - INTERVAL '${days} days`.concat("'")];
        const params = [];
        if (Array.isArray(ids)) {
            where.push(`f.employee_id IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        }
        if (opts.stream && STREAMS.includes(opts.stream)) {
            where.push('f.stream = ?');
            params.push(opts.stream);
        }
        if (opts.kind && KINDS.includes(opts.kind)) {
            where.push('f.event_kind = ?');
            params.push(opts.kind);
        }
        if (opts.siteName) {
            where.push('f.site_name = ?');
            params.push(opts.siteName);
        }
        if (opts.departmentName) {
            where.push('f.department_name = ?');
            params.push(opts.departmentName);
        }
        if (opts.q) {
            where.push(
                "(LOWER(f.employee_name) LIKE ? OR LOWER(COALESCE(f.skill_name, '')) LIKE ?)"
            );
            const like = `%${String(opts.q).toLowerCase()}%`;
            params.push(like, like);
        }
        return { where, params, days };
    },

    async feed(user, opts = {}) {
        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return [];

        const sc = this._scope(ids, opts);
        if (!sc) return [];
        const { where, params } = sc;
        // MAX_ROWS, not a hard 500: an export asks for everything the filter
        // matched, and the page asks for its own page size.
        const limit = Number.isFinite(Number(opts.limit))
            ? Math.max(1, Math.min(MAX_ROWS, Number(opts.limit)))
            : 200;

        const rows = await db.all(
            `SELECT f.stream, f.event_kind AS "eventKind", f.occurred_at AS "occurredAt",
                    f.employee_id AS "employeeId", f.employee_name AS "employeeName",
                    f.employee_number AS "employeeNumber", f.site_name AS "siteName",
                    f.department_name AS "departmentName", f.from_label AS "fromLabel",
                    f.to_label AS "toLabel", f.actor_ref AS "actorRef", f.skill_name AS "skillName"
             FROM v_movement_feed f
             WHERE ${where.join(' AND ')}
             ORDER BY f.occurred_at DESC
             LIMIT ${limit}`,
            params
        );

        const actors = await resolveActors(rows.map((r) => r.actorRef));
        return rows.map((r) => ({
            ...r,
            actorName: r.actorRef ? actors.get(r.actorRef) || r.actorRef : null,
        }));
    },

    /** Headline counters for the top of the page, over the same window and scope. */
    async summary(user, opts = {}) {
        const ids = await scopedEmployeeIds(user);
        const empty = {
            movements: 0,
            peopleMoved: 0,
            assessments: 0,
            reviews: 0,
            activeActors: 0,
            byKind: [],
            topActors: [],
            bySite: [],
        };

        // THE SAME SET THE TABLE SHOWS. This used to apply only the window and
        // the RBAC scope, ignoring stream / kind / site / department / search —
        // so filtering the page to one site left the strip reporting the whole
        // organisation above a table showing that site.
        const sc = this._scope(ids, opts);
        if (!sc) return empty;
        const rest = sc.where.slice(1); // [0] is the time window, carried separately
        const scope = rest.length ? `AND ${rest.join(' AND ')}` : '';
        const p = sc.params;
        const win = sc.where[0];

        const totals = await db.get(
            `SELECT
                COUNT(*) FILTER (WHERE f.stream = 'movement')                    AS "movements",
                COUNT(DISTINCT f.employee_id) FILTER (WHERE f.stream = 'movement') AS "peopleMoved",
                COUNT(*) FILTER (WHERE f.stream = 'assessment')                  AS "assessments",
                COUNT(*) FILTER (WHERE f.stream = 'review')                      AS "reviews",
                COUNT(DISTINCT f.actor_ref)                                      AS "activeActors"
             FROM v_movement_feed f WHERE ${win} ${scope}`,
            p
        );

        const byKind = await db.all(
            `SELECT f.event_kind AS "kind", COUNT(*) AS "n"
             FROM v_movement_feed f WHERE ${win} AND f.stream = 'movement' ${scope}
             GROUP BY f.event_kind ORDER BY n DESC`,
            p
        );

        const bySite = await db.all(
            `SELECT COALESCE(f.site_name, '—') AS "siteName", COUNT(*) AS "n"
             FROM v_movement_feed f WHERE ${win} AND f.stream = 'movement' ${scope}
             GROUP BY f.site_name ORDER BY n DESC LIMIT 10`,
            p
        );

        const actorRows = await db.all(
            `SELECT f.actor_ref AS "actorRef", COUNT(*) AS "n"
             FROM v_movement_feed f WHERE ${win} AND f.actor_ref IS NOT NULL ${scope}
             GROUP BY f.actor_ref ORDER BY n DESC LIMIT 10`,
            p
        );
        const actors = await resolveActors(actorRows.map((r) => r.actorRef));

        return {
            movements: Number(totals?.movements || 0),
            peopleMoved: Number(totals?.peopleMoved || 0),
            assessments: Number(totals?.assessments || 0),
            reviews: Number(totals?.reviews || 0),
            activeActors: Number(totals?.activeActors || 0),
            byKind: byKind.map((r) => ({ kind: r.kind, n: Number(r.n) })),
            bySite: bySite.map((r) => ({ siteName: r.siteName, n: Number(r.n) })),
            topActors: actorRows.map((r) => ({
                actorRef: r.actorRef,
                actorName: actors.get(r.actorRef) || r.actorRef,
                n: Number(r.n),
            })),
        };
    },

    /** Distinct sites/departments present in the scoped feed, for the filter selects. */
    async filterOptions(user, opts = {}) {
        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return { sites: [], departments: [] };
        const days = Number.isFinite(Number(opts.days))
            ? Math.max(1, Math.min(365, Number(opts.days)))
            : 30;
        const scope = Array.isArray(ids)
            ? `AND f.employee_id IN (${ids.map(() => '?').join(',')})`
            : '';
        const p = Array.isArray(ids) ? ids : [];
        const win = `f.occurred_at >= now() - INTERVAL '${days} days'`;
        const sites = await db.all(
            `SELECT DISTINCT f.site_name AS "name" FROM v_movement_feed f
             WHERE ${win} AND f.site_name IS NOT NULL ${scope} ORDER BY "name"`,
            p
        );
        const departments = await db.all(
            `SELECT DISTINCT f.department_name AS "name" FROM v_movement_feed f
             WHERE ${win} AND f.department_name IS NOT NULL ${scope} ORDER BY "name"`,
            p
        );
        return { sites: sites.map((r) => r.name), departments: departments.map((r) => r.name) };
    },
};

module.exports = MovementService;
