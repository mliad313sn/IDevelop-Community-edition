'use strict';

const db = require('../config/database');

/**
 *   IDPService — generates drafts on cycle close, manages dual sign-off.
 *
 *   generateDrafts(cycleId):
 *     for each finalised supervisor_review whose validated rating is
 *     strictly below the required role-skill level, create one
 *     idp_objective with a SMART template and one idp_action of type
 *     'training' (default) under a draft idp_plan per employee.
 */

const DEFAULT_TYPE = 'training';

// Default horizon for a generated development objective. The "S" in SMART is
// Time-bound: the templates used to emit the LITERAL tokens '<due_date>' /
// '<date_butoir>', so an employee signed off an objective containing an
// unsubstituted placeholder — and idp_objectives.due_on (which exists in the
// schema) was never written by any code path, so nothing could ever chase it.
// Both are now filled from ONE resolved date.
const DEFAULT_DUE_DAYS = Number(process.env.IDP_OBJECTIVE_DUE_DAYS) || 90;

/** ISO (YYYY-MM-DD) date N days out — what goes into idp_objectives.due_on. */
function dueIso(days = DEFAULT_DUE_DAYS) {
    return new Date(Date.now() + Number(days) * 86400000).toISOString().slice(0, 10);
}
/** Locale-appropriate rendering of that same date for the SMART sentence (FR primary). */
function dueLabel(iso, locale) {
    const [y, m, d] = String(iso).split('-');
    return String(locale || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? `${y}-${m}-${d}`
        : `${d}/${m}/${y}`;
}

// `current` may be null: the skill has never been assessed. The text must then
// say so rather than assert level 0 — an IDP objective is a document the employee
// signs, and claiming a measured incompetence on an unmeasured competency is the
// "absence of measurement presented as a result" failure in its most contractual
// form.
/**
 * "This person already has an open plan" — a 409 the routes can show verbatim,
 * never the raw unique-violation text (index name = free reconnaissance).
 */
function openPlanError(employeeId, existingId) {
    const e = new Error(
        'This employee already has an open development plan (draft or active); close or cancel it before creating another.'
    );
    e.code = 'IDP_OPEN_EXISTS';
    e.status = 409;
    e.expose = true;
    e.employeeId = Number(employeeId);
    e.existingId = existingId != null ? Number(existingId) : null;
    return e;
}

/** A sign-off on a plan that is no longer a draft: refused, never "signed". */
function notDraftError(idpId, status) {
    const e = new Error(
        `Cannot sign IDP #${idpId} from '${status}': only a draft plan can be signed.`
    );
    e.code = 'IDP_NOT_DRAFT';
    e.status = 409;
    e.expose = true;
    return e;
}

/**
 * A refused lifecycle move: a status the route returns as-is, a stable code,
 * and the catalogue key (+ variables) the route renders in the reader's
 * language — `message` stays the English reference for the logs.
 */
function lifecycleError(code, status, message, key, vars = null) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.expose = true;
    e.i18n = vars ? { key, vars } : { key };
    return e;
}

/**
 * idp_signoffs.user_type — added by migration 104 (another lot). Until it lands,
 * the table has no column of that name, so the sign-off code detects it once and
 * writes/reads it only when present. Cached per process; `_resetSchemaCache`
 * exists for tests and for the migration runner.
 */
let signoffUserTypeColumn = null;
async function hasSignoffUserType() {
    if (signoffUserTypeColumn === null) {
        try {
            const row = await db.get(
                `SELECT 1 AS present FROM information_schema.columns
                 WHERE table_name = 'idp_signoffs' AND column_name = 'user_type'`
            );
            signoffUserTypeColumn = Boolean(row);
        } catch (_) {
            signoffUserTypeColumn = false;
        }
    }
    return signoffUserTypeColumn;
}

const SMART_TEMPLATES = {
    en: (skill, current, required, due) =>
        (current == null
            ? `By ${due}, reach level ${required} in ${skill} (current level not assessed) as `
            : `By ${due}, raise ${skill} from level ${current} to ${required} as `) +
        `measured by supervisor validation, via on-the-job practice and 1 training session.`,
    fr: (skill, current, required, due) =>
        (current == null
            ? `D'ici le ${due}, atteindre le niveau ${required} en ${skill} (niveau actuel non évalué), `
            : `D'ici le ${due}, monter ${skill} du niveau ${current} au niveau ${required}, `) +
        `validé par le superviseur, via la pratique opérationnelle et 1 session de formation.`,
};

