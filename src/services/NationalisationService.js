'use strict';

/**
 * NationalisationService — the nationalisation succession plan of the optional
 * local-content module (migration 149).
 *
 * Mining local-content laws (Mali Loi 2023-041, Burkina Faso Loi 017-2024/ALT,
 * Guinea's mining code and 2022 local-content law, Côte d'Ivoire, Senegal Loi
 * 2019-04) require an operator to PLAN the replacement of expatriates by
 * nationals and to PROVE it. One plan = one expatriate-held position (the
 * expatriate incumbent + the role they hold), a target date, named NATIONAL
 * successors, each successor's readiness gap to that role and a link to their
 * IDP.
 *
 * Rules
 *   - "National" is the SAME rule as LocalContentController: the nationality is
 *     resolved to a country through country_aliases (case- and accent-
 *     insensitive) and compared with the OPERATING country (the site's country,
 *     `localContentHomeCountry` as fallback). A blank nationality, or no
 *     operating country, is "unspecified" — never national, never expatriate.
 *   - Readiness comes from ReadinessService (v_resolved_assessments, lapsed
 *     certificates). A successor never assessed has readiness NULL — shown as
 *     "not measured", never as 0 %.
 *   - Status (planned / in_progress / at_risk / overdue / achieved / cancelled)
 *     is COMPUTED from the dates, the successors and their readiness; only the
 *     lifecycle (active → achieved | cancelled) is stored, with reason + actor.
 *   - Nothing is deleted: plans close with a reason, successors are withdrawn
 *     with a reason, every act lands in the append-only event journal.
 *   - Scope: RBACService.scopeFilter (SuperAdmin → organisation). Reading
 *     needs a manager account or an admin holding view_continuity /
 *     manage_succession; writing needs a manager account or manage_succession
 *     (never a viewer). Fails closed.
 */

const db = require('../config/database');
const AppSettingsModel = require('../models/AppSettingsModel');
const RBACService = require('./RBACService');
const ReadinessService = require('./ReadinessService');

/** A plan whose target is this close with nobody ready is "at risk". */
const AT_RISK_HORIZON_DAYS = 180;
const PLAN_CLOSE_STATES = ['achieved', 'cancelled'];

function lcError(code, status, key) {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    e.expose = true;
    e.i18nKey = `localcontent:${key}`;
    return e;
}

