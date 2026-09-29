'use strict';

/**
 * CoverageService — position-coverage compliance ("safe-shift" rules,
 * migration 56): "org unit X must always have >= N people at level >= L in
 * skill S (optionally holding a valid certification)".
 *
 * Evaluation is entirely in SQL (v_coverage_status) so it is always live
 * against active headcount + resolved levels + current certifications.
 * The coverage-check job persists each evaluation onto the rule row
 * (last_actual / last_satisfied / breached_since) so breach TRANSITIONS
 * are detected and alerted exactly once.
 *
 * Visibility ("scope before aggregate" applied to rules): a rule is visible
 * to a caller when every org unit it names belongs to the caller's visible
 * employees' units. Company-wide rules (no org filter) are visible only to
 * unrestricted callers (SuperAdmin) — a scoped admin/manager cannot infer
 * anything about units outside their scope.
 */

const db = require('../config/database');

/**
 * The competency scale is 0-4 — `skill_assessments.current_level` carries a CHECK
 * for exactly that. Coverage rules accepted 1-5, so a rule written at "level >= 5"
 * could never be satisfied by anybody: a permanent, inextinguishable critical
 * breach that alerts once and then sits on /compliance forever, while people are
 * sent to training for a threshold that does not exist. The bulk generator can
 * create hundreds of rules in one action, so the mistake scales.
 *
 * 4 is the top of the scale; 0 means "no requirement", which is not a coverage
 * rule, so the floor stays 1.
 */
const COVERAGE_LEVEL_MIN = 1;
const COVERAGE_LEVEL_MAX = 4;
function clampCoverageLevel(v) {
    const n = parseInt(v, 10);
    return Math.min(
        Math.max(Number.isFinite(n) ? n : COVERAGE_LEVEL_MIN, COVERAGE_LEVEL_MIN),
        COVERAGE_LEVEL_MAX
    );
}

class CoverageService {
    static async createRule(
        {
            name,
            siteId = null,
            departmentId = null,
            serviceId = null,
            skillId,
            minLevel = 1,
            minHeadcount,
            requireValidCert = false,
            severity = 'critical',
        },
        adminId = null
    ) {
        if (!name || !skillId || !minHeadcount)
            throw new Error('name, skillId and minHeadcount are required');
        if (!['critical', 'warning'].includes(severity)) severity = 'critical';
        return db.get(
            `INSERT INTO coverage_rules
                (name, site_id, department_id, service_id, skill_id, min_level,
                 min_headcount, require_valid_cert, severity, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`,
            [
                String(name).trim(),
                siteId || null,
                departmentId || null,
                serviceId || null,
                skillId,
                clampCoverageLevel(minLevel),
                Math.max(parseInt(minHeadcount, 10) || 1, 1),
                !!requireValidCert,
                severity,
                adminId,
            ]
        );
    }

