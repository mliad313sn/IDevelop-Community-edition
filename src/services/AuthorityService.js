'use strict';

/**
 * AuthorityService — the authority ladder (4.0.0 port, wave 2).
 *
 * One question for every service, route and view that decides who may ACT on a
 * person's record: canAct(user, action, person). The ladder orders what an
 * account can be with respect to a person P:
 *
 *     supervisor  ⊂  manager  ⊂  local admin (P inside the clearance)  ⊂  SuperAdmin
 *
 * An account holds the UNION of what it is: someone who is both P's supervisor
 * and P's manager holds the manager rung (never a conflict), and an
 * administration account linked to a person keeps that person's reporting line
 * (GovernanceService.actingPersonId).
 *
 * TWO MODES, App Setting `authority.ladder` (SuperAdmin only):
 *
 *   strict (the default, new installs and upgrades) — TODAY'S REACH, unchanged.
 *       Every service keeps the rule it applied before the ladder existed and
 *       hands it to canAct/allows as `strict`; the ladder adds nothing. In
 *       particular the reporting line ABOVE the direct supervisor/manager reads
 *       and does not act, and a local administrator still needs the feature
 *       permission where the feature asked for one (9-box: manage_talent_reviews;
 *       bulk approval: approve_assessments).
 *
 *   extended — strict PLUS the ladder: anyone above in P's line holds the
 *       manager rung, and a local administrator whose clearance covers P holds
 *       every rung below theirs without a per-feature permission. Extended never
 *       takes away a right strict grants (it is a union).
 *
 * INVARIANTS of the ladder half (refused whatever the rung):
 *   - nobody acts on their own record, by either of their accounts, nor through
 *     an unlinked administration account that shares their identity
 *     (personIdentity.adminMatchesEmployee — refusal only, never a grant);
 *   - a read-only account (role viewer) never acts;
 *   - a local administrator outside their clearance holds only their own line.
 *
 * Actions whose `widens` is false keep the same reach in both modes: the
 * two-party spaces (360° feedback rounds, one-to-ones) and the first two levels
 * of a rating dispute, which in IDevelop already reach the manager's whole
 * sub-tree and are decided by a person (decided_by is an employee).
 *
 * The rung an act used is recorded on its audit line (` as=<rung>`, withAs);
 * the person's direct manager is told in the app when someone above them acts
 * on their team (LineNoticeService, kind `line.acted_above`).
 */

const MODES = Object.freeze(['strict', 'extended']);
const SETTING_KEY = 'authority.ladder';

const RUNG = Object.freeze({ none: 0, supervisor: 1, manager: 2, localadmin: 3, superadmin: 4 });
const RUNG_NAMES = Object.freeze(['none', 'supervisor', 'manager', 'localadmin', 'superadmin']);

/**
 * The action table. `min` is the lowest rung that may act; `slug` is the
 * permission a local administrator needs IN STRICT MODE on top of the
 * clearance (the rule of the feature before the ladder); `widens: false` keeps
 * the action at its strict reach in extended mode too.
 */
const ACTIONS = Object.freeze({
    // self-assessment review: single and bulk approval share one rule
    'sa.open_review': Object.freeze({ min: 'supervisor' }),
    'sa.approve': Object.freeze({ min: 'supervisor' }),
    'sa.bulk_approve': Object.freeze({ min: 'supervisor' }),
    'sa.request_changes': Object.freeze({ min: 'supervisor' }),
    'sa.reject': Object.freeze({ min: 'supervisor' }),
    'sa.comment': Object.freeze({ min: 'supervisor' }),
    'sa.cancel': Object.freeze({ min: 'supervisor' }),
    'sa.validate': Object.freeze({ min: 'manager' }),
    'sa.arbitrate': Object.freeze({ min: 'manager' }),
    // talent and development
    'coaching.act': Object.freeze({ min: 'supervisor' }),
    'coaching.manage': Object.freeze({ min: 'manager' }),
    'ninebox.draft': Object.freeze({ min: 'supervisor', slug: 'manage_talent_reviews' }),
    'ninebox.approve': Object.freeze({ min: 'manager', slug: 'manage_talent_reviews' }),
    'pip.act': Object.freeze({ min: 'manager' }),
    'idp.act': Object.freeze({ min: 'supervisor' }),
    'lms.uplift': Object.freeze({ min: 'supervisor', slug: 'approve_assessments' }),
    // rating disputes, levels 0 and 1 (level 2 is the HR arbiter's)
    'dispute.l0': Object.freeze({ min: 'supervisor', widens: false }),
    'dispute.l1': Object.freeze({ min: 'supervisor', widens: false }),
    // IDevelop-only actors: two-party spaces, same reach in both modes
    'feedback360.launch': Object.freeze({ min: 'supervisor', widens: false }),
    'feedback360.manage': Object.freeze({ min: 'manager', widens: false }),
    'oneonone.act': Object.freeze({ min: 'manager', widens: false }),
});