class IDPService {
    static async generateDrafts(cycleId, { locale = 'fr', dueDays = DEFAULT_DUE_DAYS } = {}) {
        const template = SMART_TEMPLATES[locale] || SMART_TEMPLATES.fr;
        // ONE date for the whole run: the text the employee reads and the date the
        // reminders chase are the same value, never a placeholder.
        const dueOn = dueIso(dueDays);
        const dueTxt = dueLabel(dueOn, locale);

        // WHO, AND AGAINST WHICH ROLE (3.23.17, F10).
        //   * a leaver (inactive or erased) is not handed a development plan —
        //     nobody would sign it and it would sit open for ever;
        //   * the requirement is the one of the role the person was ASSESSED
        //     against — the role snapshotted in the campaign roster at launch —
        //     not whatever role they hold on the day the campaign closes. A
        //     mid-campaign transfer used to measure the old role's ratings
        //     against the new role's requirements. No roster row (a legacy or
        //     organic row) → the current role, as before.
        const gaps = await db.all(
            `SELECT sr.employee_id, sr.skill_id, sr.supervisor_rated_level AS current_level,
                    rsr.required_level, sk.name AS skill_name
             FROM supervisor_reviews sr
             JOIN self_assessments sa ON sa.id = sr.self_assessment_id AND sa.cycle_id = ?
             JOIN employees e ON e.id = sr.employee_id AND e.is_active AND e.erased_at IS NULL
             LEFT JOIN cycle_participants cp ON cp.cycle_id = sa.cycle_id AND cp.employee_id = sr.employee_id
             JOIN role_skill_requirements rsr
                  ON rsr.role_id = COALESCE(cp.role_id, e.role_id) AND rsr.skill_id = sr.skill_id
             JOIN skills sk ON sk.id = sr.skill_id
             WHERE sa.locked_state = 'finalized'
               -- Only a DECIDED review may seed a development plan. A pending row
               -- carries no supervisor rating (it is NULL since the review row
               -- stopped being pre-populated at submit time), so this is already
               -- excluded by the comparison below — but an IDP is a document the
               -- employee signs, and it must not depend on a NULL side-effect to
               -- avoid being built from a review nobody performed.
               AND sr.status = 'completed'
               -- A REFUSED submission must not seed a development plan. The
               -- rejection path finalises the review row too, so without these two
               -- clauses a thrown-out assessment reaches this query like any other
               -- and the employee is handed an objective to sign ("monter X du
               -- niveau 1 au niveau 3") built on a rating the supervisor rejected
               -- rather than validated. Belt AND braces: the workflow state is the
               -- V2 truth, sr.decision catches a review decided through any other
               -- path. IS DISTINCT FROM keeps NULL decisions (legacy rows) in.
               AND sa.workflow_state <> 'rejected'
               AND sr.decision IS DISTINCT FROM 'reject'
               AND sr.supervisor_rated_level IS NOT NULL
               AND sr.supervisor_rated_level < rsr.required_level`,
            [cycleId]
        );

        const idpByEmp = new Map();
        let created = 0;

        // WHO IS ALREADY SPOKEN FOR.
        //
        // Two rules, one lookup:
        //   * idempotence — this fires on cycle.closed, which can re-fire (re-close,
        //     retry, manual re-run); a second run must not duplicate the plans the
        //     dashboard counts;
        //   * uq_idp_open_per_employee (migration 64) — the database permits exactly
        //     ONE draft-or-active plan per employee ACROSS ALL CYCLES, not per cycle.
        //
        // Only the first was implemented (`WHERE cycle_id = ?`), so anyone already
        // carrying an open plan from an earlier cycle was selected, their INSERT hit
        // the unique index, and — the whole loop being one transaction — the 23505
        // rolled back EVERY plan for the cycle. `emitEvent` turns the throw into a
        // console.warn, so the visible symptom was a cycle that closed and produced
        // no development plans at all, with nothing saying why. Probed:
        //   employee 84 already holds an OPEN plan from an earlier cycle
        //   generateDrafts THREW: 23505 duplicate key value violates unique constraint "uq_idp_open_per_employee"
        //   plans actually created for the cycle: 0 of 2
        //
        // MERGE, DON'T SKIP (3.23.17, F3). With plans that could never complete,
        // "already holds an open plan" became permanent after the first campaign,
        // and every later campaign's gaps were dropped for that person
        // ('open_plan_exists'). The person's gaps now JOIN the plan they already
        // have — deduplicated by skill against its still-open objectives, which
        // also keeps a re-run idempotent:
        //   * an ACTIVE plan (signed by both parties) → merged, and journaled;
        //   * a DRAFT nobody has signed yet → merged (nothing signed changes);
        //   * a draft ONE party already signed → skipped, said so: adding to it
        //     would make the second signature activate a document the first
        //     signer never saw;
        //   * this cycle's own plan already completed/archived → skipped.
        const existing = await db.all(
            `SELECT id, employee_id, cycle_id, status::text AS status FROM idp_plans
              WHERE cycle_id = ? OR status IN ('draft', 'active')`,
            [cycleId]
        );
        const alreadyHasPlan = new Set();
        const openPlanOf = new Map(); // employeeId -> { id, status }
        const cyclePlanOnly = new Set();
        for (const r of existing) {
            const emp = Number(r.employeeId);
            if ((r.status === 'active' || r.status === 'draft') && r.id != null) {
                openPlanOf.set(emp, { id: Number(r.id), status: r.status });
            } else {
                alreadyHasPlan.add(emp);
                if (r.status && Number(r.cycleId) === Number(cycleId)) cyclePlanOnly.add(emp);
            }
        }
        for (const emp of openPlanOf.keys()) {
            alreadyHasPlan.delete(emp);
            cyclePlanOnly.delete(emp);
        }
        let mergedObjectives = 0;
        let deduped = 0;
        const mergedPlans = new Set();
        // Per-plan cache of the skills that already carry an open objective.
        const openSkillsOf = new Map();
        const openSkills = async (idpId) => {
            if (!openSkillsOf.has(idpId)) {
                const rows = await db.all(
                    `SELECT skill_id FROM idp_objectives
                      WHERE idp_id = ? AND state IN ('pending', 'in_progress') AND skill_id IS NOT NULL`,
                    [idpId]
                );
                openSkillsOf.set(idpId, new Set((rows || []).map((o) => Number(o.skillId))));
            }
            return openSkillsOf.get(idpId);
        };
        // A draft is mergeable only while nobody has signed it.
        const draftSigned = new Map();
        const isSignedDraft = async (idpId) => {
            if (!draftSigned.has(idpId)) {
                const s = await db.get(
                    'SELECT COUNT(*)::int AS n FROM idp_signoffs WHERE idp_id = ?',
                    [idpId]
                );
                draftSigned.set(idpId, Boolean(s && Number(s.n) > 0));
            }
            return draftSigned.get(idpId);
        };

        // A SKIP IS REPORTED, NEVER SILENT — a silent skip is what let this defect
        // sit unnoticed. One entry per employee, carrying the reason.
        const skipped = [];
        const skippedSeen = new Set();
        const noteSkip = (employeeId, reason) => {
            if (skippedSeen.has(employeeId)) return;
            skippedSeen.add(employeeId);
            skipped.push({ employeeId, reason });
        };

        // Atomic: a plan + its objectives/actions/links must commit together, else a
        // mid-loop failure leaves orphaned half-built plans the dashboard then counts.
        /** objective + its default action + the skill link, under plan `idpId`. */
        const writeObjective = async (idpId, g) => {
            const smart = template(g.skillName, g.currentLevel, g.requiredLevel, dueTxt);
            const obj = await db.run(
                `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, due_on, priority, state)
                 VALUES (?, ?, ?, ?, 'medium', 'pending')`,
                [idpId, g.skillId, smart, dueOn]
            );
            const act = await db.run(
                `INSERT INTO idp_actions (idp_id, objective_id, type, title, status)
                 VALUES (?, ?, ?, ?, 'pending')`,
                [
                    idpId,
                    obj.lastID,
                    DEFAULT_TYPE,
                    `${g.skillName} — close gap to L${g.requiredLevel}`,
                ]
            );
            await db.run(`INSERT INTO action_skill_links (action_id, skill_id) VALUES (?, ?)`, [
                act.lastID,
                g.skillId,
            ]);
            return obj.lastID;
        };

        await db.runTransaction(async () => {
            for (const g of gaps) {
                const empId = Number(g.employeeId);
                if (alreadyHasPlan.has(empId)) {
                    noteSkip(
                        empId,
                        cyclePlanOnly.has(empId) ? 'cycle_plan_exists' : 'open_plan_exists'
                    );
                    continue;
                }
                const open = openPlanOf.get(empId);
                if (open) {
                    if (open.status === 'draft' && (await isSignedDraft(open.id))) {
                        alreadyHasPlan.add(empId);
                        noteSkip(empId, 'open_plan_partially_signed');
                        continue;
                    }
                    const skills = await openSkills(open.id);
                    if (skills.has(Number(g.skillId))) {
                        deduped++;
                        continue;
                    }
                    try {
                        await db.runInSavepoint(async () => {
                            const objectiveId = await writeObjective(open.id, g);
                            await db.run(
                                `INSERT INTO idp_plan_events (idp_id, objective_id, action, from_state, to_state, actor_type, detail)
                                 VALUES (?, ?, 'objective_merged', ?, ?, 'system', ?)`,
                                [
                                    open.id,
                                    objectiveId,
                                    open.status,
                                    open.status,
                                    JSON.stringify({
                                        cycleId: Number(cycleId),
                                        skillId: Number(g.skillId),
                                    }),
                                ]
                            );
                        });
                        skills.add(Number(g.skillId));
                        mergedPlans.add(open.id);
                        mergedObjectives++;
                        created++;
                    } catch (e) {
                        alreadyHasPlan.add(empId);
                        noteSkip(empId, `error: ${(e && e.message) || 'unknown'}`);
                    }
                    continue;
                }
                // Each person's writes sit in their OWN savepoint. The pre-check above
                // closes the ordinary case; this closes the race (a plan created between
                // the check and the insert) so one collision can only cost that one
                // person their draft, never the whole cycle's.
                const planExistedBefore = idpByEmp.has(g.employeeId);
                try {
                    await db.runInSavepoint(async () => {
                        // Result rows are camelCase (the driver maps snake_case → camelCase),
                        // so use g.employeeId / g.skillId etc. — using snake_case here silently
                        // yields undefined, which collapsed every employee's gaps into one plan.
                        let idpId = idpByEmp.get(g.employeeId);
                        if (!idpId) {
                            const r = await db.run(
                                `INSERT INTO idp_plans (employee_id, cycle_id, status, priority)
                                 VALUES (?, ?, 'draft', 'medium')`,
                                [g.employeeId, cycleId]
                            );
                            idpId = r.lastID;
                            idpByEmp.set(g.employeeId, idpId);
                        }
                        await writeObjective(idpId, g);
                    });
                    created++;
                } catch (e) {
                    // The savepoint already rolled this person's writes back and left the
                    // transaction usable. Drop the plan id if it died with them, and stop
                    // retrying them on their remaining gaps.
                    if (!planExistedBefore) idpByEmp.delete(g.employeeId);
                    alreadyHasPlan.add(empId);
                    noteSkip(
                        empId,
                        e && e.code === '23505'
                            ? 'open_plan_exists'
                            : `error: ${(e && e.message) || 'unknown'}`
                    );
                }
            }
        });

        if (skipped.length) {
            const detail =
                `${skipped.length} employee(s) skipped: ` +
                skipped.map((s) => `${s.employeeId} (${s.reason})`).join(', ');
            console.warn(`[idp] cycle ${cycleId} — ${detail}`);
            // Put it where an operator looks, not only in a server log line.
            try {
                await require('./LogService').log({
                    action: 'IDP_DRAFTS_SKIPPED',
                    entityType: 'assessmentCycle',
                    entityId: Number(cycleId),
                    details: detail,
                });
            } catch (_) {
                /* the audit line must never cost the generated plans */
            }
        }
        return {
            plans: idpByEmp.size,
            gaps: created,
            skipped,
            merged: {
                plans: mergedPlans.size,
                objectives: mergedObjectives,
                deduplicated: deduped,
            },
        };
    }

