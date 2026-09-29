'use strict';

const db = require('../config/database');

/**
 * adminScope — THE single expansion of an admin's delegated authority.
 *
 * WHY THIS EXISTS
 *   `admin_scopes` supports five scope types (region, country, site, department,
 *   service), enforced by a CHECK constraint. Before this module, SIX places
 *   interpreted those rows independently and had drifted apart:
 *
 *     EmployeeModel.findByScopesAndFilters   site, department, service, country
 *     RBACService.getFilteredSites           site only
 *     RBACService.getFilteredDepartments     site only
 *     EmployeeController (3 places)          site, department, service
 *     MyAccessController                     site, department, service
 *     AdminController                        all five (display only)
 *
 *   Two measured consequences:
 *
 *   1. A COUNTRY-scoped admin over Côte d'Ivoire could list their 57 employees
 *      but got ZERO sites and ZERO departments — so every dropdown and filter was
 *      empty, and the employee EDIT form collapsed entirely: with no site option
 *      the cascade never fires, and the person's existing site, department and
 *      service appear to have vanished.
 *
 *   2. A REGION-scoped admin FAILED OPEN. No branch matched their scope type, so
 *      no condition was added, so they saw every employee in the organisation —
 *      77 of 77. An unrecognised scope type granted MORE authority, not less.
 *
 *   (2) is why this module is written the way it is: the expansion is one SQL
 *   statement over the real hierarchy, and anything it cannot account for
 *   produces an EMPTY set, never an absent filter. Fail closed, always.
 *
 * TWO DIFFERENT QUESTIONS, DELIBERATELY SEPARATED
 *   `employeeIds`  — the AUTHORITY set: exactly whom this admin may see and act
 *                    on. A department-scoped admin gets that department's people
 *                    and nobody else.
 *   `siteIds` /    — the NAVIGABLE set: the org units that must appear in their
 *   `departmentIds`  dropdowns and filters. A department-scoped admin needs the
 *   `serviceIds`     PARENT SITE to appear, or the site <select> cannot render
 *                    the value their own people already hold — but they still
 *                    only get their own department within it.
 *   Conflating the two is what produced the empty-dropdown bug.
 *
 * HIERARCHY (verified against the live schema, all rows populated)
 *   regions ← countries.region_id ← sites.country_id ← departments.site_id
 *           ← services.department_id ← employees.service_id
 */

/** Scope types this module knows how to expand. Anything else is refused. */
const KNOWN_SCOPE_TYPES = Object.freeze(['region', 'country', 'site', 'department', 'service']);

const EMPTY = Object.freeze({
    unrestricted: false,
    siteIds: [],
    departmentIds: [],
    serviceIds: [],
    employeeIds: [],
    scopeSummary: [],
    unknownScopeTypes: [],
});

// The org-wide summary carries a LOCALE KEY, not a French string: the
// screens that print it translate `labelKey` at render time.
const UNRESTRICTED = Object.freeze({
    unrestricted: true,
    siteIds: null,
    departmentIds: null,
    serviceIds: null,
    employeeIds: null,
    scopeSummary: [{ type: 'all', label: null, labelKey: 'admin:tri_scope_org' }],
    unknownScopeTypes: [],
});

const ids = (rows, key) =>
    rows.map((r) => Number(r[key] != null ? r[key] : r.id)).filter((n) => !Number.isNaN(n));

/**
 * Expand an admin's delegated authority.
 *
 * @param {object} user  the session principal
 * @returns {Promise<{
 *   unrestricted: boolean,
 *   siteIds: number[]|null, departmentIds: number[]|null,
 *   serviceIds: number[]|null, employeeIds: number[]|null,
 *   scopeSummary: Array<{type:string,label:string}>,
 *   unknownScopeTypes: string[]
 * }>}  `null` on a set means unrestricted; `[]` means nothing visible.
 */