function rungName(n) {
    return RUNG_NAMES[Math.max(0, Math.min(4, Number(n) || 0))];
}

function definition(action) {
    const def = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
    if (!def) throw new Error('AuthorityService: unknown action');
    return def;
}

function hasGrant(user, slug) {
    if (!slug) return true;
    const grants = user && Array.isArray(user.permissions) ? user.permissions : [];
    return grants.includes(slug);
}

/**
 * The rung a session last acted with, per session user OBJECT (req.user), so an
 * audit helper can write ` as=<rung>` without every call site threading it.
 * A WeakMap: nothing outlives the request's user object.
 */
const LAST_AS = new WeakMap();
/** The session user a relation was resolved for (allows() records on it). */
const REL_USER = new WeakMap();

const AuthorityService = {
    MODES,
    SETTING_KEY,
    RUNG,
    ACTIONS,
    rungName,

    /** 'strict' | 'extended'. Anything unreadable or unknown is strict. */
    async mode() {
        try {
            const v = await require('../models/AppSettingsModel').getValue(SETTING_KEY, 'strict');
            return String(v || '').trim() === 'extended' ? 'extended' : 'strict';
        } catch (_) {
            return 'strict';
        }
    },

    /**
     * Everything an account IS with respect to one person, for the mode in
     * force. Null when the person does not exist.
     *
     * The facts are computed exactly as the review services computed them
     * (the person behind the account, the manager_type discriminator, the
     * clearance, the governed sub-tree), so a service can rebuild its own
     * pre-ladder rule from them.
     */
    async relation(user, employeeOrId, { mode = null } = {}) {
        const EmployeeModel = require('../models/EmployeeModel');
        const RBACService = require('./RBACService');
        const GovernanceService = require('./GovernanceService');
        const employee =
            employeeOrId && typeof employeeOrId === 'object'
                ? employeeOrId
                : await EmployeeModel.findById(Number(employeeOrId));
        if (!employee) return null;
        const eid = Number(employee.id);
        const m = mode === 'extended' || mode === 'strict' ? mode : await this.mode();
        const isAdmin = Boolean(user && user.userType === 'admin');
        const isSuper = Boolean(RBACService.isSuperAdmin(user));
        const isLocalAdmin = Boolean(RBACService.isLocalAdmin(user));
        const isViewer = Boolean(RBACService.isViewer(user));
        const personId = user ? await GovernanceService.actingPersonId(user) : null;
        const isSelf = personId != null && Number(personId) === eid;
        // An administration account linked to NOBODY that shares the person's
        // identity is still them: refusal only, never a grant.
        const selfByIdentity = Boolean(
            !isSelf &&
            isAdmin &&
            personId == null &&
            (await require('../utils/personIdentity').adminMatchesEmployee(user.id, eid))
        );
        const isSupervisor = Boolean(
            personId != null &&
            employee.supervisorId != null &&
            Number(employee.supervisorId) === Number(personId)
        );
        // `manager_type` is never optional: manager_id is polymorphic and the
        // employee and admin id spaces overlap.
        const isDirectManager = Boolean(
            personId != null &&
            employee.managerId != null &&
            employee.managerType === 'employee' &&
            Number(employee.managerId) === Number(personId)
        );
        const isAdminManager = Boolean(
            isAdmin &&
            employee.managerId != null &&
            employee.managerType === 'admin' &&
            Number(employee.managerId) === Number(user.id)
        );
        // The governed sub-tree of the person acting (never themselves).
        const inLine = Boolean(
            isSupervisor ||
            isDirectManager ||
            (personId != null && !isSelf && (await EmployeeModel.governs(personId, eid)))
        );
        const isLineAbove = Boolean(inLine && !isSupervisor && !isDirectManager);
        const inClearance = isSuper
            ? true
            : isAdmin
              ? Boolean(await RBACService.canAccessEmployeeData(user, employee))
              : false;

        // The rungs held, in each mode. Strict: the direct line, a local admin
        // in clearance, a SuperAdmin. Extended adds the line above (manager).
        const strictHolds = [];
        if (isSupervisor) strictHolds.push('supervisor');
        if (isDirectManager || isAdminManager) strictHolds.push('manager');
        if (isLocalAdmin && inClearance) strictHolds.push('localadmin');
        if (isSuper) strictHolds.push('superadmin');
        const ladderHolds = [];
        if (isSupervisor) ladderHolds.push('supervisor');
        if (isDirectManager || isAdminManager || isLineAbove) ladderHolds.push('manager');
        if (isLocalAdmin && inClearance) ladderHolds.push('localadmin');
        if (isSuper) ladderHolds.push('superadmin');
        const top = (list) => list.reduce((n, h) => Math.max(n, RUNG[h]), 0);
        const blocked = isViewer || isSelf || selfByIdentity;
        const strictRung = blocked ? 0 : top(strictHolds);
        const ladderRung = blocked ? 0 : top(ladderHolds);
        const holds = m === 'extended' ? ladderHolds : strictHolds;
        const rung = m === 'extended' ? ladderRung : strictRung;
        const rel = {
            employee,
            mode: m,
            personId,
            isAdmin,
            isSuper,
            isLocalAdmin,
            isViewer,
            isSelf,
            selfByIdentity,
            isSupervisor,
            isDirectManager,
            isAdminManager,
            isLineAbove,
            inLine,
            inClearance,
            holds,
            rawRung: top(holds),
            strictRung,
            ladderRung,
            rung,
            as: rungName(rung),
        };
        if (user && typeof user === 'object') REL_USER.set(rel, user);
        return rel;
    },

    /**
     * The pre-ladder rule, for callers that do not hand their own: the direct
     * line, a local administrator in clearance (with the feature permission
     * when the action names one), a SuperAdmin. Pure.
     */
    strictAllows(rel, action) {
        const def = definition(action);
        if (!rel) return false;
        if (rel.isSelf || rel.selfByIdentity || rel.isViewer) return false;
        if (rel.isSuper) return true;
        const user = REL_USER.get(rel);
        if (rel.isLocalAdmin && rel.inClearance && hasGrant(user, def.slug)) return true;
        if (def.min === 'supervisor' && rel.isSupervisor) return true;
        return Boolean(rel.isDirectManager || rel.isAdminManager);
    },

    /** The ladder half (extended mode), with its invariants. Pure. */
    ladderAllows(rel, action) {
        const def = definition(action);
        if (!rel) return { ok: false, reason: 'not_found' };
        if (rel.isSelf || rel.selfByIdentity) return { ok: false, reason: 'self' };
        if (rel.isViewer) return { ok: false, reason: 'read_only' };
        const rung = rel.ladderRung != null ? rel.ladderRung : rel.rung;
        if (rung >= RUNG[def.min]) return { ok: true, reason: null, as: rungName(rung) };
        if (!rung)
            return {
                ok: false,
                reason: rel.isAdmin && !rel.inClearance ? 'out_of_scope' : 'not_in_line',
            };
        return { ok: false, reason: 'rung_too_low' };
    },

    /**
     * Does a relation allow `action`? `strict` is the caller's own pre-ladder
     * decision (a boolean); when omitted, strictAllows answers. Extended mode
     * adds the ladder for actions that widen. Returns { ok, as, reason, by }.
     */
    allows(rel, action, { strict, as = null } = {}) {
        const def = definition(action);
        if (!rel) return { ok: false, as: 'none', reason: 'not_found', by: null };
        const strictOk = strict === undefined ? this.strictAllows(rel, action) : Boolean(strict);
        let out;
        if (strictOk) {
            out = {
                ok: true,
                as: as || (rel.strictRung ? rungName(rel.strictRung) : rel.as),
                reason: null,
                by: 'strict',
            };
        } else if (rel.mode === 'extended' && def.widens !== false) {
            const l = this.ladderAllows(rel, action);
            out = l.ok
                ? { ok: true, as: l.as, reason: null, by: 'ladder' }
                : { ok: false, as: 'none', reason: l.reason, by: null };
        } else {
            const l = this.ladderAllows({ ...rel, ladderRung: rel.strictRung }, action);
            out = { ok: false, as: 'none', reason: l.ok ? 'rung_too_low' : l.reason, by: null };
        }
        if (out.ok && out.as && out.as !== 'none') {
            const user = REL_USER.get(rel);
            if (user) LAST_AS.set(user, { as: out.as, employeeId: Number(rel.employee.id) });
        }
        return out;
    },

    /**
     * THE question: { ok, as, reason, by, relation }. `reason` when refused:
     * 'self' | 'read_only' | 'out_of_scope' | 'not_in_line' | 'rung_too_low' |
     * 'not_found' | 'no_user'.
     */
    async canAct(user, action, employeeOrId, opts = {}) {
        definition(action);
        if (!user || user.id == null)
            return { ok: false, as: 'none', reason: 'no_user', by: null, relation: null };
        const rel = await this.relation(user, employeeOrId, { mode: opts.mode || null });
        return { ...this.allows(rel, action, opts), relation: rel };
    },

    /**
     * After a service's own rule refused: does the ladder (extended mode only)
     * let this account act? Used by the services whose pre-ladder rule is not a
     * function of the relation (PIP, IDP, LMS). Returns { ok, as } and records
     * the rung for the audit line.
     */
    async widen(user, action, employeeOrId) {
        const def = definition(action);
        if (def.widens === false || !user || user.id == null) return { ok: false, as: 'none' };
        if ((await this.mode()) !== 'extended') return { ok: false, as: 'none' };
        const rel = await this.relation(user, employeeOrId, { mode: 'extended' });
        if (!rel) return { ok: false, as: 'none' };
        const out = this.allows(rel, action, { strict: false });
        return { ok: out.ok, as: out.as, reason: out.reason };
    },

    /**
     * Route-level coarse test, extended mode: could this account act on anyone
     * by the ladder? A manager session, a SuperAdmin, any administration account
     * that is not read-only. The per-person decision stays canAct's.
     */
    mayActOnSomeone(user) {
        if (!user) return false;
        if (user.userType === 'manager') return true;
        if (user.userType !== 'admin') return false;
        return user.role !== 'viewer';
    },

    /** Record a rung the ladder did not resolve (a campaign-assigned reviewer). */
    noteAs(user, employeeId, as) {
        if (user && typeof user === 'object' && as)
            LAST_AS.set(user, { as: String(as), employeeId: Number(employeeId) });
    },

    /** ' as=<rung>' for an audit line, or '' when no rung was resolved. */
    auditAs(user, employeeId = null) {
        const r = user && typeof user === 'object' ? LAST_AS.get(user) : null;
        if (!r) return '';
        if (employeeId != null && Number(employeeId) !== Number(r.employeeId)) return '';
        return ` as=${r.as}`;
    },

    /** `details` + ' as=<rung>'; `details` unchanged when no rung is known. */
    withAs(details, user, employeeId = null) {
        const as = this.auditAs(user, employeeId);
        if (!as) return details;
        return `${details == null ? '' : details}${as}`;
    },
};

module.exports = AuthorityService;