    /**
     * Manager-initiated IDP: create a draft plan for one employee, seeded with an
     * objective+action per selected skill gap. Mirrors the generateDrafts write
     * shape (plan → objective → action → action_skill_link) but is triggered on
     * demand instead of at cycle close. Returns { idpId }.
     */
    static async createManualPlan({
        employeeId,
        priority = 'medium',
        skillIds = [],
        locale = 'fr',
        dueOn = null,
        dueDays = DEFAULT_DUE_DAYS,
    }) {
        const template = SMART_TEMPLATES[locale] || SMART_TEMPLATES.fr;
        // An explicit due date from the manager wins; otherwise the default horizon.
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(dueOn || ''))
            ? String(dueOn)
            : dueIso(dueDays);
        const dueTxt = dueLabel(due, locale);
        const eid = Number(employeeId);
        if (!eid) throw new Error('employeeId required');
        const prio = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';

        // Resolve required/current levels for the chosen skills so the SMART text and
        // action titles are meaningful. Only keep genuine gaps for this employee's role.
        let gaps = [];
        const ids = (skillIds || []).map(Number).filter(Boolean);
        if (ids.length) {
            gaps = await db.all(
                `SELECT s.id AS skill_id, s.name AS skill_name, rsr.required_level AS required_level,
                        sa.current_level AS current_level
                 FROM employees e
                 JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
                 JOIN skills s ON s.id = rsr.skill_id
                 LEFT JOIN skill_assessments sa ON sa.employee_id = e.id AND sa.skill_id = rsr.skill_id
                 WHERE e.id = ? AND rsr.skill_id IN (${ids.map(() => '?').join(',')})`,
                [eid, ...ids]
            );
        }

