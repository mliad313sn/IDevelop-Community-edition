'use strict';

/**
 * KeyPersonRiskService — single points of failure BY NAME.
 *
 * THE QUESTION THIS ANSWERS
 *   "Which capabilities does exactly ONE person carry, who is that person, and
 *    where?" The product could already answer it one skill at a time
 *    (QualifiedPeopleService needs a skillId) and it could count bench depth per
 *    ROLE (v_continuity_coverage), but nothing swept skill × org-unit and NAMED
 *    the sole holder. 315+ skills × 9 sites is not a manual sweep.
 *
 * THE THREE-WAY BAND — the part that must not be got wrong
 *   A naive sweep reports "0 qualified" for a capability nobody has ever been
 *   assessed on, and a director reads that as a five-alarm gap. On this dev
 *   instance ALL 303 critical role requirements are entirely unassessed, so a
 *   naive sweep would invent 136 site-level "crises" out of pure absence of
 *   measurement. That is exactly the fabrication migrations 71 / 79 exist to
 *   prevent. So every (skill, org-unit) cell lands in one of four states:
 *
 *     never_measured  nobody in scope has ANY assessment on this skill
 *                     → UNKNOWN. Reported separately, never counted as risk.
 *     no_qualified    people WERE measured; none reaches the required level
 *                     → a real, evidenced gap.
 *     sole_holder     exactly one person is measured at/above the bar
 *                     → THE named key-person risk.
 *     covered         two or more qualified.
 *
 *   `qualified` counts only rows where v_resolved_assessments.level IS NOT NULL.
 *   A missing assessment is never read as a zero.
 *
 * CERTIFICATION
 *   A holder whose statutory certificate has lapsed cannot perform the work, so
 *   v_certification_lapsed demotes them out of the qualified set — the same rule
 *   v_employee_skill_gaps already applies (migration 78). A capability whose
 *   only holder is cert-lapsed therefore surfaces as no_qualified, with the
 *   lapse named as the reason.
 *
 * RBAC — scope BEFORE aggregate
 *   Everything is computed over scopedEmployeeIds(user) only: the demand side
 *   (who is required to hold the skill) AND the holder side (who qualifies).
 *   A superadmin gets org truth (null = unrestricted); a site manager gets their
 *   site; a department manager gets their department. Because the holder set is
 *   scoped too, this service can never name a person the caller may not see.
 *   The consequence — that a narrow scope reports narrower coverage than the
 *   org has — is real and is stated on the page, not hidden: the answer to
 *   "who in MY area can do this" is the scoped one.
 *
 *   Employees never reach this surface; the route is manager/admin only.
 *
 * SKILL COUNT PER ROLE IS UNTOUCHED
 *   The sweep reads role_skill_requirements whole (required_level > 0). It never
 *   samples, tiers, waves or subsets a role's department-designed skill set; it
 *   only groups the requirements that already exist.
 */

const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');

/** Org-unit dimensions the sweep can group by. */
const UNITS = {
    site: { id: 'site_id', name: 'site_name' },
    department: { id: 'department_id', name: 'department_name' },
    service: { id: 'service_id', name: 'service_name' },
};

const BANDS = ['sole_holder', 'no_qualified', 'never_measured', 'covered'];

/**
 * Resolve a caller-supplied unit key to a REAL dimension of UNITS.
 *
 * `UNITS[key]` alone is not a whitelist: a plain object inherits from
 * Object.prototype, so 'constructor', '__proto__', 'toString', 'valueOf' … all
 * pass a truthiness test and yield a function instead of a dimension. Its `.id`
 * is undefined, which used to reach the query as the identifier `ed.undefined`
 * and turn /exec/key-person?unit=constructor into a 500. Own-property only.
 *
 * @returns {string} always one of the three real unit keys.
 */
function resolveUnitKey(key) {
    return Object.prototype.hasOwnProperty.call(UNITS, key) ? key : 'site';
}