async function resolveAdminScope(user, { withLabels = false, includeInactive = false } = {}) {
    if (!user) return EMPTY;

    // SuperAdmin is unscoped by definition — the one legitimate "sees all".
    const RBACService = require('../services/RBACService');
    if (RBACService.isSuperAdmin(user)) return UNRESTRICTED;

    // Managers/supervisors are governed by the reporting tree, not admin_scopes.
    // They are not this module's concern; callers use findGovernedIds for them.
    if (user.userType !== 'admin') return EMPTY;

    // Expired grants must not confer authority. `expires_at IS NULL` = permanent.
    // A row revoked by "Désactiver" (migration 110) confers nothing either.
    //
    // `includeInactive` is NOT an authority read: it answers "what could this
    // account govern again" — the perimeter "Réactiver" / "Prolonger" would put
    // back in force. The admin-on-admin containment guard must judge a target on
    // THAT set, or a deactivated (all rows revoked → empty set) country-wide
    // admin is vacuously "contained" by any delegate (3.23.17, finding A-1).
    const rows = await db.all(
        includeInactive
            ? `SELECT scope_type AS "scopeType", region_id AS "regionId", country_id AS "countryId",
                      site_id AS "siteId", department_id AS "departmentId", service_id AS "serviceId"
                 FROM admin_scopes
                WHERE admin_id = ?`
            : `SELECT scope_type AS "scopeType", region_id AS "regionId", country_id AS "countryId",
                      site_id AS "siteId", department_id AS "departmentId", service_id AS "serviceId"
                 FROM admin_scopes
                WHERE admin_id = ?
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > now())`,
        [Number(user.id)]
    );

    if (!rows.length) return EMPTY;

    // FAIL CLOSED. A scope type this module does not understand is reported and
    // contributes NOTHING — it must never widen the result by being ignored.
    const unknown = [
        ...new Set(rows.map((r) => r.scopeType).filter((t) => !KNOWN_SCOPE_TYPES.includes(t))),
    ];
    const usable = rows.filter((r) => KNOWN_SCOPE_TYPES.includes(r.scopeType));
    if (!usable.length) return { ...EMPTY, unknownScopeTypes: unknown, scopeRowCount: rows.length };

    const pick = (type, key) =>
        usable
            .filter((r) => r.scopeType === type)
            .map((r) => Number(r[key]))
            .filter(Boolean);
    const regionIds = pick('region', 'regionId');
    const countryIds = pick('country', 'countryId');
    const siteScope = pick('site', 'siteId');
    const deptScope = pick('department', 'departmentId');
    const svcScope = pick('service', 'serviceId');

    // node-pg maps a JS array to a PG array, so `= ANY(?)` keeps ONE SQL template
    // regardless of how many scopes an admin holds — the translation memo cache
    // then actually hits, which matters on every scoped request at 4000 users.
    const p = [regionIds, countryIds, siteScope, deptScope, svcScope];

    // ── AUTHORITY: exactly whose records this admin may act on ────────────────
    const empRows = await db.all(
        `SELECT e.id
           FROM employees e
           JOIN sites s        ON s.id = e.site_id
           LEFT JOIN countries c ON c.id = s.country_id
          WHERE c.region_id = ANY(?)
             OR s.country_id = ANY(?)
             OR e.site_id = ANY(?)
             OR e.department_id = ANY(?)
             OR e.service_id = ANY(?)`,
        p
    );

    // ── NAVIGABLE: the org units their screens must be able to show ──────────
    // A site qualifies if it is scoped directly, sits under a scoped country or
    // region, OR merely CONTAINS a scoped department/service — the last case is
    // what lets a department-scoped admin's site <select> render the value their
    // own people already hold.
    const siteRows = await db.all(
        `SELECT DISTINCT s.id
           FROM sites s
           LEFT JOIN countries c   ON c.id = s.country_id
           LEFT JOIN departments d ON d.site_id = s.id
           LEFT JOIN services   v  ON v.department_id = d.id
          WHERE c.region_id = ANY(?)
             OR s.country_id = ANY(?)
             OR s.id = ANY(?)
             OR d.id = ANY(?)
             OR v.id = ANY(?)`,
        p
    );

    // A department qualifies if scoped directly, if its SITE is in authority
    // (site/country/region scope grants the whole site), or if it contains a
    // scoped service. A department-scoped admin does NOT get sibling departments.
    const deptRows = await db.all(
        `SELECT DISTINCT d.id
           FROM departments d
           JOIN sites s          ON s.id = d.site_id
           LEFT JOIN countries c ON c.id = s.country_id
           LEFT JOIN services v  ON v.department_id = d.id
          WHERE c.region_id = ANY(?)
             OR s.country_id = ANY(?)
             OR s.id = ANY(?)
             OR d.id = ANY(?)
             OR v.id = ANY(?)`,
        p
    );

    const svcRows = await db.all(
        `SELECT DISTINCT v.id
           FROM services v
           JOIN departments d    ON d.id = v.department_id
           JOIN sites s          ON s.id = d.site_id
           LEFT JOIN countries c ON c.id = s.country_id
          WHERE c.region_id = ANY(?)
             OR s.country_id = ANY(?)
             OR s.id = ANY(?)
             OR d.id = ANY(?)
             OR v.id = ANY(?)`,
        p
    );

    return {
        unrestricted: false,
        employeeIds: ids(empRows, 'id'),
        siteIds: ids(siteRows, 'id'),
        departmentIds: ids(deptRows, 'id'),
        serviceIds: ids(svcRows, 'id'),
        // Labels are for screens only. Resolving them on every authorisation
        // check would put an extra query on the hot path for data nobody reads.
        scopeSummary: withLabels ? await describeScopes(usable) : [],
        unknownScopeTypes: unknown,
        scopeRowCount: rows.length,
    };
}

