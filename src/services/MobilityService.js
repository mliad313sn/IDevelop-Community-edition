'use strict';

/**
 * MobilityService — internal talent marketplace. Managers post opportunities
 * (gigs/projects/mentorship/roles) with skills sought; the matching engine scores
 * employees by how well their current skills + adjacency cover the requirement,
 * reusing the skills graph. Employees apply and record aspirations.
 */
const db = require('../config/database');
const SkillsIntel = require('./SkillsIntelligenceService');

/** A refusal the caller is meant to read (asyncHandler maps it to its 4xx). */
function refuse(status, code, message) {
    const e = new Error(message || code);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

/** The terminal states an OPEN opportunity can be moved to by its poster. */
const CLOSING_STATES = ['closed', 'filled'];

class MobilityService {
    async postOpportunity({
        kind = 'gig',
        title,
        description,
        roleId = null,
        siteId = null,
        departmentId = null,
        skillsSought = [],
        postedByAdminId = null,
        actorEmployeeId = null,
        closesOn = null,
        audiencePool = null,
    }) {
        const opp = await db.get(
            `INSERT INTO opportunities (kind, title, description, role_id, site_id, department_id, skills_sought, posted_by_admin_id, actor_employee_id, closes_on)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            [
                kind,
                title,
                description || null,
                roleId,
                siteId,
                departmentId,
                JSON.stringify(skillsSought || []),
                postedByAdminId,
                actorEmployeeId,
                closesOn,
            ]
        );
        // Engagement: personally surface the opportunity to the best-matched
        // employees who opted into mobility (digest-tier, in-app; no inbox spam).
        // The pool is the POSTER's scope (the route resolves it from RBAC;
        // SuperAdmin = the organisation). No pool → nobody is notified.
        this._notifyMatched(opp, audiencePool).catch(() => {});
        return opp;
    }

    /**
     * Notify the top matched, mobility-opted-in employees about a new opportunity.
     *
     * The candidate pool used to be EVERY row of employee_aspirations: leavers
     * (whose aspiration row outlives them) and people entirely outside the
     * poster's perimeter were pinged about a posting they had no business
     * seeing. It is now the intersection of (a) the poster's scope, handed in
     * by the route, (b) ACTIVE employees and (c) those open to mobility. Fails
     * closed: without a scope pool nobody is notified.
     */
    async _notifyMatched(opp, scopePool = null) {
        try {
            if (!opp || !opp.id) return;
            const scope = (Array.isArray(scopePool) ? scopePool : [])
                .map(Number)
                .filter((n) => Number.isInteger(n) && n > 0);
            if (!scope.length) return;
            const ph = scope.map(() => '?').join(',');
            const pool = await db.all(
                `SELECT a.employee_id FROM employee_aspirations a
                   JOIN employees e ON e.id = a.employee_id
                  WHERE a.open_to_mobility = true AND e.is_active = true
                    AND a.employee_id IN (${ph})`,
                scope
            );
            const ids = pool.map((p) => Number(p.employeeId ?? p.employee_id)).filter(Boolean);
            if (!ids.length) return;
            const matches = await this.matchCandidates(opp.id, ids, 15);
            const N = require('./NotificationService');
            for (const m of matches) {
                const eid = Number(m.employeeId);
                // Employee-facing landing: /v2/cap is the manager/admin capability
                // console (requireManagerOrAdmin), so an employee clicking this
                // notification was bounced to /dashboard. "Mon évolution" is the
                // page that actually shows them open opportunities.
                if (eid)
                    await N.notify({
                        userType: 'employee',
                        userId: eid,
                        kind: 'mobility.opportunity_posted',
                        category: 'mobility',
                        payload: { link: '/employee/opportunities' },
                    }).catch(() => {});
            }
        } catch (_) {
            /* engagement, best-effort */
        }
    }
    /**
     * List opportunities in a state.
     *
     * `closes_on` used to be stored and never read: a posting past its closing
     * date stayed on the employee marketplace and kept accepting applications.
     * An OPEN posting whose closing date has passed is now hidden from the
     * listing unless `includeExpired` (the poster's console, where it must stay
     * visible so it can be closed or filled) — and flagged `expired` there.
     *
     * `visibleTo` restricts the console list for a non-SuperAdmin: postings
     * they posted themselves, plus postings with at least one live applicant
     * inside their scope. Omitted = unrestricted (SuperAdmin, employee marketplace).
     */
    async listOpportunities(state = 'open', { includeExpired = false, visibleTo = null } = {}) {
        const params = [state];
        let where = 'o.state = ?';
        if (!includeExpired) where += ' AND (o.closes_on IS NULL OR o.closes_on >= CURRENT_DATE)';
        if (visibleTo) {
            const ors = [];
            if (visibleTo.adminId) {
                ors.push('o.posted_by_admin_id = ?');
                params.push(Number(visibleTo.adminId));
            }
            if (visibleTo.employeeId) {
                ors.push('o.actor_employee_id = ?');
                params.push(Number(visibleTo.employeeId));
            }
            const scopeIds = (visibleTo.scopeIds || []).map(Number).filter(Boolean);
            if (scopeIds.length) {
                ors.push(
                    `EXISTS (SELECT 1 FROM opportunity_applications sa
                              WHERE sa.opportunity_id = o.id AND sa.status <> 'withdrawn'
                                AND sa.employee_id IN (${scopeIds.map(() => '?').join(',')}))`
                );
                params.push(...scopeIds);
            }
            // Nothing to be visible through → nothing is listed (fail closed).
            where += ors.length ? ` AND (${ors.join(' OR ')})` : ' AND false';
        }
        return db.all(
            `SELECT o.*, r.name AS role_name,
                    (o.closes_on IS NOT NULL AND o.closes_on < CURRENT_DATE) AS expired,
                    -- A withdrawn application is not an applicant. Before the
                    -- withdrawal became a state it was simply deleted, so this
                    -- count needed no filter; it does now.
                    (SELECT COUNT(*) FROM opportunity_applications a
                      WHERE a.opportunity_id = o.id AND a.status <> 'withdrawn') AS applicants
             FROM opportunities o LEFT JOIN roles r ON r.id = o.role_id
             WHERE ${where} ORDER BY o.created_at DESC`,
            params
        );
    }

    /** Poster identity of an opportunity (null when it does not exist). */
    async getOpportunity(opportunityId) {
        return db.get(
            `SELECT id, title, state, closes_on, posted_by_admin_id, actor_employee_id, skills_sought
               FROM opportunities WHERE id = ?`,
            [Number(opportunityId)]
        );
    }

    /**
     * The applicants of one opportunity, for its poster (or a manager/admin
     * who governs some of them — `scopeIds` then limits the list to those).
     * Before this there was only a COUNT: the poster could not see who had
     * applied, and the decide endpoint needed an application id no screen
     * exposed. `fitPct` is null — never 0 — when it cannot be measured (the
     * posting names no skills, or the person has no assessment on them).
     */
    async listApplicants(opportunityId, { scopeIds = null } = {}) {
        const params = [Number(opportunityId)];
        let scopeSql = '';
        if (Array.isArray(scopeIds)) {
            const ids = scopeIds.map(Number).filter(Boolean);
            if (!ids.length) return [];
            scopeSql = ` AND a.employee_id IN (${ids.map(() => '?').join(',')})`;
            params.push(...ids);
        }
        const rows = await db.all(
            `SELECT a.id, a.employee_id, a.status, a.note, a.created_at, a.decided_at, a.decision_note,
                    e.first_name, e.last_name
               FROM opportunity_applications a
               JOIN employees e ON e.id = a.employee_id
              WHERE a.opportunity_id = ? AND a.status <> 'withdrawn'${scopeSql}
              ORDER BY a.created_at`,
            params
        );
        if (!rows.length) return [];
        const empIds = rows.map((r) => Number(r.employeeId ?? r.employee_id));
        let fit = [];
        try {
            fit = await this.matchCandidates(Number(opportunityId), empIds, empIds.length);
        } catch (_) {
            fit = [];
        }
        const fitBy = new Map(fit.map((f) => [Number(f.employeeId), f.matchPct]));
        return rows.map((r) => {
            const eid = Number(r.employeeId ?? r.employee_id);
            return {
                id: Number(r.id),
                employeeId: eid,
                name: [r.firstName ?? r.first_name, r.lastName ?? r.last_name]
                    .filter(Boolean)
                    .join(' '),
                status: r.status,
                note: r.note || null,
                appliedAt: r.createdAt ?? r.created_at,
                decidedAt: r.decidedAt ?? r.decided_at ?? null,
                decisionNote: r.decisionNote ?? r.decision_note ?? null,
                fitPct: fitBy.has(eid) ? fitBy.get(eid) : null,
            };
        });
    }

    /**
     * Close or fill an OPEN opportunity — with a reason and the actor, as a
     * recorded state (migration 147). Nothing ever wrote opportunities.state,
     * so a filled role stayed "open" on the marketplace indefinitely.
     */
    async setOpportunityState(
        opportunityId,
        { state, reason, adminId = null, employeeId = null } = {}
    ) {
        if (!CLOSING_STATES.includes(state)) throw refuse(400, 'invalid_state', 'invalid_state');
        const why = String(reason == null ? '' : reason)
            .trim()
            .slice(0, 1000);
        if (!why) throw refuse(400, 'reason_required', 'reason_required');
        const row = await db.get(
            `UPDATE opportunities
                SET state = ?, state_reason = ?, state_changed_at = now(),
                    state_changed_by_admin_id = ?, state_changed_by_employee_id = ?
              WHERE id = ? AND state = 'open'
              RETURNING id, state`,
            [state, why, adminId, employeeId, Number(opportunityId)]
        );
        if (!row) throw refuse(409, 'opportunity_not_open', 'opportunity_not_open');
        return { ok: true, id: Number(row.id), state: row.state };
    }

    /**
     * An employee's own applications with their outcome — including those on
     * postings since closed or filled — so "Mon évolution" can say accepted /
     * declined instead of an eternal "applied".
     */
    async applicationsForEmployee(employeeId) {
        return db.all(
            `SELECT a.id, a.opportunity_id, a.status, a.created_at, a.decided_at, a.decision_note,
                    o.title, o.kind, o.state AS opportunity_state
               FROM opportunity_applications a
               JOIN opportunities o ON o.id = a.opportunity_id
              WHERE a.employee_id = ? AND a.status <> 'withdrawn'
              ORDER BY a.created_at DESC`,
            [Number(employeeId)]
        );
    }

    async apply(opportunityId, employeeId, note = null) {
        // Only OPEN opportunities accept applications — a direct POST against a
        // closed/filled posting must not file a ghost application. Nor one past
        // its closing date: `closes_on` was stored and never enforced.
        const state = await db.get(
            `SELECT state, (closes_on IS NOT NULL AND closes_on < CURRENT_DATE) AS expired
               FROM opportunities WHERE id = ?`,
            [opportunityId]
        );
        if (!state) throw refuse(404, 'opportunity_not_found', 'opportunity_not_found');
        if (String(state.state) !== 'open')
            throw refuse(409, 'opportunity_not_open', 'opportunity_not_open');
        if (state.expired === true) throw refuse(409, 'opportunity_expired', 'opportunity_expired');
        const application = await db.get(
            // Re-applying revives a row the applicant WITHDREW, and only that:
            // a withdrawal is now a state rather than a deletion, and the unique
            // (opportunity_id, employee_id) pair would otherwise leave someone
            // who changed their mind unable to apply again. A row somebody ELSE
            // decided — accepted or declined — is left exactly as it is; a new
            // application must never quietly erase a decision.
            `INSERT INTO opportunity_applications (opportunity_id, employee_id, note)
             VALUES (?, ?, ?) ON CONFLICT (opportunity_id, employee_id) DO UPDATE SET
               note = EXCLUDED.note,
               status = CASE WHEN opportunity_applications.status = 'withdrawn'
                             THEN 'applied' ELSE opportunity_applications.status END,
               decided_at = CASE WHEN opportunity_applications.status = 'withdrawn'
                             THEN NULL ELSE opportunity_applications.decided_at END,
               actor_employee_id = CASE WHEN opportunity_applications.status = 'withdrawn'
                             THEN NULL ELSE opportunity_applications.actor_employee_id END
             RETURNING *`,
            [opportunityId, employeeId, note]
        );
        // Tell the opportunity's poster that someone applied — route to the REAL
        // poster: a manager (actor_employee_id) or an admin (posted_by_admin_id).
        // Previously a manager-posted opening sent the ping to the superadmin.
        try {
            const opp = await db.get(
                'SELECT posted_by_admin_id, actor_employee_id FROM opportunities WHERE id = ?',
                [opportunityId]
            );
            const posterAdminId = opp
                ? Number(opp.postedByAdminId ?? opp.posted_by_admin_id) || null
                : null;
            const posterEmpId = opp
                ? Number(opp.actorEmployeeId ?? opp.actor_employee_id) || null
                : null;
            const N = require('./NotificationService');
            if (posterAdminId) {
                await N.notify({
                    userType: 'admin',
                    userId: posterAdminId,
                    kind: 'mobility.application_received',
                    category: 'mobility',
                    payload: { link: '/v2/cap' },
                }).catch(() => {});
            } else if (posterEmpId) {
                // A manager IS an employee row: `notifications.user_type` is CHECKed to
                // ('admin','employee') and NotificationController collapses any non-admin
                // to 'employee'. Passing 'manager' here violated the constraint, and the
                // catch swallowed it — so this branch notified nobody at all.
                await N.notify({
                    userType: 'employee',
                    userId: posterEmpId,
                    kind: 'mobility.application_received',
                    category: 'mobility',
                    payload: { link: '/v2/cap' },
                }).catch(() => {});
            }
        } catch (_) {
            /* best-effort */
        }
        return application;
    }
    /**
     * Decide an application (accept/decline). Records the decision trail and
     * notifies the applicant — the decision workflow that previously didn't exist,
     * so applicants never learned the outcome.
     */
    async decideApplication(
        applicationId,
        { decidedByAdminId = null, actorEmployeeId = null, decision, note = null } = {}
    ) {
        const dec =
            decision === 'accepted' ? 'accepted' : decision === 'declined' ? 'declined' : null;
        if (!dec)
            throw refuse(400, 'invalid_decision', "decision must be 'accepted' or 'declined'");
        // A refusal is owed its reason: the applicant reads it on "Mon évolution".
        note = note == null ? null : String(note).trim().slice(0, 2000) || null;
        if (dec === 'declined' && !note) throw refuse(400, 'reason_required', 'reason_required');
        const app = await db.get(
            `UPDATE opportunity_applications
                SET status = ?, decided_at = now(), decided_by_admin_id = ?, actor_employee_id = ?, decision_note = ?
              WHERE id = ? AND status = 'applied'
              RETURNING *`,
            [dec, decidedByAdminId, actorEmployeeId, note, Number(applicationId)]
        );
        if (!app) return { ok: false, reason: 'not_pending' };
        try {
            await require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: Number(app.employeeId ?? app.employee_id),
                    kind: 'mobility.application_decided',
                    category: 'talent',
                    // The recipient is the APPLICANT — an employee. /v2/cap needs
                    // manager/admin, so this deep link used to bounce them. The
                    // anchor lands on "Mes candidatures", which shows the outcome.
                    payload: { link: '/employee/opportunities#my-applications' },
                })
                .catch(() => {});
        } catch (_) {
            /* best-effort */
        }
        return { ok: true, application: app };
    }

    /**
     * Withdraw one's own application while it is still undecided.
     *
     * A STATE, not a deletion. This was `DELETE FROM opportunity_applications`,
     * which is against the house rule the rest of the product follows — a
     * cancellation carries a state and an actor, and nothing is erased. The
     * physical delete left no trace that the person had ever applied or
     * changed their mind: the poster saw an applicant count silently drop by
     * one, and nobody could answer "who withdrew, and when".
     *
     * `decided_at` is stamped because the application has reached a terminal
     * state and is no longer pending — which is also what keeps it out of the
     * department brief's "applications with no decision" count. The actor is
     * the employee, and `decided_by_admin_id` stays NULL: nobody decided this,
     * the applicant withdrew it.
     */
    async withdraw(opportunityId, employeeId) {
        const r = await db.run(
            `UPDATE opportunity_applications
                SET status = 'withdrawn', decided_at = now(), actor_employee_id = ?
              WHERE opportunity_id = ? AND employee_id = ? AND status = 'applied'`,
            [Number(employeeId), Number(opportunityId), Number(employeeId)]
        );
        return { ok: true, withdrawn: r && r.changes ? r.changes : 0 };
    }

    async setAspirations(
        employeeId,
        { targetRoleId = null, interests = null, openToMobility = true }
    ) {
        return db.get(
            `INSERT INTO employee_aspirations (employee_id, target_role_id, interests, open_to_mobility, updated_at)
             VALUES (?, ?, ?, ?, now())
             ON CONFLICT (employee_id) DO UPDATE SET target_role_id = EXCLUDED.target_role_id,
               interests = EXCLUDED.interests, open_to_mobility = EXCLUDED.open_to_mobility, updated_at = now()
             RETURNING *`,
            [
                employeeId,
                targetRoleId,
                interests,
                openToMobility === true || openToMobility === 'true',
            ]
        );
    }

    /**
     * Rank candidate employees for an opportunity. Coverage = fraction of sought
     * skills the employee meets directly; adjacency gives partial credit for a
     * related skill they already hold (learnable). Restrict to a scope pool.
     */
    async matchCandidates(opportunityId, candidateEmployeeIds, limit = 20) {
        const opp = await db.get('SELECT skills_sought FROM opportunities WHERE id = ?', [
            opportunityId,
        ]);
        if (!opp) return [];
        const sought = Array.isArray(opp.skillsSought) ? opp.skillsSought : [];
        const empIds = (candidateEmployeeIds || []).map(Number).filter(Boolean);
        if (!sought.length || !empIds.length) return [];

        // Resolve adjacency ONCE per sought skill (not per candidate), and collect
        // the full skill set we need assessments for.
        const adjacencyBySkill = new Map();
        const skillSet = new Set();
        for (const req of sought) {
            const sid = Number(req.skillId);
            skillSet.add(sid);
            const adj = await SkillsIntel.adjacent(sid, 20).catch(() => []);
            adjacencyBySkill.set(sid, adj);
            adj.forEach((a) => skillSet.add(Number(a.skillId)));
        }
        // ONE batched query for every (candidate × relevant skill) assessment,
        // replacing the previous N×S×A sequential round-trips.
        const skillIds = [...skillSet];
        const empPh = empIds.map(() => '?').join(',');
        const skPh = skillIds.map(() => '?').join(',');
        const rows = await db.all(
            `SELECT employee_id, skill_id, current_level FROM skill_assessments
             WHERE employee_id IN (${empPh}) AND skill_id IN (${skPh})`,
            [...empIds, ...skillIds]
        );
        const level = new Map(); // "emp:skill" -> current_level
        rows.forEach((r) =>
            level.set(Number(r.employeeId) + ':' + Number(r.skillId), Number(r.currentLevel))
        );

        const results = [];
        for (const empId of empIds) {
            let score = 0,
                have = 0,
                learnable = 0;
            for (const req of sought) {
                const sid = Number(req.skillId);
                const need = Number(req.level || 1);
                const lvl = level.get(empId + ':' + sid);
                if (lvl != null && lvl >= need) {
                    score += 1;
                    have++;
                    continue;
                }
                let credited = false;
                for (const a of adjacencyBySkill.get(sid) || []) {
                    const al = level.get(empId + ':' + Number(a.skillId));
                    if (al != null && al >= 1) {
                        score += 0.4 * Number(a.weight);
                        learnable++;
                        credited = true;
                        break;
                    }
                }
                if (!credited && lvl != null) {
                    score += 0.2 * (lvl / Math.max(1, need));
                }
            }
            const pct = Math.round((score / sought.length) * 100);
            if (pct > 0) results.push({ employeeId: empId, matchPct: pct, have, learnable });
        }
        results.sort((a, b) => b.matchPct - a.matchPct);
        return results.slice(0, limit);
    }
}

module.exports = new MobilityService();