        // ONE open plan per person (uq_idp_open_per_employee). The automated
        // cycle-close path skips such employees; the manual path surfaced the
        // raw 23505 as an HTTP 500. Pre-check for the ordinary case, and keep a
        // 23505 catch below as the race fallback — both answer the same 409.
        const open = await db.get(
            `SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft', 'active') LIMIT 1`,
            [eid]
        );
        if (open) throw openPlanError(eid, open.id);

        let idpId = null;
        try {
            await db.runTransaction(async () => {
                const r = await db.run(
                    `INSERT INTO idp_plans (employee_id, status, priority) VALUES (?, 'draft', ?)`,
                    [eid, prio]
                );
                idpId = r.lastID;
                for (const g of gaps) {
                    const smart = template(g.skillName, g.currentLevel, g.requiredLevel, dueTxt);
                    const obj = await db.run(
                        `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, due_on, priority, state)
                         VALUES (?, ?, ?, ?, ?, 'pending')`,
                        [idpId, g.skillId, smart, due, prio]
                    );
                    const act = await db.run(
                        `INSERT INTO idp_actions (idp_id, objective_id, type, title, status)
                         VALUES (?, ?, ?, ?, 'pending')`,
                        [
                            idpId,
                            obj.lastID,
                            DEFAULT_TYPE,
                            `${g.skillName} — close gap to L${g.requiredLevel}`,
                        ]
                    );
                    await db.run(
                        `INSERT INTO action_skill_links (action_id, skill_id) VALUES (?, ?)`,
                        [act.lastID, g.skillId]
                    );
                }
            });
        } catch (e) {
            if (
                e &&
                e.code === '23505' &&
                /uq_idp_open_per_employee/.test(String(e.constraint || e.message || ''))
            ) {
                throw openPlanError(eid, null);
            }
            throw e;
        }
        // Tell the employee a development plan now exists for them (digest-tier).
        try {
            await require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: eid,
                    kind: 'idp.created',
                    category: 'talent',
                    payload: { link: '/v2/idp' },
                })
                .catch(() => {});
        } catch (_) {
            /* never block */
        }
        return { idpId, objectives: gaps.length };
    }

    // =====================================================================
    //  PLAN LIFECYCLE (3.23.17, F3).
    //
    //  A plan used to go draft → active and stop there: no completion, no
    //  archive, no objective ever left 'pending'. With one open plan allowed
    //  per person (uq_idp_open_per_employee), that first plan then blocked
    //  every later one for good. The moves below close the loop:
    //    active    → completed   by the plan's authority; every objective closed,
    //                            or an explicit reason for the ones still open;
    //    active    → archived    by the plan's authority, reason required;
    //    completed → archived    by the plan's authority (reason optional);
    //    objective pending → in_progress → completed, on an ACTIVE plan.
    //  Every move names its actor and reason (idp_plans.closed_* and the
    //  append-only idp_plan_events journal). Nothing is deleted; the open
    //  objectives of a plan completed with a reason stay exactly as they were.
    // =====================================================================

    /**
     * Who may ACT on a plan (create, sign the supervisor slot, move, close an
     * action with an official rating): the person's DIRECT line — their
     * supervisor, or their manager of either type (an employee manager, or the
     * admin account named manager) — or an admin whose clearance covers the
     * person. NEVER the subject (by either of their accounts), never a
     * read-only delegate. routes/v2-idp.js canManageEmployee delegates here.
     *
     * 3.23.18 — the rest of the reporting SUB-TREE READS, it does not act.
     * That is the rule self-assessment, 9-box and coaching already apply (an
     * indirect manager sees the review, the direct line decides it); the IDP
     * alone let any N+2 manager — or a linked admin account through its
     * person's sub-tree — sign, create and close plans for people they do not
     * directly govern. Reading stays with canAccessIdp (sub-tree).
     */
    static async planAuthority(user, plan) {
        if (!user || !plan) return { canAct: false, isSubject: false };
        const RBACService = require('./RBACService');
        const EmployeeModel = require('../models/EmployeeModel');
        const GovernanceService = require('./GovernanceService');
        const personId = await GovernanceService.actingPersonId(user);
        const isSubject = personId != null && Number(personId) === Number(plan.employeeId);
        if (isSubject) return { canAct: false, isSubject: true };
        if (RBACService.isViewer(user)) return { canAct: false, isSubject: false };
        const emp = await EmployeeModel.findById(plan.employeeId);
        if (!emp) return { canAct: false, isSubject: false };
        const isAdmin = user.userType === 'admin';
        if (
            isAdmin &&
            (RBACService.isSuperAdmin(user) || (await RBACService.canAccessEmployeeData(user, emp)))
        ) {
            return { canAct: true, isSubject: false };
        }
        if (isAdmin && emp.managerType === 'admin' && Number(emp.managerId) === Number(user.id)) {
            return { canAct: true, isSubject: false };
        }
        if (personId != null) {
            const pid = Number(personId);
            if (
                (emp.supervisorId != null && Number(emp.supervisorId) === pid) ||
                (emp.managerType === 'employee' &&
                    emp.managerId != null &&
                    Number(emp.managerId) === pid)
            ) {
                return { canAct: true, isSubject: false };
            }
            // No sub-tree clause here, deliberately (see the doc comment): an
            // indirect manager reads the plan, they do not act on it.
        }
        return { canAct: false, isSubject: false };
    }

    static async _loadPlan(idpId) {
        const plan = await db.get(
            `SELECT id, employee_id AS "employeeId", status::text AS "status" FROM idp_plans WHERE id = ?`,
            [Number(idpId)]
        );
        if (!plan) throw lifecycleError('IDP_NOT_FOUND', 404, 'IDP not found', 'idp:err_not_found');
        return plan;
    }

    static async _assertAuthority(user, plan) {
        const auth = await IDPService.planAuthority(user, plan);
        if (!auth.canAct) {
            throw auth.isSubject
                ? lifecycleError(
                      'IDP_OWN_PLAN',
                      403,
                      'You cannot close or move your own development plan.',
                      'idp:err_own_plan'
                  )
                : lifecycleError(
                      'IDP_FORBIDDEN',
                      403,
                      'Not authorized to manage this development plan.',
                      'idp:err_forbidden'
                  );
        }
        return auth;
    }

    static async _planEvent(
        idpId,
        objectiveId,
        action,
        fromState,
        toState,
        user,
        reason,
        detail = null
    ) {
        await db.run(
            `INSERT INTO idp_plan_events (idp_id, objective_id, action, from_state, to_state, actor_type, actor_id, reason, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                Number(idpId),
                objectiveId != null ? Number(objectiveId) : null,
                action,
                fromState,
                toState,
                user && user.userType ? String(user.userType) : null,
                user && user.id != null ? Number(user.id) : null,
                reason || null,
                detail ? JSON.stringify(detail) : null,
            ]
        );
    }

    static async _audit(user, action, idpId, details) {
        try {
            await require('./LogService').log({
                category: 'audit',
                action,
                entityType: 'idp_plan',
                entityId: Number(idpId),
                adminId: user && user.userType === 'admin' ? Number(user.id) : null,
                actorRef:
                    user && user.userType !== 'admin' && user.id != null
                        ? `${user.userType}:${user.id}`
                        : null,
                details,
            });
        } catch (_) {
            /* the journal row is the record of truth */
        }
    }

    /** active → completed. */
    static async completePlan({ idpId, user, reason = null }) {
        const plan = await IDPService._loadPlan(idpId);
        await IDPService._assertAuthority(user, plan);
        if (plan.status !== 'active') {
            throw lifecycleError(
                'IDP_NOT_ACTIVE',
                409,
                `Only an active plan can be completed (this one is '${plan.status}').`,
                'idp:err_not_active',
                { status: plan.status }
            );
        }
        const why = String(reason == null ? '' : reason)
            .trim()
            .slice(0, 1000);
        const openRow = await db.get(
            `SELECT COUNT(*)::int AS n FROM idp_objectives WHERE idp_id = ? AND state IN ('pending', 'in_progress')`,
            [plan.id]
        );
        const openObjectives = openRow ? Number(openRow.n) || 0 : 0;
        if (openObjectives > 0 && !why) {
            throw lifecycleError(
                'IDP_OPEN_OBJECTIVES',
                400,
                `${openObjectives} objective(s) are still open: close them first, or give a reason to complete the plan anyway.`,
                'idp:err_open_objectives',
                { count: openObjectives }
            );
        }
        await db.runTransaction(async () => {
            const row = await db.get(
                `UPDATE idp_plans
                    SET status = 'completed', closed_at = now(), closed_by_type = ?, closed_by_id = ?,
                        close_reason = ?, updated_at = now()
                  WHERE id = ? AND status = 'active'
                  RETURNING id`,
                [String(user.userType), Number(user.id), why || null, plan.id]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_STALE',
                    409,
                    'This plan was changed by someone else meanwhile.',
                    'idp:err_stale'
                );
            await IDPService._planEvent(
                plan.id,
                null,
                'plan_completed',
                'active',
                'completed',
                user,
                why,
                { openObjectives }
            );
        });
        await IDPService._audit(
            user,
            'IDP_COMPLETED',
            plan.id,
            `PDI #${plan.id} terminé` +
                (openObjectives
                    ? ` avec ${openObjectives} objectif(s) encore ouvert(s) — motif : ${why}`
                    : '')
        );
        return { completed: true, openObjectives };
    }

    /** active | completed → archived. */
    static async archivePlan({ idpId, user, reason = null }) {
        const plan = await IDPService._loadPlan(idpId);
        await IDPService._assertAuthority(user, plan);
        if (!['active', 'completed'].includes(plan.status)) {
            throw lifecycleError(
                'IDP_NOT_ARCHIVABLE',
                409,
                `Only an active or completed plan can be archived (this one is '${plan.status}').`,
                'idp:err_not_archivable',
                { status: plan.status }
            );
        }
        const why = String(reason == null ? '' : reason)
            .trim()
            .slice(0, 1000);
        // Archiving a LIVE plan stops it: that needs a reason. Archiving a
        // completed one is filing.
        if (plan.status === 'active' && !why) {
            throw lifecycleError(
                'IDP_REASON_REQUIRED',
                400,
                'A reason is required to archive an active plan.',
                'idp:err_reason_required'
            );
        }
        await db.runTransaction(async () => {
            const row = await db.get(
                plan.status === 'active'
                    ? `UPDATE idp_plans
                          SET status = 'archived', closed_at = now(), closed_by_type = ?, closed_by_id = ?,
                              close_reason = ?, updated_at = now()
                        WHERE id = ? AND status = 'active'
                        RETURNING id`
                    : `UPDATE idp_plans SET status = 'archived', updated_at = now()
                        WHERE id = ? AND status = 'completed'
                        RETURNING id`,
                plan.status === 'active'
                    ? [String(user.userType), Number(user.id), why, plan.id]
                    : [plan.id]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_STALE',
                    409,
                    'This plan was changed by someone else meanwhile.',
                    'idp:err_stale'
                );
            await IDPService._planEvent(
                plan.id,
                null,
                'plan_archived',
                plan.status,
                'archived',
                user,
                why
            );
        });
        await IDPService._audit(
            user,
            'IDP_ARCHIVED',
            plan.id,
            `PDI #${plan.id} archivé (depuis « ${plan.status} »)` + (why ? ` — motif : ${why}` : '')
        );
        return { archived: true, from: plan.status };
    }

    /** Objective pending → in_progress → completed, on an ACTIVE plan. */
    static async setObjectiveState({ objectiveId, user, state, note = null }) {
        const target = String(state || '');
        if (!['in_progress', 'completed'].includes(target)) {
            throw lifecycleError(
                'IDP_OBJECTIVE_STATE',
                400,
                'An objective can only be set in progress or completed.',
                'idp:err_objective_state'
            );
        }
        const obj = await db.get(
            `SELECT o.id, o.idp_id AS "idpId", o.state::text AS "state"
               FROM idp_objectives o WHERE o.id = ?`,
            [Number(objectiveId)]
        );
        if (!obj)
            throw lifecycleError(
                'IDP_OBJECTIVE_NOT_FOUND',
                404,
                'Objective not found',
                'idp:err_objective_not_found'
            );
        const plan = await IDPService._loadPlan(obj.idpId);
        await IDPService._assertAuthority(user, plan);
        if (plan.status !== 'active') {
            throw lifecycleError(
                'IDP_NOT_ACTIVE',
                409,
                `Objectives move only on an active plan (this one is '${plan.status}').`,
                'idp:err_not_active',
                { status: plan.status }
            );
        }
        const allowedFrom = target === 'in_progress' ? ['pending'] : ['pending', 'in_progress'];
        if (!allowedFrom.includes(obj.state)) {
            throw lifecycleError(
                'IDP_OBJECTIVE_TRANSITION',
                409,
                `Cannot move an objective from '${obj.state}' to '${target}'.`,
                'idp:err_objective_transition',
                { from: obj.state, to: target }
            );
        }
        const why = String(note == null ? '' : note)
            .trim()
            .slice(0, 1000);
        await db.runTransaction(async () => {
            const row = await db.get(
                `UPDATE idp_objectives SET state = ?, updated_at = now()
                  WHERE id = ? AND state = ? RETURNING id`,
                [target, obj.id, obj.state]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_STALE',
                    409,
                    'This objective was changed by someone else meanwhile.',
                    'idp:err_stale'
                );
            await IDPService._planEvent(
                plan.id,
                obj.id,
                'objective_state',
                obj.state,
                target,
                user,
                why
            );
        });
        return { objectiveId: Number(obj.id), from: obj.state, to: target };
    }

    /** Tests / migration runner: forget what we learned about idp_signoffs. */
    static _resetSchemaCache() {
        signoffUserTypeColumn = null;
    }

    /**
     * Dual sign-off. Only a DRAFT plan can be signed; a cancelled, completed or
     * archived one is refused (409) rather than "signed". `activated` is derived
     * from the row the status='draft'-guarded UPDATE actually returned, so the
     * caller — and the idp.activated notification — can no longer be told a plan
     * went live when nothing changed.
     *
     * `userType` ('employee' | 'manager' | 'admin' — the CHECK on the column) is
     * optional for legacy callers. An admin can never be the EMPLOYEE party
     * (admin and employee ids are different id spaces), so that combination is
     * refused outright. Once idp_signoffs.user_type exists (migration 104:
     * NOT NULL DEFAULT 'employee') it is written verbatim when supplied — and
     * simply left to its DEFAULT when not, never written as NULL — and an
     * 'employee'-slot row carrying user_type='admin' no longer counts towards
     * activation.
     */
    static async signOff({ idpId, role, userId, userType = null, ip, ua }) {
        const signerType =
            userType == null
                ? null
                : ['employee', 'manager', 'admin'].includes(String(userType))
                  ? String(userType)
                  : 'employee';
        if (role === 'employee' && signerType === 'admin') {
            const e = new Error('An administrator cannot sign as the employee party of an IDP.');
            e.code = 'IDP_SIGNER_MISMATCH';
            e.status = 403;
            e.expose = true;
            throw e;
        }
        const plan = await db.get(
            `SELECT id, employee_id AS "employeeId", status::text AS "status" FROM idp_plans WHERE id = ?`,
            [idpId]
        );
        if (!plan) {
            const e = new Error('IDP not found');
            e.status = 404;
            e.expose = true;
            throw e;
        }
        if (plan.status !== 'draft') throw notDraftError(idpId, plan.status);

        const withType = await hasSignoffUserType();
        if (withType && signerType) {
            await db.run(
                `INSERT INTO idp_signoffs (idp_id, role, user_id, user_type, ip, ua)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (idp_id, role) DO NOTHING`,
                [idpId, role, userId, signerType, ip, ua || null]
            );
        } else {
            await db.run(
                `INSERT INTO idp_signoffs (idp_id, role, user_id, ip, ua)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (idp_id, role) DO NOTHING`,
                [idpId, role, userId, ip, ua || null]
            );
        }
        // Activate when both roles have signed — and, once the column exists,
        // only when the employee slot was signed by a non-admin.
        const rows = await db.all(
            withType
                ? `SELECT role, user_type AS "userType" FROM idp_signoffs WHERE idp_id = ?`
                : `SELECT role FROM idp_signoffs WHERE idp_id = ?`,
            [idpId]
        );
        const roles = new Set(
            rows
                .filter((r) => !(withType && r.role === 'employee' && r.userType === 'admin'))
                .map((r) => r.role)
        );
        if (!(roles.has('employee') && roles.has('supervisor'))) return { activated: false };

        const activatedRow = await db.get(
            `UPDATE idp_plans SET status = 'active' WHERE id = ? AND status = 'draft' RETURNING id`,
            [idpId]
        );
        if (!activatedRow) return { activated: false };

        // Both parties signed → the plan is live: tell the employee and their
        // LINE (3.23.18 R2, ReportingLineService): the ACTIVE effective reviewer
        // + the manager (employee OR admin) when different. The old
        // COALESCE(supervisor_id, manager) lookup told a departed supervisor and
        // never an admin manager. Digest-tier, in-app.
        try {
            const N = require('./NotificationService');
            const empId = Number(plan.employeeId);
            if (empId) {
                await N.notify({
                    userType: 'employee',
                    userId: empId,
                    kind: 'idp.activated',
                    category: 'talent',
                    payload: { link: '/v2/idp' },
                }).catch(() => {});
                const recipients = await require('./ReportingLineService')
                    .lineRecipients(empId)
                    .catch(() => []);
                for (const r of recipients) {
                    await N.notify({
                        userType: r.userType,
                        userId: r.id,
                        kind: 'idp.activated',
                        category: 'talent',
                        payload: { link: '/v2/idp' },
                    }).catch(() => {});
                }
            }
        } catch (_) {
            /* never block sign-off */
        }
        return { activated: true };
    }
}

module.exports = IDPService;