/** Cap on names carried per row — a sole-holder row has 1 by definition. */
const MAX_NAMES = 3;

const KeyPersonRiskService = {
    UNITS,
    BANDS,
    resolveUnitKey,

    /**
     * Sweep skill × org-unit for key-person risk.
     *
     * @param user            the caller (scoping subject)
     * @param opts.unit       'site' | 'department' | 'service'   (default 'site')
     * @param opts.band       one of BANDS, or 'all'              (default 'sole_holder')
     * @param opts.criticalOnly  only department-flagged critical requirements
     * @param opts.unitId     restrict to one org unit
     * @param opts.limit      row cap (default 200)
     * @returns {Promise<{rows, summary, scope}>}
     */
    async sweep(user, opts = {}) {
        const unitKey = resolveUnitKey(opts.unit);
        const unit = UNITS[unitKey];
        const band = BANDS.includes(opts.band)
            ? opts.band
            : opts.band === 'all'
              ? 'all'
              : 'sole_holder';
        const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
        const criticalOnly = Boolean(opts.criticalOnly);
        const unitId =
            Number.isFinite(Number(opts.unitId)) && Number(opts.unitId) > 0
                ? Number(opts.unitId)
                : null;

        const ids = await scopedEmployeeIds(user);
        const scope = {
            unrestricted: ids === null,
            employeeCount: ids === null ? null : ids.length,
            unit: unitKey,
        };
        // Empty scope: nothing visible. Return an honest empty result rather
        // than an unscoped query.
        if (Array.isArray(ids) && ids.length === 0) {
            return { rows: [], summary: this._emptySummary(), scope };
        }

        const params = [];
        const scopeSql = Array.isArray(ids)
            ? `AND ed.employee_id IN (${ids.map(() => '?').join(',')})`
            : '';
        const scopeParams = Array.isArray(ids) ? ids : [];

        // DEMAND: for each (skill, org-unit) inside scope, the highest level any
        // occupied role requires, whether any role flags it critical, and how
        // many people are required to hold it. role_criticality is an ELEVATING
        // signal only — it is empty on a fresh install, and gating the sweep on
        // it would make the whole surface disappear.
        const demandSql = `
            SELECT rsr.skill_id                              AS skill_id,
                   ed.${unit.id}                             AS unit_id,
                   MAX(ed.${unit.name})                      AS unit_name,
                   MAX(rsr.required_level)                   AS required_level,
                   bool_or(rsr.is_critical)                  AS is_critical,
                   COUNT(DISTINCT ed.employee_id)            AS required_of,
                   MAX(COALESCE(rc.criticality_score, 0))    AS role_criticality
            FROM v_employee_details ed
            JOIN role_skill_requirements rsr
                 ON rsr.role_id = ed.role_id AND rsr.required_level > 0
            LEFT JOIN role_criticality rc ON rc.role_id = ed.role_id
            WHERE ed.is_active AND ed.${unit.id} IS NOT NULL ${scopeSql}
            GROUP BY rsr.skill_id, ed.${unit.id}
        `;
        params.push(...scopeParams);

        // HOLDERS: everyone in scope, in the same org unit, who has an ACTUAL
        // resolved assessment on that skill. LEFT JOIN on the demand side so a
        // never-measured cell survives and can be reported as unknown.
        const holderSql = `
            SELECT d.skill_id, d.unit_id,
                   COUNT(ra.level)                                          AS measured,
                   COUNT(*) FILTER (WHERE ra.level >= d.required_level
                                      AND cl.employee_id IS NULL)           AS qualified,
                   COUNT(*) FILTER (WHERE ra.level >= d.required_level
                                      AND cl.employee_id IS NOT NULL)       AS blocked_by_cert,
                   (array_agg(ed2.full_name ORDER BY ra.level DESC, ed2.full_name)
                      FILTER (WHERE ra.level >= d.required_level
                                AND cl.employee_id IS NULL))[1:${MAX_NAMES}]  AS holder_names,
                   (array_agg(ed2.employee_id ORDER BY ra.level DESC, ed2.full_name)
                      FILTER (WHERE ra.level >= d.required_level
                                AND cl.employee_id IS NULL))[1:${MAX_NAMES}]  AS holder_ids,
                   (array_agg(ed2.role_name ORDER BY ra.level DESC, ed2.full_name)
                      FILTER (WHERE ra.level >= d.required_level
                                AND cl.employee_id IS NULL))[1:${MAX_NAMES}]  AS holder_roles
            FROM demand d
            JOIN v_employee_details ed2
                 ON ed2.${unit.id} = d.unit_id AND ed2.is_active
            JOIN v_resolved_assessments ra
                 ON ra.employee_id = ed2.employee_id
                AND ra.skill_id    = d.skill_id
                AND ra.level IS NOT NULL
            LEFT JOIN v_certification_lapsed cl
                 ON cl.employee_id = ed2.employee_id AND cl.skill_id = d.skill_id
            WHERE 1=1 ${Array.isArray(ids) ? `AND ed2.employee_id IN (${ids.map(() => '?').join(',')})` : ''}
            GROUP BY d.skill_id, d.unit_id
        `;
        const holderParams = Array.isArray(ids) ? ids : [];

        const bandExpr = `
            CASE WHEN COALESCE(h.measured, 0) = 0            THEN 'never_measured'
                 WHEN COALESCE(h.qualified, 0) = 0           THEN 'no_qualified'
                 WHEN h.qualified = 1                        THEN 'sole_holder'
                 ELSE 'covered' END`;

        const critFilter = criticalOnly ? 'AND d.is_critical' : '';
        const unitFilter = unitId ? 'AND d.unit_id = ?' : '';

        // Summary over EVERY cell in scope (before the band/limit filter) — the
        // page needs the denominators to state what it did not show.
        const summarySql = `
            WITH demand AS (${demandSql}), holders AS (${holderSql})
            SELECT ${bandExpr} AS band,
                   d.is_critical AS is_critical,
                   COUNT(*)      AS n
            FROM demand d
            LEFT JOIN holders h ON h.skill_id = d.skill_id AND h.unit_id = d.unit_id
            WHERE 1=1 ${critFilter} ${unitFilter}
            GROUP BY 1, 2
        `;
        const summaryParams = [...params, ...holderParams, ...(unitId ? [unitId] : [])];
        const summaryRows = await db.all(summarySql, summaryParams);

        const bandFilter = band === 'all' ? '' : `AND ${bandExpr} = ?`;
        const rowsSql = `
            WITH demand AS (${demandSql}), holders AS (${holderSql})
            SELECT d.skill_id                        AS "skillId",
                   sk.name                           AS "skillName",
                   dom.name                          AS "domainName",
                   d.unit_id                         AS "unitId",
                   d.unit_name                       AS "unitName",
                   d.required_level                  AS "requiredLevel",
                   d.is_critical                     AS "isCritical",
                   d.required_of                     AS "requiredOf",
                   d.role_criticality                AS "roleCriticality",
                   COALESCE(h.measured, 0)           AS "measured",
                   COALESCE(h.qualified, 0)          AS "qualified",
                   COALESCE(h.blocked_by_cert, 0)    AS "blockedByCert",
                   h.holder_names                    AS "holderNames",
                   h.holder_ids                      AS "holderIds",
                   h.holder_roles                    AS "holderRoles",
                   ${bandExpr}                       AS "band"
            FROM demand d
            JOIN skills sk   ON sk.id = d.skill_id
            LEFT JOIN domains dom ON dom.id = sk.domain_id
            LEFT JOIN holders h ON h.skill_id = d.skill_id AND h.unit_id = d.unit_id
            WHERE 1=1 ${critFilter} ${unitFilter} ${bandFilter}
            ORDER BY d.is_critical DESC, d.role_criticality DESC, d.required_of DESC, sk.name
            LIMIT ${limit}
        `;
        const rowsParams = [
            ...params,
            ...holderParams,
            ...(unitId ? [unitId] : []),
            ...(band === 'all' ? [] : [band]),
        ];
        const rows = await db.all(rowsSql, rowsParams);

        return {
            rows: rows.map((r) => this._shape(r)),
            summary: this._summarise(summaryRows),
            scope,
        };
    },

    /**
     * Org-unit rollup of the sweep — one row per unit with its exposure counts.
     * Feeds the per-site scorecard, so it uses the same band arithmetic and can
     * never disagree with the detail table.
     */
    async exposureByUnit(user, opts = {}) {
        const unitKey = resolveUnitKey(opts.unit);
        const { rows } = await this.sweep(user, {
            unit: unitKey,
            band: 'all',
            criticalOnly: Boolean(opts.criticalOnly),
            limit: 1000,
        });
        const byUnit = new Map();
        for (const r of rows) {
            const key = String(r.unitId);
            if (!byUnit.has(key)) {
                byUnit.set(key, {
                    unitId: r.unitId,
                    unitName: r.unitName,
                    soleHolder: 0,
                    noQualified: 0,
                    neverMeasured: 0,
                    covered: 0,
                    criticalSoleHolder: 0,
                });
            }
            const u = byUnit.get(key);
            if (r.band === 'sole_holder') {
                u.soleHolder++;
                if (r.isCritical) u.criticalSoleHolder++;
            } else if (r.band === 'no_qualified') u.noQualified++;
            else if (r.band === 'never_measured') u.neverMeasured++;
            else u.covered++;
        }
        return [...byUnit.values()].sort((a, b) =>
            String(a.unitName || '').localeCompare(String(b.unitName || ''))
        );
    },

    // ---- internals ---------------------------------------------------------

    _shape(r) {
        // pg returns text[]/bigint[] for the array_agg columns; normalise to a
        // plain array of {id, name, role} so the view never indexes in parallel.
        const names = Array.isArray(r.holderNames) ? r.holderNames : [];
        const hids = Array.isArray(r.holderIds) ? r.holderIds : [];
        const hroles = Array.isArray(r.holderRoles) ? r.holderRoles : [];
        return {
            skillId: Number(r.skillId),
            skillName: r.skillName,
            domainName: r.domainName || null,
            unitId: Number(r.unitId),
            unitName: r.unitName,
            requiredLevel: Number(r.requiredLevel),
            isCritical: Boolean(r.isCritical),
            requiredOf: Number(r.requiredOf) || 0,
            roleCriticality: Number(r.roleCriticality) || 0,
            measured: Number(r.measured) || 0,
            qualified: Number(r.qualified) || 0,
            blockedByCert: Number(r.blockedByCert) || 0,
            band: r.band,
            holders: names.map((n, i) => ({
                id: hids[i] != null ? Number(hids[i]) : null,
                name: n,
                roleName: hroles[i] || null,
            })),
        };
    },

    _emptySummary() {
        return {
            soleHolder: 0,
            noQualified: 0,
            neverMeasured: 0,
            covered: 0,
            criticalSoleHolder: 0,
            criticalNeverMeasured: 0,
            total: 0,
        };
    },

    _summarise(rows) {
        const s = this._emptySummary();
        for (const r of rows || []) {
            const n = Number(r.n) || 0;
            const crit = r.isCritical === true || r.is_critical === true;
            s.total += n;
            if (r.band === 'sole_holder') {
                s.soleHolder += n;
                if (crit) s.criticalSoleHolder += n;
            } else if (r.band === 'no_qualified') s.noQualified += n;
            else if (r.band === 'never_measured') {
                s.neverMeasured += n;
                if (crit) s.criticalNeverMeasured += n;
            } else s.covered += n;
        }
        return s;
    },
};

module.exports = KeyPersonRiskService;