    /**
     * Bulk rule generation.
     *
     * Authoring safe-shift rules one form at a time is why this instance has ZERO
     * of them despite the engine being the highest-value module here: 9 sites x
     * 10 departments x the critical skills of each is hours of identical typing.
     * This generates the whole grid in one pass, following the same
     * dry-run-then-commit pattern as the certification policy seeder.
     *
     * @param spec.skillIds     explicit skills, OR
     * @param spec.domainId     every skill of a pillar/domain
     * @param spec.scope        'site' | 'department' | 'company'
     * @param spec.minLevel     required proficiency (1..5)
     * @param spec.minHeadcount how many qualified people per unit
     * @param spec.requireValidCert / spec.severity
     * @param spec.onlyWhereStaffed  skip units with nobody in them (default true) -
     *        generating a rule for an empty unit creates a permanent false breach.
     * @param commit            false = preview only, nothing is written
     * @returns {{planned:Array, plannedCount:number, immediateBreaches:number,
     *            created:number, skipped:number, committed:boolean, cap:number}}
     *
     * The preview now EVALUATES the plan before writing it: each planned rule
     * carries the headcount that would qualify today and whether it would be
     * in breach the moment it is created. Generating the full grid used to be a
     * blind act that could create ~2,000 rules, every one of them instantly
     * breached and every one of them an alert; the operator now sees both
     * numbers and has to confirm them (see the route's confirm handshake).
     */
    static async generateRules(spec = {}, adminId = null, commit = false, opts = {}) {
        const minLevel = clampCoverageLevel(spec.minLevel);
        const minHeadcount = Math.max(parseInt(spec.minHeadcount, 10) || 1, 1);
        const severity = ['critical', 'warning'].includes(spec.severity)
            ? spec.severity
            : 'critical';
        const requireValidCert = !!spec.requireValidCert;
        const scope = ['site', 'department', 'company'].includes(spec.scope) ? spec.scope : 'site';
        const onlyWhereStaffed = spec.onlyWhereStaffed !== false;

        // --- which skills ---
        let skills = [];
        if (Array.isArray(spec.skillIds) && spec.skillIds.length) {
            const ids = spec.skillIds.map((n) => parseInt(n, 10)).filter(Number.isFinite);
            if (ids.length) {
                skills = await db.all(
                    `SELECT id, name FROM skills WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
                    ids
                );
            }
        } else if (spec.domainId) {
            skills = await db.all('SELECT id, name FROM skills WHERE domain_id = ? ORDER BY name', [
                parseInt(spec.domainId, 10),
            ]);
        }
        if (!skills.length) throw new Error('select at least one skill (or a domain)');

        // --- which org units ---
        let units = [];
        if (scope === 'company') {
            units = [{ siteId: null, departmentId: null, label: 'Company-wide' }];
        } else if (scope === 'site') {
            units = (await db.all('SELECT id, name FROM sites ORDER BY name')).map((s) => ({
                siteId: s.id,
                departmentId: null,
                label: s.name,
            }));
        } else {
            units = (
                await db.all(
                    `SELECT d.id, d.name, s.id AS "siteId", s.name AS "siteName"
                 FROM departments d LEFT JOIN sites s ON s.id = d.site_id ORDER BY s.name, d.name`
                )
            ).map((d) => ({
                siteId: d.siteId,
                departmentId: d.id,
                label: `${d.name} (${d.siteName || '-'})`,
            }));
        }

        // --- the caller's scope (3.23.17, B-5) ---
        // `opts.actor` is the signed-in user. A scoped caller may only plan (and
        // preview — a preview names units and their headcounts) rules for units
        // they are allowed to SEE, by the same predicate status applies:
        // every unit the rule names is theirs, and they govern it ENTIRELY.
        // Company-wide rules stay SuperAdmin-only. Out-of-scope units are
        // dropped before anything is counted, so the preview discloses nothing
        // about them.
        if (opts && opts.actor) {
            const { scopedEmployeeIds } = require('../utils/rbacScope');
            const ids = await scopedEmployeeIds(opts.actor);
            if (ids !== null) {
                units = await CoverageService._unitsWithinScope(units, ids);
            }
        }

        // --- headcount per unit, to avoid rules on empty units ---
        const staffed = new Map();
        if (onlyWhereStaffed && scope !== 'company') {
            const col = scope === 'site' ? 'site_id' : 'department_id';
            for (const r of await db.all(
                `SELECT ${col} AS "unitId", COUNT(*) AS "n" FROM employees
                 WHERE is_active = true AND ${col} IS NOT NULL GROUP BY ${col}`
            )) {
                staffed.set(Number(r.unitId), Number(r.n));
            }
        }

        // --- existing rules, so re-running is safe (idempotent) ---
        const existing = new Set(
            (
                await db.all(
                    'SELECT site_id AS "s", department_id AS "d", skill_id AS "k", min_level AS "l" FROM coverage_rules'
                )
            ).map((r) => `${r.s ?? ''}|${r.d ?? ''}|${r.k}|${r.l}`)
        );

        const planned = [];
        let skipped = 0;
        for (const u of units) {
            if (onlyWhereStaffed && scope !== 'company') {
                const unitId = scope === 'site' ? u.siteId : u.departmentId;
                if (!staffed.get(Number(unitId))) {
                    skipped += skills.length;
                    continue;
                }
            }
            for (const sk of skills) {
                const key = `${u.siteId ?? ''}|${u.departmentId ?? ''}|${sk.id}|${minLevel}`;
                if (existing.has(key)) {
                    skipped++;
                    continue;
                }
                planned.push({
                    name: `${sk.name} >= L${minLevel} x${minHeadcount} - ${u.label}`,
                    siteId: u.siteId,
                    departmentId: u.departmentId,
                    serviceId: null,
                    skillId: sk.id,
                    skillName: sk.name,
                    unitLabel: u.label,
                    minLevel,
                    minHeadcount,
                    requireValidCert,
                    severity,
                });
            }
        }

        // --- evaluate the plan BEFORE writing it: how many of these rules would
        //     be in breach the instant they exist? A generated grid of instantly
        //     breached rules is a pager storm, not a compliance programme.
        const qualified = await CoverageService._qualifiedForPlan(planned, {
            scope,
            minLevel,
            requireValidCert,
        });
        let immediateBreaches = 0;
        for (const p of planned) {
            const unitId =
                scope === 'site' ? p.siteId : scope === 'department' ? p.departmentId : null;
            p.qualifiedNow = qualified.get(`${unitId ?? ''}|${p.skillId}`) || 0;
            p.wouldBreach = p.qualifiedNow < p.minHeadcount;
            if (p.wouldBreach) immediateBreaches++;
        }

        const cap = CoverageService.MAX_RULES_PER_GENERATION;
        if (!commit) {
            return {
                planned,
                plannedCount: planned.length,
                immediateBreaches,
                created: 0,
                skipped,
                committed: false,
                cap,
            };
        }
        if (planned.length > cap) {
            const e = new Error(`too_many_rules:${planned.length}:${cap}`);
            e.code = 'too_many_rules';
            e.plannedCount = planned.length;
            e.cap = cap;
            throw e;
        }

        let created = 0;
        for (const p of planned) {
            await CoverageService.createRule(p, adminId);
            created++;
        }
        return {
            planned,
            plannedCount: planned.length,
            immediateBreaches,
            created,
            skipped,
            committed: true,
            cap,
        };
    }

    /**
     * Hard ceiling on ONE generation run. Nine sites x ten departments x a
     * whole pillar of skills is thousands of rules; past this the operator must
     * narrow the domain or the scope. Overridable per-instance, never unbounded.
     */
    static get MAX_RULES_PER_GENERATION() {
        const n = parseInt(process.env.COVERAGE_GENERATE_MAX || '400', 10);
        return Number.isFinite(n) && n > 0 ? n : 400;
    }

    /**
     * Qualified headcount TODAY for every (unit, skill) pair in a plan, keyed
     * "<scope unit id or empty>|<skillId>". Mirrors v_coverage_status's
     * definition of "qualified" so the preview number and the number the rule
     * reports an hour later are the same number.
     */
    static async _qualifiedForPlan(planned, { scope, minLevel, requireValidCert }) {
        const out = new Map();
        if (!planned.length) return out;
        const skillIds = [...new Set(planned.map((p) => Number(p.skillId)))];
        const certSql = requireValidCert
            ? `AND EXISTS (SELECT 1 FROM v_certification_current cc
                            WHERE cc.employee_id = ed.employee_id AND cc.skill_id = ra.skill_id
                              AND cc.cert_status IN ('valid', 'expiring', 'no_expiry'))`
            : '';
        const ph = skillIds.map(() => '?').join(',');

        if (scope === 'company') {
            const rows = await db.all(
                `SELECT ra.skill_id AS "skillId", COUNT(DISTINCT ed.employee_id)::int AS "n"
                   FROM v_employee_details ed
                   JOIN v_resolved_assessments ra
                     ON ra.employee_id = ed.employee_id AND ra.level >= ?
                  WHERE ra.skill_id IN (${ph}) ${certSql}
                  GROUP BY ra.skill_id`,
                [minLevel, ...skillIds]
            );
            for (const r of rows) out.set(`|${Number(r.skillId)}`, Number(r.n));
            return out;
        }

        const col = scope === 'site' ? 'site_id' : 'department_id';
        const rows = await db.all(
            `SELECT ed.${col} AS "unitId", ra.skill_id AS "skillId",
                    COUNT(DISTINCT ed.employee_id)::int AS "n"
               FROM v_employee_details ed
               JOIN v_resolved_assessments ra
                 ON ra.employee_id = ed.employee_id AND ra.level >= ?
              WHERE ra.skill_id IN (${ph}) AND ed.${col} IS NOT NULL ${certSql}
              GROUP BY ed.${col}, ra.skill_id`,
            [minLevel, ...skillIds]
        );
        for (const r of rows) out.set(`${Number(r.unitId)}|${Number(r.skillId)}`, Number(r.n));
        return out;
    }

    static async setActive(ruleId, active) {
        return db.get(
            'UPDATE coverage_rules SET is_active = ?, updated_at = now() WHERE id = ? RETURNING *',
            [!!active, ruleId]
        );
    }

    /** One rule with its org labels — for the delete route's scope check + audit. */
    static async findRule(ruleId) {
        return db.get(
            `SELECT r.*, s.name AS "skillName", st.name AS "siteName",
                    d.name AS "departmentName", sv.name AS "serviceName"
               FROM coverage_rules r
               JOIN skills s ON s.id = r.skill_id
               LEFT JOIN sites st      ON st.id = r.site_id
               LEFT JOIN departments d ON d.id  = r.department_id
               LEFT JOIN services sv   ON sv.id = r.service_id
              WHERE r.id = ?`,
            [ruleId]
        );
    }

    static async deleteRule(ruleId) {
        return db.run('DELETE FROM coverage_rules WHERE id = ?', [ruleId]);
    }

    // ---- Who gets told when a rule breaches --------------------------------

    /**
     * The people who can ACT on a breach, in priority order:
     *
     *   1. the line managers of the breached org unit — a breach on Site A's
     *      electrical crew is Site A's supervisor's problem, not the problem of
     *      whoever happened to author the rule months ago;
     *   2. the rule's creator, when the unit has no manager (or the rule is
     *      company-wide, where a manager fan-out would page everybody);
     *   3. failing both, the admins who hold `manage_compliance`.
     *
     * The last step is what makes "a rule with a null creator alerts nobody"
     * impossible: the audience is never empty while a single compliance-capable
     * admin exists.
     *
     * @returns {Promise<Array<{userType:'employee'|'admin', userId:number, via:string}>>}
     */
    static async alertAudienceFor(rule, { maxManagers = 8 } = {}) {
        const audience = [];
        const scoped = !!(rule.siteId || rule.departmentId || rule.serviceId);

        if (scoped) {
            try {
                const where = [];
                const params = [];
                if (rule.siteId) {
                    where.push('e.site_id = ?');
                    params.push(rule.siteId);
                }
                if (rule.departmentId) {
                    where.push('e.department_id = ?');
                    params.push(rule.departmentId);
                }
                if (rule.serviceId) {
                    where.push('e.service_id = ?');
                    params.push(rule.serviceId);
                }
                params.push(Math.max(1, Math.min(parseInt(maxManagers, 10) || 8, 50)));
                // Ordered by how much of the breached unit each manager actually
                // governs, so a capped fan-out keeps the people most able to act.
                // The EFFECTIVE reviewer of each person in the unit (3.23.18 R2):
                // ACTIVE supervisor → ACTIVE employee-manager → ACTIVE
                // admin-manager. A departed supervisor no longer hides the
                // manager behind them, and an admin manager is reachable.
                const RL = require('./ReportingLineService');
                const rows = await db.all(
                    `SELECT rl.kind AS "userType", rl.id AS "userId", COUNT(*)::int AS "governs"
                       FROM employees e
                       ${RL.effectiveReviewerJoinSql('e', 'rl')}
                      WHERE e.is_active = true AND rl.id IS NOT NULL AND ${where.join(' AND ')}
                      GROUP BY rl.kind, rl.id
                      ORDER BY COUNT(*) DESC, rl.kind, rl.id
                      LIMIT ?`,
                    params
                );
                for (const r of rows)
                    audience.push({
                        userType: r.userType === 'admin' ? 'admin' : 'employee',
                        userId: Number(r.userId),
                        via: 'manager',
                    });
            } catch (e) {
                console.error('[coverage] manager audience lookup failed:', e.message);
            }
        }

        if (!audience.length && rule.createdBy) {
            audience.push({ userType: 'admin', userId: Number(rule.createdBy), via: 'creator' });
        }
        if (!audience.length) {
            try {
                const RBACService = require('./RBACService');
                const ids = await RBACService.adminsWithPermission('manage_compliance');
                for (const id of ids)
                    audience.push({
                        userType: 'admin',
                        userId: Number(id),
                        via: 'manage_compliance',
                    });
            } catch (e) {
                console.error('[coverage] manage_compliance audience lookup failed:', e.message);
            }
        }
        return audience;
    }

    /**
     * Live status of the rules visible to a scope.
     * @param ids  null = unrestricted; array = the caller's visible employee ids.
     */
    static async status(ids) {
        const rows = await db.all(
            'SELECT * FROM v_coverage_status ORDER BY satisfied ASC, severity ASC, name ASC'
        );
        if (ids === null) return rows;
        if (!ids.length) return [];
        const units = await this._unitSetsFor(ids);
        // A rule's headcount figures are aggregated over its WHOLE org unit, so a
        // caller may only see a rule whose unit they govern ENTIRELY. Checking each
        // unit id independently meant a department manager saw a rule scoped to the
        // whole SITE — and its site-wide qualified_headcount — because one of their
        // people happened to work there.
        const whole = await this._whollyGovernedUnits(ids);
        return rows.filter(
            (r) => this._ruleVisible(r, units) && this._ruleUnitFullyGoverned(r, whole)
        );
    }

    /**
     * Org units whose ENTIRE active population is inside `ids`. Anything partially
     * covered is excluded, so the check fails closed.
     */
    static async _whollyGovernedUnits(ids) {
        const ph = ids.map(() => '?').join(',');
        const rows = await db.all(
            `SELECT site_id, department_id, service_id,
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE id IN (${ph}))::int AS mine
               FROM employees
              WHERE is_active = true
              GROUP BY GROUPING SETS ((site_id), (department_id), (service_id))`,
            ids
        );
        const sites = new Set(),
            departments = new Set(),
            services = new Set();
        for (const r of rows) {
            if (Number(r.total) === 0 || Number(r.total) !== Number(r.mine)) continue;
            if (r.siteId != null) sites.add(Number(r.siteId));
            else if (r.departmentId != null) departments.add(Number(r.departmentId));
            else if (r.serviceId != null) services.add(Number(r.serviceId));
        }
        return { sites, departments, services };
    }

    /** True when the caller governs every active person the rule's unit covers. */
    static _ruleUnitFullyGoverned(rule, whole) {
        if (rule.serviceId) return whole.services.has(Number(rule.serviceId));
        if (rule.departmentId) return whole.departments.has(Number(rule.departmentId));
        if (rule.siteId) return whole.sites.has(Number(rule.siteId));
        return false; // company-wide rules stay superadmin-only
    }

    /** Org-unit id sets covered by a list of employee ids. */
    static async _unitSetsFor(ids) {
        const ph = ids.map(() => '?').join(',');
        const rows = await db.all(
            `SELECT DISTINCT site_id, department_id, service_id FROM employees WHERE id IN (${ph})`,
            ids
        );
        return {
            sites: new Set(rows.map((r) => Number(r.siteId))),
            departments: new Set(rows.map((r) => Number(r.departmentId))),
            services: new Set(rows.map((r) => Number(r.serviceId))),
        };
    }

    /**
     * May a caller whose visible employees are `ids` author a rule on this org
     * unit? Same predicate as status visibility — never let someone create a
     * rule they would not be allowed to see. `ids === null` = unrestricted.
     */
    static async ruleWithinScope(rule, ids) {
        if (ids === null) return true;
        if (!Array.isArray(ids) || !ids.length) return false;
        const units = await this._unitSetsFor(ids);
        const whole = await this._whollyGovernedUnits(ids);
        return this._ruleVisible(rule, units) && this._ruleUnitFullyGoverned(rule, whole);
    }

    /** Filter generator units down to those within the scope of `ids`. */
    static async _unitsWithinScope(unitsIn, ids) {
        if (!Array.isArray(ids) || !ids.length) return [];
        const units = await this._unitSetsFor(ids);
        const whole = await this._whollyGovernedUnits(ids);
        return unitsIn.filter((u) => {
            const r = { siteId: u.siteId, departmentId: u.departmentId, serviceId: null };
            return this._ruleVisible(r, units) && this._ruleUnitFullyGoverned(r, whole);
        });
    }

    static _ruleVisible(rule, units) {
        // Company-wide rule (no org filter): scoped callers don't see it.
        if (!rule.siteId && !rule.departmentId && !rule.serviceId) return false;
        if (rule.siteId && !units.sites.has(Number(rule.siteId))) return false;
        if (rule.departmentId && !units.departments.has(Number(rule.departmentId))) return false;
        if (rule.serviceId && !units.services.has(Number(rule.serviceId))) return false;
        return true;
    }

    // ---- Planned absences (migration 58) -----------------------------------

    static async addAbsence(
        { employeeId, startsOn, endsOn, kind = 'leave', note = null },
        adminId = null
    ) {
        if (!employeeId || !startsOn || !endsOn)
            throw new Error('employeeId, startsOn and endsOn are required');
        if (!['leave', 'training', 'mission', 'medical', 'other'].includes(kind)) kind = 'other';
        return db.get(
            `INSERT INTO planned_absences (employee_id, starts_on, ends_on, kind, note, created_by)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
            [employeeId, startsOn, endsOn, kind, note, adminId]
        );
    }

    static async deleteAbsence(absenceId) {
        return db.run('DELETE FROM planned_absences WHERE id = ?', [absenceId]);
    }

    /** Upcoming/current absences for the caller's scope (ids: null = all). */
    static async listAbsences(ids, { limit = 200 } = {}) {
        const { scopeClause } = require('../utils/rbacScope');
        const params = [];
        const scope = scopeClause(ids, params, 'pa.employee_id');
        params.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
        return db.all(
            `SELECT pa.id, pa.employee_id AS "employeeId",
                    e.first_name || ' ' || e.last_name AS "employeeName",
                    pa.starts_on AS "startsOn", pa.ends_on AS "endsOn", pa.kind, pa.note
               FROM planned_absences pa
               JOIN employees e ON e.id = pa.employee_id AND e.is_active
              WHERE pa.ends_on >= CURRENT_DATE${scope}
              ORDER BY pa.starts_on ASC
              LIMIT ?`,
            params
        );
    }

    /**
     * PREDICTED coverage (migration 58): project every active rule over the
     * next `horizonDays`, counting only employees who on each day are
     * (a) not inside a planned-absence window and (b) — when the rule
     * requires a certification — still hold one that has not EXPIRED by that
     * day. So a breach is predicted from leave AND from in-horizon
     * certificate expiry.
     *
     * @returns Map ruleId → { firstBreachOn, worstDay, worstQualified } for
     *          rules with a projected breach; rules without one are absent.
     */
    static async predictAll(horizonDays = 14) {
        const days = Math.min(Math.max(parseInt(horizonDays, 10) || 14, 1), 60);
        const rows = await db.all(
            `WITH days AS (SELECT (CURRENT_DATE + i)::date AS day FROM generate_series(1, ?) AS i)
             SELECT r.id AS "ruleId", d.day, r.min_headcount AS "minHeadcount",
                    COALESCE(q.qualified, 0)::int AS qualified
               FROM coverage_rules r
               CROSS JOIN days d
               LEFT JOIN LATERAL (
                   SELECT COUNT(*)::int AS qualified
                     FROM v_employee_details ed
                     JOIN v_resolved_assessments ra
                       ON ra.employee_id = ed.employee_id
                      AND ra.skill_id = r.skill_id
                      AND ra.level >= r.min_level
                    WHERE (r.site_id       IS NULL OR ed.site_id       = r.site_id)
                      AND (r.department_id IS NULL OR ed.department_id = r.department_id)
                      AND (r.service_id    IS NULL OR ed.service_id    = r.service_id)
                      AND NOT EXISTS (
                            SELECT 1 FROM planned_absences pa
                             WHERE pa.employee_id = ed.employee_id
                               AND d.day BETWEEN pa.starts_on AND pa.ends_on)
                      AND (NOT r.require_valid_cert OR EXISTS (
                            SELECT 1 FROM v_certification_current cc
                             WHERE cc.employee_id = ed.employee_id
                               AND cc.skill_id = r.skill_id
                               AND cc.cert_status <> 'expired'
                               AND (cc.expires_on IS NULL OR cc.expires_on > d.day)))
               ) q ON true
              WHERE r.is_active
              ORDER BY r.id, d.day`,
            [days]
        );

        const predictions = new Map();
        for (const r of rows) {
            if (r.qualified >= Number(r.minHeadcount)) continue;
            const day = new Date(r.day).toISOString().slice(0, 10);
            const p = predictions.get(String(r.ruleId));
            if (!p) {
                predictions.set(String(r.ruleId), {
                    firstBreachOn: day,
                    worstDay: day,
                    worstQualified: r.qualified,
                });
            } else {
                if (r.qualified < p.worstQualified) {
                    p.worstQualified = r.qualified;
                    p.worstDay = day;
                }
            }
        }
        return predictions;
    }

    /**
     * Run the prediction, persist the watermark on each rule, and return the
     * rules whose predicted breach APPEARED or moved EARLIER (exactly-once
     * alerting semantics — a stable prediction never re-alerts).
     */
    static async predictAndPersist(horizonDays = 14) {
        const predictions = await this.predictAll(horizonDays);
        const rules = await db.all(
            'SELECT id, name, severity, min_headcount AS "minHeadcount", predicted_breach_on AS "prev", created_by AS "createdBy" FROM coverage_rules WHERE is_active'
        );
        const newlyPredicted = [];
        for (const rule of rules) {
            const p = predictions.get(String(rule.id)) || null;
            const prev = rule.prev ? new Date(rule.prev).toISOString().slice(0, 10) : null;
            await db.run(
                `UPDATE coverage_rules
                    SET predicted_breach_on = ?, predicted_qualified = ?, last_predicted_at = now(), updated_at = now()
                  WHERE id = ?`,
                [p ? p.firstBreachOn : null, p ? p.worstQualified : null, rule.id]
            );
            if (p && (!prev || p.firstBreachOn < prev)) {
                newlyPredicted.push({ ...rule, ...p });
            }
        }
        return { predicted: predictions.size, newlyPredicted };
    }

    /**
     * Evaluate every active rule, persist the result, and return the rules
     * that TRANSITIONED into breach on this pass (for exactly-once alerting).
     * Used by the coverage-check job.
     */
    static async evaluateAll() {
        const rows = await db.all('SELECT * FROM v_coverage_status');
        const newlyBreached = [];
        const recovered = [];
        for (const r of rows) {
            const wasSatisfied = r.lastSatisfied; // may be null on first evaluation
            const isSatisfied = !!r.satisfied;
            await db.run(
                `UPDATE coverage_rules
                    SET last_evaluated_at = now(),
                        last_actual = ?,
                        last_satisfied = ?,
                        breached_since = CASE
                            WHEN ? THEN NULL
                            WHEN breached_since IS NULL THEN now()
                            ELSE breached_since END,
                        updated_at = now()
                  WHERE id = ?`,
                [r.qualifiedHeadcount, isSatisfied, isSatisfied, r.ruleId]
            );
            if (!isSatisfied && wasSatisfied !== false) newlyBreached.push(r);
            if (isSatisfied && wasSatisfied === false) recovered.push(r);
        }
        return { evaluated: rows.length, newlyBreached, recovered };
    }

    /**
     * Put a breach transition's watermark back after the coverage-check job could
     * not deliver its alert. evaluateAll advances last_satisfied on the pass it
     * observes the transition; if the alert send then fails, the transition would
     * never be re-detected and the alert would be lost (exactly-once silently
     * becoming zero-times). Restoring the PRIOR last_satisfied makes the next pass
     * re-detect the breach and retry. breached_since is left as first recorded.
     */
    static async reopenTransition(ruleId, priorSatisfied) {
        const val = priorSatisfied === true ? true : priorSatisfied === false ? false : null;
        await db.run(
            'UPDATE coverage_rules SET last_satisfied = ?, updated_at = now() WHERE id = ?',
            [val, ruleId]
        );
    }

    /**
     * Put a predicted-breach watermark back after an undelivered predicted alert,
     * so predictAndPersist re-detects it next pass instead of the (unchanged)
     * prediction reading as "already alerted". Restores predicted_breach_on to the
     * value it held before this pass advanced it.
     */
    static async reopenPrediction(ruleId, priorPredictedOn) {
        await db.run(
            'UPDATE coverage_rules SET predicted_breach_on = ?, updated_at = now() WHERE id = ?',
            [priorPredictedOn ?? null, ruleId]
        );
    }
}

module.exports = CoverageService;