/**
 * Human-readable scope list for the admin console and /mon-acces — "Pays :
 * Côte d'Ivoire" rather than "country_id 9".
 *
 * ONE query, not one per scope row. The first version issued a lookup per row,
 * which put an N+1 on the ENFORCEMENT path — every authorisation check paid for
 * labels it never used, and the delegation console (40 admins) multiplied it into
 * hundreds of round trips. Labels are display-only, so they are also opt-in:
 * see the `withLabels` option on resolveAdminScope.
 *
 * Best-effort by design — a missing label must never change what an admin can do.
 */
async function describeScopes(rows) {
    const byType = { region: [], country: [], site: [], department: [], service: [] };
    const idOf = {
        region: 'regionId',
        country: 'countryId',
        site: 'siteId',
        department: 'departmentId',
        service: 'serviceId',
    };
    for (const r of rows) {
        const id = Number(r[idOf[r.scopeType]]);
        if (byType[r.scopeType] && id) byType[r.scopeType].push(id);
    }

    const names = {
        region: new Map(),
        country: new Map(),
        site: new Map(),
        department: new Map(),
        service: new Map(),
    };
    const TABLES = {
        region: 'regions',
        country: 'countries',
        site: 'sites',
        department: 'departments',
        service: 'services',
    };
    await Promise.all(
        Object.entries(byType).map(async ([type, list]) => {
            if (!list.length) return;
            try {
                const found = await db.all(
                    `SELECT id, name FROM ${TABLES[type]} WHERE id = ANY(?)`,
                    [list]
                );
                found.forEach((x) => names[type].set(Number(x.id), x.name));
            } catch (_) {
                /* labels are cosmetic; leave the map empty */
            }
        })
    );

    return rows.map((r) => {
        const id = Number(r[idOf[r.scopeType]]);
        return {
            type: r.scopeType,
            label: (names[r.scopeType] && names[r.scopeType].get(id)) || `#${id}`,
        };
    });
}

module.exports = { resolveAdminScope, KNOWN_SCOPE_TYPES };