/** pg hands a `date` back as a JS Date (local midnight) — normalise to YYYY-MM-DD. */
function ymd(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayYmd(now = new Date()) {
    return ymd(now);
}

function daysBetween(fromYmd, toYmd) {
    const a = Date.UTC(...fromYmd.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
    const b = Date.UTC(...toYmd.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
    return Math.round((b - a) / 86400000);
}

function isYmd(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function actorRef(user) {
    if (!user || user.id == null) return 'system';
    return `${user.userType === 'admin' ? 'admin' : 'employee'}:${Number(user.id)}`;
}

/**
 * The national/expatriate classifier for employees alias `e`, relative to the
 * country expression `countryExpr`. 1 = national, 0 = expatriate, NULL =
 * unspecified. Identical in meaning to LocalContentController's NAT.
 */
function natCase(countryExpr, empAlias = 'e') {
    return `CASE WHEN ${empAlias}.nationality IS NULL OR btrim(${empAlias}.nationality) = '' THEN NULL
                 WHEN ${countryExpr} IS NULL THEN NULL
                 WHEN EXISTS (SELECT 1 FROM country_aliases _ca
                               WHERE _ca.country_id = ${countryExpr}
                                 AND lower(unaccent(_ca.alias)) = lower(unaccent(btrim(${empAlias}.nationality))))
                      THEN 1
                 ELSE 0 END`;
}

/**
 * The displayed status of a plan — a pure function, so the rule is testable and
 * the same everywhere (page, regulator pack).
 *
 * @param {object} p
 * @param {string} p.state        stored lifecycle: active | achieved | cancelled
 * @param {string} p.targetDate   YYYY-MM-DD
 * @param {string} p.today        YYYY-MM-DD
 * @param {Array<{readinessPercent:number|null,isReady:boolean,idpStatus:string|null}>} p.successors
 *        the ACTIVE successors only
 * @returns {{status:string, reason:string|null}}
 */
function computeStatus({ state, targetDate, today, successors }) {
    if (state === 'achieved') return { status: 'achieved', reason: null };
    if (state === 'cancelled') return { status: 'cancelled', reason: null };
    const list = successors || [];
    if (targetDate && today && targetDate < today)
        return { status: 'overdue', reason: 'target_passed' };
    if (!list.length) return { status: 'at_risk', reason: 'no_successor' };
    const anyReady = list.some((s) => s.isReady === true);
    const daysLeft = targetDate && today ? daysBetween(today, targetDate) : null;
    if (!anyReady && daysLeft != null && daysLeft <= AT_RISK_HORIZON_DAYS) {
        const anyMeasured = list.some((s) => s.readinessPercent != null);
        return {
            status: 'at_risk',
            reason: anyMeasured ? 'not_ready_near_target' : 'readiness_not_measured',
        };
    }
    if (anyReady) return { status: 'in_progress', reason: 'successor_ready' };
    if (list.some((s) => s.idpStatus === 'active'))
        return { status: 'in_progress', reason: 'idp_active' };
    const anyMeasured = list.some((s) => s.readinessPercent != null);
    return { status: 'planned', reason: anyMeasured ? null : 'readiness_not_measured' };
}

class NationalisationService {
    // ---- authorisation -----------------------------------------------------

    canView(user) {
        if (!user) return false;
        if (user.userType === 'manager') return true;
        if (user.userType !== 'admin') return false;
        if (RBACService.isSuperAdmin(user)) return true;
        return (
            RBACService.hasPermission(user, 'view_continuity') ||
            RBACService.hasPermission(user, 'manage_succession')
        );
    }

    canWrite(user) {
        if (!user) return false;
        if (user.userType === 'manager') return true;
        if (user.userType !== 'admin') return false;
        if (RBACService.isViewer(user)) return false;
        if (RBACService.isSuperAdmin(user)) return true;
        return RBACService.hasPermission(user, 'manage_succession');
    }

    _assertView(user) {
        if (!this.canView(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
    }

    _assertWrite(user) {
        if (!this.canWrite(user)) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
    }

    /** `{clause, params}` restricting employees alias `alias` to the caller's scope. */
    async _scope(user, alias) {
        return RBACService.scopeFilter(user, { empAlias: alias });
    }

    async _inScope(user, employeeId, alias = 'e') {
        const sc = await this._scope(user, alias);
        const row = await db.get(
            `SELECT ${alias}.id FROM employees ${alias} WHERE ${alias}.id = ?${sc.clause}`,
            [Number(employeeId), ...sc.params]
        );
        return !!row;
    }

    // ---- the national rule ---------------------------------------------------

    /** `localContentHomeCountry` → country id (same resolution as the report). */
    async homeCountryId() {
        const home = String(
            (await AppSettingsModel.getValue('localContentHomeCountry', '')) || ''
        ).trim();
        if (!home) return null;
        const row = await db.get(
            `SELECT c.id FROM countries c
               JOIN country_aliases ca ON ca.country_id = c.id
              WHERE lower(unaccent(ca.alias)) = lower(unaccent(?))
              ORDER BY c.id LIMIT 1`,
            [home]
        );
        return row ? Number(row.id) : null;
    }

    /**
     * One employee's standing: operating country, role, and whether they are
     * national (1), expatriate (0) or unspecified (null) there.
     */
    async classify(employeeId, homeCountryId = undefined) {
        const hc = homeCountryId === undefined ? await this.homeCountryId() : homeCountryId;
        return db.get(
            `SELECT e.id, e.role_id, e.site_id, e.is_active, e.nationality,
                    e.first_name || ' ' || e.last_name AS name,
                    COALESCE(_co.id, _hc.id) AS operating_country_id,
                    ${natCase('COALESCE(_co.id, _hc.id)')} AS is_national
               FROM employees e
               LEFT JOIN sites _st ON _st.id = e.site_id
               LEFT JOIN countries _co ON _co.id = _st.country_id
               LEFT JOIN countries _hc ON _hc.id = ?
              WHERE e.id = ?`,
            [hc, Number(employeeId)]
        );
    }

    /** Is this person a national OF THIS COUNTRY (1/0/null)? */
    async nationalOf(employeeId, countryId) {
        const row = await db.get(
            `SELECT ${natCase('?::bigint')} AS is_national FROM employees e WHERE e.id = ?`,
            [countryId, countryId, Number(employeeId)]
        );
        return row ? (row.isNational == null ? null : Number(row.isNational)) : null;
    }

    // ---- reads ---------------------------------------------------------------

    /** Load one plan row (no scope check). */
    async _plan(planId) {
        const p = await db.get(
            `SELECT p.id, p.role_id, p.incumbent_employee_id, p.country_id, p.target_date,
                    p.state, p.state_reason, p.notes
               FROM lc_nationalisation_plans p WHERE p.id = ?`,
            [Number(planId)]
        );
        if (!p) throw lcError('LC_PLAN_NOT_FOUND', 404, 'err_plan_not_found');
        return p;
    }

    async _assertPlanInScope(user, plan) {
        if (!(await this._inScope(user, plan.incumbentEmployeeId))) {
            throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        }
    }

    /**
     * Readiness of each successor TO THE PLAN'S ROLE (not their own role),
     * through ReadinessService — the one readiness rule.
     */
    async _readiness(roleId, employeeIds) {
        const ids = [...new Set((employeeIds || []).map(Number).filter(Boolean))];
        if (!ids.length) return {};
        return ReadinessService.calculateReadinessMap(
            ids.map((id) => ({ id, roleId: Number(roleId) }))
        );
    }

    /**
     * Plans visible to the caller, each with its successors, their readiness gap
     * to the role, their IDP, and the computed status.
     * `opts.countryId` restricts to one country (the regulator pack); `opts.bypassScope`
     * is for the pack builder, whose caller has already been cleared for the country.
     */
    async listPlans(user, opts = {}) {
        if (!opts.bypassScope) this._assertView(user);
        const params = [];
        let where = 'WHERE 1 = 1';
        if (opts.countryId != null) {
            where += ' AND p.country_id = ?';
            params.push(Number(opts.countryId));
        }
        if (!opts.bypassScope) {
            const sc = await this._scope(user, 'ie');
            where += sc.clause;
            params.push(...sc.params);
        }
        const plans = await db.all(
            `SELECT p.id, p.role_id, p.incumbent_employee_id, p.country_id, p.target_date,
                    p.state, p.state_reason, p.state_changed_at, p.notes, p.created_at,
                    r.name AS role_name, rf.name AS role_family_name,
                    ie.first_name || ' ' || ie.last_name AS incumbent_name,
                    ie.nationality AS incumbent_nationality,
                    ie.is_active AS incumbent_active, ie.role_id AS incumbent_role_id,
                    s.name AS site_name, c.name AS country_name, c.code AS country_code
               FROM lc_nationalisation_plans p
               JOIN roles r ON r.id = p.role_id
               LEFT JOIN role_families rf ON rf.id = r.role_family_id
               JOIN employees ie ON ie.id = p.incumbent_employee_id
               LEFT JOIN sites s ON s.id = ie.site_id
               LEFT JOIN countries c ON c.id = p.country_id
               ${where}
              ORDER BY (p.state = 'active') DESC, p.target_date, p.id`,
            params
        );
        if (!plans.length) return [];

        const planIds = plans.map((p) => Number(p.id));
        const succ = await db.all(
            `SELECT ns.id, ns.plan_id, ns.employee_id, ns.idp_id, ns.state, ns.state_reason,
                    ns.added_at, e.first_name || ' ' || e.last_name AS name,
                    e.is_active AS employee_active,
                    ip.status::text AS idp_status
               FROM lc_nationalisation_successors ns
               JOIN employees e ON e.id = ns.employee_id
               LEFT JOIN idp_plans ip ON ip.id = ns.idp_id
              WHERE ns.plan_id IN (${planIds.map(() => '?').join(',')})
              ORDER BY ns.added_at, ns.id`,
            planIds
        );

        // Successors outside the reader's scope stay counted but are not named.
        let visible = null;
        if (!opts.bypassScope && !RBACService.isSuperAdmin(user)) {
            const ids = [...new Set(succ.map((s) => Number(s.employeeId)))];
            visible = new Set();
            if (ids.length) {
                const sc = await this._scope(user, 'e');
                const rows = await db.all(
                    `SELECT e.id FROM employees e WHERE e.id IN (${ids.map(() => '?').join(',')})${sc.clause}`,
                    [...ids, ...sc.params]
                );
                rows.forEach((r) => visible.add(Number(r.id)));
            }
        }

        const today = opts.today || todayYmd();
        const out = [];
        for (const p of plans) {
            const mine = succ.filter((s) => Number(s.planId) === Number(p.id));
            // F2 (3.23.21): a named successor who has LEFT the company is never
            // counted — not in the status, the readiness, the successor count nor
            // the regulator pack — and the plan is flagged for a human decision.
            const counted = (s) => s.state === 'active' && s.employeeActive !== false;
            const active = mine.filter(counted);
            const rmap = await this._readiness(
                p.roleId,
                active.map((s) => s.employeeId)
            );
            const successors = mine.map((s) => {
                const r = counted(s) ? rmap[Number(s.employeeId)] : null;
                const inView = visible == null || visible.has(Number(s.employeeId));
                const gaps = r ? r.gaps || [] : [];
                return {
                    id: Number(s.id),
                    employeeId: inView ? Number(s.employeeId) : null,
                    name: inView ? s.name : null,
                    outOfScope: !inView,
                    state: s.state,
                    // Still 'active' on the plan but no longer in the company.
                    left: s.state === 'active' && s.employeeActive === false,
                    counted: counted(s),
                    stateReason: s.stateReason,
                    idpId: s.idpId != null && inView ? Number(s.idpId) : null,
                    idpStatus: s.idpStatus || null,
                    // Readiness gap to the plan's role. NULL = not measured.
                    readinessPercent: r ? r.readinessPercent : null,
                    coveragePercent: r ? r.coveragePercent : null,
                    isReady: r ? r.isReady === true : false,
                    totalRequired: r ? r.totalRequired : null,
                    gapsMeasured: r ? gaps.filter((g) => g.isAssessed).length : null,
                    gapsUnmeasured: r ? r.neverAssessedRequired : null,
                };
            });
            const activeView = successors.filter((s) => s.counted);
            // Leaver / mover cascade: facts that make the plan need a human
            // decision (re-scope, close, name another successor). Computed from
            // the live records, so it can never be stale.
            const flags = [];
            if (p.state === 'active') {
                if (p.incumbentActive === false) flags.push('incumbent_left');
                else if (
                    p.incumbentRoleId == null ||
                    Number(p.incumbentRoleId) !== Number(p.roleId)
                )
                    flags.push('incumbent_role_changed');
                if (successors.some((s) => s.left)) flags.push('successor_left');
            }
            const st = computeStatus({
                state: p.state,
                targetDate: ymd(p.targetDate),
                today,
                successors: activeView,
            });
            const measured = activeView.filter((s) => s.readinessPercent != null);
            out.push({
                id: Number(p.id),
                roleId: Number(p.roleId),
                roleName: p.roleName,
                roleFamilyName: p.roleFamilyName || null,
                incumbentEmployeeId: Number(p.incumbentEmployeeId),
                incumbentName: p.incumbentName,
                incumbentNationality: p.incumbentNationality,
                siteName: p.siteName || null,
                countryId: p.countryId != null ? Number(p.countryId) : null,
                countryName: p.countryName || null,
                countryCode: p.countryCode || null,
                targetDate: ymd(p.targetDate),
                state: p.state,
                stateReason: p.stateReason,
                stateChangedAt: p.stateChangedAt || null,
                notes: p.notes,
                status: st.status,
                statusReason: st.reason,
                flags,
                needsDecision: flags.length > 0,
                successors,
                activeSuccessorCount: activeView.length,
                // Best MEASURED readiness; null when no successor was ever assessed.
                bestReadinessPercent: measured.length
                    ? Math.max(...measured.map((s) => Number(s.readinessPercent)))
                    : null,
                idpLinkedCount: activeView.filter((s) => s.idpId != null || s.idpStatus).length,
            });
        }
        return out;
    }

    /**
     * Expatriate-held positions in the caller's scope that have NO active plan —
     * the "to plan" list the Nationalisation tab offers.
     */
    async unplannedExpatPositions(user) {
        this._assertView(user);
        const hc = await this.homeCountryId();
        const sc = await this._scope(user, 'e');
        return db.all(
            `SELECT e.id AS employee_id, e.first_name || ' ' || e.last_name AS name,
                    e.nationality, r.id AS role_id, r.name AS role_name,
                    _st.name AS site_name, _co.name AS country_name
               FROM employees e
               LEFT JOIN sites _st ON _st.id = e.site_id
               LEFT JOIN countries _co ON _co.id = _st.country_id
               LEFT JOIN countries _hc ON _hc.id = ?
               JOIN roles r ON r.id = e.role_id
              WHERE e.is_active = true
                AND ${natCase('COALESCE(_co.id, _hc.id)')} = 0
                AND NOT EXISTS (SELECT 1 FROM lc_nationalisation_plans p
                                 WHERE p.incumbent_employee_id = e.id AND p.role_id = e.role_id
                                   AND p.state = 'active')${sc.clause}
              ORDER BY _co.name NULLS LAST, _st.name, r.name`,
            [hc, ...sc.params]
        );
    }

    /** Candidate national successors for a plan (in scope, national of the plan's country). */
    async candidateSuccessors(user, planId) {
        this._assertView(user);
        const plan = await this._plan(planId);
        await this._assertPlanInScope(user, plan);
        if (plan.countryId == null) return [];
        const sc = await this._scope(user, 'e');
        return db.all(
            `SELECT e.id, e.first_name || ' ' || e.last_name AS name, r.name AS role_name
               FROM employees e
               LEFT JOIN roles r ON r.id = e.role_id
              WHERE e.is_active = true AND e.id <> ?
                AND ${natCase('?::bigint')} = 1
                AND NOT EXISTS (SELECT 1 FROM lc_nationalisation_successors ns
                                 WHERE ns.plan_id = ? AND ns.employee_id = e.id AND ns.state = 'active')${sc.clause}
              ORDER BY e.last_name, e.first_name
              LIMIT 500`,
            [
                Number(plan.incumbentEmployeeId),
                plan.countryId,
                plan.countryId,
                Number(plan.id),
                ...sc.params,
            ]
        );
    }

    // ---- writes --------------------------------------------------------------

    async _event(planId, successorId, action, reason, details, user) {
        await db.run(
            `INSERT INTO lc_nationalisation_events (plan_id, successor_id, action, reason, details, actor_ref)
             VALUES (?, ?, ?, ?, ?::jsonb, ?)`,
            [
                Number(planId),
                successorId != null ? Number(successorId) : null,
                action,
                reason || null,
                details ? JSON.stringify(details) : null,
                actorRef(user),
            ]
        );
    }

    /**
     * Open a nationalisation plan for an expatriate-held position.
     * @returns {Promise<{id:number}>}
     */
    async createPlan(user, { incumbentEmployeeId, targetDate, notes = null }) {
        this._assertWrite(user);
        if (!isYmd(targetDate)) throw lcError('LC_BAD_DATE', 400, 'err_bad_date');
        const inc = await this.classify(incumbentEmployeeId);
        if (!inc || !inc.isActive)
            throw lcError('LC_EMPLOYEE_NOT_FOUND', 404, 'err_employee_not_found');
        if (!(await this._inScope(user, inc.id)))
            throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        if (inc.roleId == null) throw lcError('LC_NO_ROLE', 400, 'err_no_role');
        // Only an EXPATRIATE-held position can be nationalised. An unspecified
        // nationality is refused, not guessed: record it first.
        if (inc.isNational == null)
            throw lcError('LC_NATIONALITY_UNKNOWN', 400, 'err_nationality_unknown');
        if (Number(inc.isNational) !== 0)
            throw lcError('LC_NOT_EXPATRIATE', 400, 'err_not_expatriate');
        const existing = await db.get(
            `SELECT id FROM lc_nationalisation_plans
              WHERE incumbent_employee_id = ? AND role_id = ? AND state = 'active'`,
            [Number(inc.id), Number(inc.roleId)]
        );
        if (existing) throw lcError('LC_PLAN_EXISTS', 409, 'err_plan_exists');
        let id = null;
        try {
            await db.runTransaction(async () => {
                const r = await db.run(
                    `INSERT INTO lc_nationalisation_plans
                        (role_id, incumbent_employee_id, country_id, target_date, notes, created_by_ref)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        Number(inc.roleId),
                        Number(inc.id),
                        inc.operatingCountryId != null ? Number(inc.operatingCountryId) : null,
                        targetDate,
                        notes ? String(notes).slice(0, 2000) : null,
                        actorRef(user),
                    ]
                );
                id = r.lastID;
                await this._event(id, null, 'plan.created', null, { targetDate }, user);
            });
        } catch (e) {
            if (e && e.code === '23505') throw lcError('LC_PLAN_EXISTS', 409, 'err_plan_exists');
            throw e;
        }
        return { id };
    }

    /** Move the target date — with a reason, journaled. */
    async setTargetDate(user, planId, targetDate, reason) {
        this._assertWrite(user);
        if (!isYmd(targetDate)) throw lcError('LC_BAD_DATE', 400, 'err_bad_date');
        const why = String(reason || '').trim();
        if (!why) throw lcError('LC_REASON_REQUIRED', 400, 'err_reason_required');
        const plan = await this._plan(planId);
        await this._assertPlanInScope(user, plan);
        if (plan.state !== 'active') throw lcError('LC_PLAN_CLOSED', 409, 'err_plan_closed');
        await db.runTransaction(async () => {
            await db.run(
                `UPDATE lc_nationalisation_plans SET target_date = ?, updated_at = now() WHERE id = ?`,
                [targetDate, Number(plan.id)]
            );
            await this._event(
                plan.id,
                null,
                'plan.target_moved',
                why,
                { from: ymd(plan.targetDate), to: targetDate },
                user
            );
        });
        return { id: Number(plan.id) };
    }

    /** active → achieved | cancelled, reason mandatory. */
    async closePlan(user, planId, state, reason) {
        this._assertWrite(user);
        if (!PLAN_CLOSE_STATES.includes(state)) throw lcError('LC_BAD_STATE', 400, 'err_bad_state');
        const why = String(reason || '').trim();
        if (!why) throw lcError('LC_REASON_REQUIRED', 400, 'err_reason_required');
        const plan = await this._plan(planId);
        await this._assertPlanInScope(user, plan);
        if (plan.state !== 'active') throw lcError('LC_PLAN_CLOSED', 409, 'err_plan_closed');
        await db.runTransaction(async () => {
            const r = await db.run(
                `UPDATE lc_nationalisation_plans
                    SET state = ?, state_reason = ?, state_changed_at = now(),
                        state_changed_by_ref = ?, updated_at = now()
                  WHERE id = ? AND state = 'active'`,
                [state, why.slice(0, 2000), actorRef(user), Number(plan.id)]
            );
            if (!r.changes) throw lcError('LC_PLAN_CLOSED', 409, 'err_plan_closed');
            await this._event(plan.id, null, `plan.${state}`, why, null, user);
        });
        return { id: Number(plan.id), state };
    }

    /** Name a national successor on an active plan. */
    async addSuccessor(user, planId, employeeId) {
        this._assertWrite(user);
        const plan = await this._plan(planId);
        await this._assertPlanInScope(user, plan);
        if (plan.state !== 'active') throw lcError('LC_PLAN_CLOSED', 409, 'err_plan_closed');
        const eid = Number(employeeId);
        if (!eid) throw lcError('LC_EMPLOYEE_NOT_FOUND', 404, 'err_employee_not_found');
        if (eid === Number(plan.incumbentEmployeeId)) {
            throw lcError('LC_SUCCESSOR_IS_INCUMBENT', 400, 'err_successor_is_incumbent');
        }
        const emp = await db.get('SELECT id, is_active FROM employees WHERE id = ?', [eid]);
        if (!emp || !emp.isActive)
            throw lcError('LC_EMPLOYEE_NOT_FOUND', 404, 'err_employee_not_found');
        if (!(await this._inScope(user, eid))) throw lcError('LC_FORBIDDEN', 403, 'err_forbidden');
        // National OF THE POSITION'S COUNTRY — the law's test. Unknown → refused.
        if (plan.countryId == null) throw lcError('LC_COUNTRY_UNKNOWN', 400, 'err_country_unknown');
        const nat = await this.nationalOf(eid, plan.countryId);
        if (nat == null) throw lcError('LC_NATIONALITY_UNKNOWN', 400, 'err_nationality_unknown');
        if (nat !== 1)
            throw lcError('LC_SUCCESSOR_NOT_NATIONAL', 400, 'err_successor_not_national');
        // Checked before the INSERT: a unique violation inside a caller's
        // transaction would abort it. The 23505 catch below is the race fallback.
        const dup = await db.get(
            `SELECT id FROM lc_nationalisation_successors WHERE plan_id = ? AND employee_id = ? AND state = 'active'`,
            [Number(plan.id), eid]
        );
        if (dup) throw lcError('LC_SUCCESSOR_EXISTS', 409, 'err_successor_exists');
        let id = null;
        try {
            await db.runTransaction(async () => {
                const r = await db.run(
                    `INSERT INTO lc_nationalisation_successors (plan_id, employee_id, added_by_ref)
                     VALUES (?, ?, ?)`,
                    [Number(plan.id), eid, actorRef(user)]
                );
                id = r.lastID;
                await this._event(plan.id, id, 'successor.added', null, { employeeId: eid }, user);
            });
        } catch (e) {
            if (e && e.code === '23505')
                throw lcError('LC_SUCCESSOR_EXISTS', 409, 'err_successor_exists');
            throw e;
        }
        return { id };
    }

    async _successor(successorId) {
        const s = await db.get(
            `SELECT ns.id, ns.plan_id, ns.employee_id, ns.idp_id, ns.state,
                    (SELECT e.is_active FROM employees e WHERE e.id = ns.employee_id) AS employee_active
               FROM lc_nationalisation_successors ns WHERE ns.id = ?`,
            [Number(successorId)]
        );
        if (!s) throw lcError('LC_SUCCESSOR_NOT_FOUND', 404, 'err_successor_not_found');
        return s;
    }

    /** Withdraw a successor — state + reason, never a deletion. */
    async withdrawSuccessor(user, successorId, reason) {
        this._assertWrite(user);
        const why = String(reason || '').trim();
        if (!why) throw lcError('LC_REASON_REQUIRED', 400, 'err_reason_required');
        const s = await this._successor(successorId);
        const plan = await this._plan(s.planId);
        await this._assertPlanInScope(user, plan);
        if (s.state !== 'active')
            throw lcError('LC_SUCCESSOR_NOT_ACTIVE', 409, 'err_successor_not_active');
        await db.runTransaction(async () => {
            await db.run(
                `UPDATE lc_nationalisation_successors
                    SET state = 'withdrawn', state_reason = ?, state_changed_at = now(), state_changed_by_ref = ?
                  WHERE id = ? AND state = 'active'`,
                [why.slice(0, 2000), actorRef(user), Number(s.id)]
            );
            await this._event(plan.id, s.id, 'successor.withdrawn', why, null, user);
        });
        return { id: Number(s.id) };
    }

    /**
     * Create-or-link the successor's IDP, through IDPService's public methods.
     *   - an already-linked plan that is still open (draft/active) is kept;
     *   - otherwise a new draft plan is created (IDPService.createManualPlan),
     *     due on the nationalisation target date, seeded with the successor's
     *     measured gap skills;
     *   - if the person already has an open plan (IDP_OPEN_EXISTS), THAT plan
     *     is linked — one open IDP per person is the IDP module's own rule.
     * The caller must hold IDP authority over the successor
     * (IDPService.planAuthority) — never the successor themself.
     */
    async linkIdp(user, successorId, { locale = 'fr' } = {}) {
        this._assertWrite(user);
        const IDPService = require('./IDPService');
        const s = await this._successor(successorId);
        const plan = await this._plan(s.planId);
        await this._assertPlanInScope(user, plan);
        if (plan.state !== 'active') throw lcError('LC_PLAN_CLOSED', 409, 'err_plan_closed');
        if (s.state !== 'active')
            throw lcError('LC_SUCCESSOR_NOT_ACTIVE', 409, 'err_successor_not_active');
        // a successor who has left the company gets no IDP.
        if (s.employeeActive === false)
            throw lcError('LC_SUCCESSOR_LEFT', 409, 'err_successor_left');
        const auth = await IDPService.planAuthority(user, { employeeId: Number(s.employeeId) });
        if (!auth || !auth.canAct) throw lcError('LC_IDP_FORBIDDEN', 403, 'err_idp_forbidden');

        if (s.idpId != null) {
            const cur = await db.get(
                `SELECT id, status::text AS status FROM idp_plans WHERE id = ?`,
                [Number(s.idpId)]
            );
            if (cur && ['draft', 'active'].includes(cur.status)) {
                return { idpId: Number(cur.id), created: false, linked: false };
            }
        }

        const rmap = await this._readiness(plan.roleId, [s.employeeId]);
        const r = rmap[Number(s.employeeId)];
        const gapSkillIds = r
            ? (r.gaps || []).filter((g) => g.isAssessed).map((g) => Number(g.skillId))
            : [];
        let idpId = null;
        let created = false;
        try {
            const res = await IDPService.createManualPlan({
                employeeId: Number(s.employeeId),
                priority: 'high',
                skillIds: gapSkillIds,
                locale,
                dueOn: ymd(plan.targetDate),
            });
            idpId = Number(res.idpId);
            created = true;
        } catch (e) {
            if (!(e && e.code === 'IDP_OPEN_EXISTS')) throw e;
            idpId = e.existingId != null ? Number(e.existingId) : null;
            if (idpId == null) {
                const open = await db.get(
                    `SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft', 'active')
                      ORDER BY id DESC LIMIT 1`,
                    [Number(s.employeeId)]
                );
                idpId = open ? Number(open.id) : null;
            }
            if (idpId == null) throw e;
        }
        await db.runTransaction(async () => {
            await db.run(`UPDATE lc_nationalisation_successors SET idp_id = ? WHERE id = ?`, [
                idpId,
                Number(s.id),
            ]);
            await this._event(
                plan.id,
                s.id,
                created ? 'successor.idp_created' : 'successor.idp_linked',
                null,
                { idpId },
                user
            );
        });
        return { idpId, created, linked: !created };
    }

    /**
     * F2 (3.23.21) — the leaver / mover cascade. Journals a 'plan.flagged' event
     * on every ACTIVE plan the person is on (as the expatriate incumbent, or as
     * an active successor for a departure) so the change is on the plan's record
     * for a human decision. Nothing is closed or withdrawn automatically: the
     * live flags (listPlans) and this journal entry are the signal.
     *
     * @param {number} employeeId
     * @param {'leaver'|'mover'} kind
     * @param {string} actor  actor ref ('admin:5', 'system', …)
     * @returns {Promise<number[]>} the flagged plan ids
     */
    async flagPlansForEmployee(employeeId, kind, actor = 'system') {
        const id = Number(employeeId);
        if (!id) return [];
        const asIncumbent = await db.all(
            `SELECT id FROM lc_nationalisation_plans WHERE state = 'active' AND incumbent_employee_id = ?`,
            [id]
        );
        const asSuccessor =
            kind === 'leaver'
                ? await db.all(
                      `SELECT ns.plan_id AS id, ns.id AS successor_id
                         FROM lc_nationalisation_successors ns
                         JOIN lc_nationalisation_plans p ON p.id = ns.plan_id
                        WHERE ns.employee_id = ? AND ns.state = 'active' AND p.state = 'active'`,
                      [id]
                  )
                : [];
        const flagged = [];
        const ref = String(actor || 'system').slice(0, 64);
        for (const p of asIncumbent) {
            const reason = kind === 'leaver' ? 'incumbent_left' : 'incumbent_role_changed';
            await db.run(
                `INSERT INTO lc_nationalisation_events (plan_id, successor_id, action, reason, details, actor_ref)
                 VALUES (?, NULL, 'plan.flagged', ?, ?::jsonb, ?)`,
                [Number(p.id), reason, JSON.stringify({ employeeId: id, kind }), ref]
            );
            flagged.push(Number(p.id));
        }
        for (const s of asSuccessor) {
            await db.run(
                `INSERT INTO lc_nationalisation_events (plan_id, successor_id, action, reason, details, actor_ref)
                 VALUES (?, ?, 'plan.flagged', 'successor_left', ?::jsonb, ?)`,
                [Number(s.id), Number(s.successorId), JSON.stringify({ employeeId: id, kind }), ref]
            );
            if (!flagged.includes(Number(s.id))) flagged.push(Number(s.id));
        }
        return flagged;
    }

    async events(user, planId) {
        this._assertView(user);
        const plan = await this._plan(planId);
        await this._assertPlanInScope(user, plan);
        return db.all(
            `SELECT id, successor_id, action, reason, details, actor_ref, at
               FROM lc_nationalisation_events WHERE plan_id = ? ORDER BY at, id`,
            [Number(plan.id)]
        );
    }
}

const instance = new NationalisationService();
instance.computeStatus = computeStatus;
instance.natCase = natCase;
instance.ymd = ymd;
instance.isYmd = isYmd;
instance.actorRef = actorRef;
instance.AT_RISK_HORIZON_DAYS = AT_RISK_HORIZON_DAYS;
module.exports = instance;
