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

/** A YYYY-MM-DD string kept as is, anything else null (a date input's value). */
function isoDayOrNull(v) {
    const t = String(v == null ? '' : v).trim();
    if (t.length !== 10 || t[4] !== '-' || t[7] !== '-') return null;
    const d = new Date(t + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
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

// The seeded action title was English whatever the plan's language ("X —
// close gap to L3" on a French plan). Written at creation in the plan's locale,
// the same rule as SMART_TEMPLATES above (the service has a locale, not req.t).
const ACTION_TITLE = {
    en: (skill, required) => `${skill} — reach level ${required}`,
    fr: (skill, required) => `${skill} — atteindre le niveau ${required}`,
};
const ACTION_TYPES = [
    'training',
    'coaching',
    'mentoring',
    'on_the_job',
    'self_study',
    'certification',
    'stretch',
];

class IDPService {
    static ACTION_TYPES = ACTION_TYPES;
    static ACTION_TITLE = ACTION_TITLE;

    /**
     * Add an objective to a plan from its detail page. The page used to be a
     * dead end: nothing could be added once the draft existed. Same authority
     * as every other move (planAuthority: the direct line or an in-scope
     * admin, never the subject), on a draft or active plan only; every add is
     * journalled.
     */
    static async addObjective({
        idpId,
        user,
        smartText,
        skillId = null,
        dueOn = null,
        locale = 'fr',
        seedAction = true,
    }) {
        const text = String(smartText == null ? '' : smartText)
            .trim()
            .slice(0, 2000);
        if (!text)
            throw lifecycleError(
                'IDP_TEXT_REQUIRED',
                400,
                'Text required',
                'idp:err_text_required'
            );
        const plan = await IDPService._loadPlan(idpId);
        await IDPService._assertAuthority(user, plan);
        IDPService._assertOpen(plan);
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(dueOn || '')) ? String(dueOn) : null;
        const skill = Number(skillId) || null;
        let id = null;
        await db.runTransaction(async () => {
            const r = await db.get(
                `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, due_on, priority, state)
                 VALUES (?, ?, ?, ?, 'medium', 'pending') RETURNING id`,
                [plan.id, skill, text, due]
            );
            id = r ? Number(r.id) : null;
            await IDPService._planEvent(
                plan.id,
                id,
                'objective_added',
                null,
                'pending',
                user,
                null,
                { skillId: skill }
            );
            // An objective on a skill gets one seeded action (the createManualPlan
            // shape), so there is something to do and to validate: an objective
            // with no action could never move a level.
            if (skill && seedAction) {
                const actionId = await IDPService._seedAction(plan, id, skill, locale);
                if (actionId)
                    await IDPService._planEvent(
                        plan.id,
                        id,
                        'action_added',
                        null,
                        'pending',
                        user,
                        null,
                        { actionId, type: DEFAULT_TYPE, skillId: skill, seeded: true }
                    );
            }
        });
        return { objectiveId: Number(id), idpId: Number(plan.id) };
    }

    /** The default action of a skill objective (title in the plan's locale) + its skill link. */
    static async _seedAction(plan, objectiveId, skillId, locale) {
        const info = await db.get(
            `SELECT s.name AS "name", rsr.required_level AS "required"
               FROM skills s
               LEFT JOIN employees e ON e.id = ?
               LEFT JOIN role_skill_requirements rsr
                      ON rsr.role_id = COALESCE(?, e.role_id) AND rsr.skill_id = s.id
              WHERE s.id = ?`,
            [Number(plan.employeeId), plan.targetRoleId || null, Number(skillId)]
        );
        if (!info) return null;
        const title =
            info.required != null
                ? (ACTION_TITLE[locale] || ACTION_TITLE.fr)(info.name, info.required)
                : String(info.name);
        const a = await db.get(
            `INSERT INTO idp_actions (idp_id, objective_id, type, title, status)
             VALUES (?, ?, ?, ?, 'pending') RETURNING id`,
            [Number(plan.id), Number(objectiveId), DEFAULT_TYPE, title]
        );
        await db.run(
            'INSERT INTO action_skill_links (action_id, skill_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
            [Number(a.id), Number(skillId)]
        );
        return Number(a.id);
    }

    /** Add an action to a plan, optionally linked to one of ITS objectives. */
    static async addAction({
        idpId,
        user,
        title,
        type = DEFAULT_TYPE,
        description = null,
        objectiveId = null,
        skillId = null,
        plannedHours = null,
        dueOn = null,
    }) {
        const text = String(title == null ? '' : title)
            .trim()
            .slice(0, 500);
        if (!text)
            throw lifecycleError(
                'IDP_TEXT_REQUIRED',
                400,
                'Text required',
                'idp:err_text_required'
            );
        const kind = ACTION_TYPES.includes(String(type)) ? String(type) : DEFAULT_TYPE;
        const plan = await IDPService._loadPlan(idpId);
        await IDPService._assertAuthority(user, plan);
        IDPService._assertOpen(plan);
        // An objective id only counts when it belongs to THIS plan.
        let obj = null;
        let objSkill = null;
        if (Number(objectiveId)) {
            const row = await db.get(
                'SELECT id, skill_id FROM idp_objectives WHERE id = ? AND idp_id = ?',
                [Number(objectiveId), plan.id]
            );
            obj = row ? Number(row.id) : null;
            objSkill = row && row.skillId != null ? Number(row.skillId) : null;
        }
        // An action carries a skill (the one chosen, else its objective's) so
        // that its validation can measure it. Without one it still closes, as
        // evidence only. A chosen skill must exist.
        let skill = Number(skillId) || null;
        if (skill) {
            const ok = await db.get('SELECT id FROM skills WHERE id = ?', [skill]);
            if (!ok) skill = null;
        }
        if (!skill) skill = objSkill;
        const hours = IDPService._hours(plannedHours, 'plannedHours');
        const due = isoDayOrNull(dueOn);
        const desc = String(description == null ? '' : description)
            .trim()
            .slice(0, 2000);
        let id = null;
        await db.runTransaction(async () => {
            const r = await db.get(
                `INSERT INTO idp_actions (idp_id, objective_id, type, title, description, status,
                                          estimated_hours, due_on)
                 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
                [
                    plan.id,
                    obj,
                    kind,
                    text,
                    desc || null,
                    hours == null ? null : Math.round(hours),
                    due,
                ]
            );
            id = r ? Number(r.id) : null;
            if (skill) {
                await db.run(
                    'INSERT INTO action_skill_links (action_id, skill_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
                    [id, skill]
                );
            }
            await IDPService._planEvent(plan.id, obj, 'action_added', null, 'pending', user, null, {
                actionId: Number(id),
                type: kind,
                skillId: skill,
            });
        });
        return { actionId: Number(id), idpId: Number(plan.id), skillId: skill };
    }

    static _assertOpen(plan) {
        if (!['draft', 'active'].includes(String(plan.status))) {
            throw lifecycleError(
                'IDP_NOT_OPEN',
                409,
                `Only a draft or active plan takes new objectives (this one is '${plan.status}').`,
                'idp:err_not_open',
                { status: plan.status }
            );
        }
    }

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
                    (ACTION_TITLE[locale] || ACTION_TITLE.fr)(g.skillName, g.requiredLevel),
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
        targetRoleId = null,
        user = null,
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
        let target = Number(targetRoleId) || null;
        if (target) {
            const role = await db.get('SELECT id FROM roles WHERE id = ?', [target]);
            if (!role) target = null;
        }
        if (target) {
            // A plan TOWARDS a target role (career path). A skill the target role
            // requires is measured against the TARGET's level and tagged with it
            // (idp_objectives.target_role_id); a skill only the current role
            // requires stays against the current role. Nothing chosen is dropped.
            // No skill chosen: every target-role requirement not met yet, the
            // never-assessed ones included (not assessed, never level 0).
            const pick = ids.length
                ? `AND rsr.skill_id IN (${ids.map(() => '?').join(',')})`
                : 'AND rsr.role_id = ? AND (sa.current_level IS NULL OR sa.current_level < rsr.required_level)';
            gaps = await db.all(
                `SELECT DISTINCT ON (s.id) s.id AS skill_id, s.name AS skill_name,
                        rsr.required_level AS required_level, sa.current_level AS current_level,
                        CASE WHEN rsr.role_id = ? THEN ?::bigint END AS target_role_id
                   FROM employees e
                   JOIN role_skill_requirements rsr ON rsr.role_id IN (e.role_id, ?)
                   JOIN skills s ON s.id = rsr.skill_id
                   LEFT JOIN skill_assessments sa ON sa.employee_id = e.id AND sa.skill_id = rsr.skill_id
                  WHERE e.id = ? AND rsr.required_level > 0
                    ${pick}
                  ORDER BY s.id, (rsr.role_id = ?) DESC`,
                [target, target, target, eid, ...(ids.length ? ids : [target]), target]
            );
        } else if (ids.length) {
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
            `SELECT id, status::text AS "status" FROM idp_plans
              WHERE employee_id = ? AND status IN ('draft', 'active') LIMIT 1`,
            [eid]
        );
        // "Create the plan towards this role" on someone who already has an open
        // plan ADDS the target-role objectives to it (an active plan, or a draft
        // nobody signed yet) instead of refusing; skills that already carry an
        // open objective are skipped. A draft one party signed is refused as
        // before: the second signature must never activate unseen objectives.
        if (open && target) {
            const signed = await db.get(
                'SELECT COUNT(*)::int AS n FROM idp_signoffs WHERE idp_id = ?',
                [open.id]
            );
            if (!(open.status === 'draft' && signed && Number(signed.n) > 0)) {
                const have = await db.all(
                    `SELECT skill_id FROM idp_objectives
                      WHERE idp_id = ? AND state IN ('pending', 'in_progress') AND skill_id IS NOT NULL`,
                    [open.id]
                );
                const has = new Set((have || []).map((h) => Number(h.skillId)));
                let added = 0;
                await db.runTransaction(async () => {
                    await db.run('UPDATE idp_plans SET target_role_id = ? WHERE id = ?', [
                        target,
                        open.id,
                    ]);
                    for (const g of gaps) {
                        if (has.has(Number(g.skillId))) continue;
                        await IDPService._writePlanObjective(open.id, g, {
                            template,
                            dueTxt,
                            due,
                            prio,
                            locale,
                        });
                        added++;
                    }
                    await IDPService._planEvent(
                        open.id,
                        null,
                        'target_role_merged',
                        open.status,
                        open.status,
                        user,
                        null,
                        { targetRoleId: target, objectives: added }
                    );
                });
                return { idpId: Number(open.id), objectives: added, merged: true };
            }
        }
        if (open) throw openPlanError(eid, open.id);

        let idpId = null;
        try {
            await db.runTransaction(async () => {
                const r = await db.run(
                    `INSERT INTO idp_plans (employee_id, status, priority, target_role_id)
                     VALUES (?, 'draft', ?, ?)`,
                    [eid, prio, target]
                );
                idpId = r.lastID;
                for (const g of gaps) {
                    if (target) {
                        await IDPService._writePlanObjective(idpId, g, {
                            template,
                            dueTxt,
                            due,
                            prio,
                            locale,
                        });
                        continue;
                    }
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
                            (ACTION_TITLE[locale] || ACTION_TITLE.fr)(g.skillName, g.requiredLevel),
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

    /** An objective (tagged with its target role when it has one), its seeded action and skill link. */
    static async _writePlanObjective(idpId, g, { template, dueTxt, due, prio, locale }) {
        const smart = template(g.skillName, g.currentLevel, g.requiredLevel, dueTxt);
        const obj = await db.get(
            `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, due_on, priority, state, target_role_id)
             VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING id`,
            [
                Number(idpId),
                g.skillId,
                smart,
                due,
                prio,
                g.targetRoleId == null ? null : Number(g.targetRoleId),
            ]
        );
        const act = await db.get(
            `INSERT INTO idp_actions (idp_id, objective_id, type, title, status)
             VALUES (?, ?, ?, ?, 'pending') RETURNING id`,
            [
                Number(idpId),
                Number(obj.id),
                DEFAULT_TYPE,
                (ACTION_TITLE[locale] || ACTION_TITLE.fr)(g.skillName, g.requiredLevel),
            ]
        );
        await db.run('INSERT INTO action_skill_links (action_id, skill_id) VALUES (?, ?)', [
            Number(act.id),
            g.skillId,
        ]);
        return Number(obj.id);
    }

    /**
     * "Add to my development plan" from a 360° report: one objective per chosen
     * skill, appended to the person's OPEN plan (draft or active), or to a new
     * draft plan when they have none. The subject acts on their own behalf here
     * — it is their plan and their feedback — so this does not go through
     * planAuthority (which governs what a MANAGER may do to someone's plan). The
     * caller (Feedback360Service.addToIdp) has already checked that the report
     * is the subject's own and released.
     *
     * A skill that already has an open objective on that plan is skipped, so a
     * second click adds nothing. Each addition is journalled (idp_plan_events).
     *
     * @param {object} args
     * @param {number} args.employeeId  the plan's owner
     * @param {Array<{skillId:number, skillName:string, required:number|null, others:number|null}>} args.items
     * @param {string} [args.locale]
     * @param {object} [args.user]     the actor, for the journal
     * @returns {Promise<{idpId:number, created:boolean, added:number, skipped:number}>}
     */
    static async addObjectivesFromFeedback({ employeeId, items = [], locale = 'fr', user = null }) {
        const eid = Number(employeeId);
        if (!eid) throw new Error('employeeId required');
        const en = String(locale || 'fr')
            .toLowerCase()
            .startsWith('en');
        const due = dueIso(DEFAULT_DUE_DAYS);
        const dueTxt = dueLabel(due, en ? 'en' : 'fr');
        const text = (it) => {
            const lvl = it.required === null || it.required === undefined ? null : it.required;
            if (en) {
                return lvl === null
                    ? `By ${dueTxt}, strengthen ${it.skillName}, as pointed out by my 360° feedback.`
                    : `By ${dueTxt}, work towards level ${lvl} in ${it.skillName}, as pointed out by my 360° feedback.`;
            }
            return lvl === null
                ? `D'ici le ${dueTxt}, renforcer ${it.skillName}, point relevé par mon feedback 360°.`
                : `D'ici le ${dueTxt}, progresser vers le niveau ${lvl} en ${it.skillName}, point relevé par mon feedback 360°.`;
        };
        let idpId = null;
        let created = false;
        let added = 0;
        let skipped = 0;
        await db.runTransaction(async () => {
            let plan = await db.get(
                `SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft','active')
                  ORDER BY created_at DESC LIMIT 1`,
                [eid]
            );
            if (!plan) {
                plan = await db.get(
                    `INSERT INTO idp_plans (employee_id, status, priority) VALUES (?, 'draft', 'medium')
                     ON CONFLICT (employee_id) WHERE status IN ('draft','active') DO NOTHING RETURNING id`,
                    [eid]
                );
                if (plan) created = true;
                else
                    plan = await db.get(
                        `SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft','active')
                          ORDER BY created_at DESC LIMIT 1`,
                        [eid]
                    );
            }
            idpId = Number(plan.id);
            for (const it of items) {
                const sid = Number(it && it.skillId);
                if (!sid) {
                    skipped++;
                    continue;
                }
                const exists = await db.get(
                    `SELECT 1 AS ok FROM idp_objectives
                      WHERE idp_id = ? AND skill_id = ? AND state IN ('pending','in_progress') LIMIT 1`,
                    [idpId, sid]
                );
                if (exists) {
                    skipped++;
                    continue;
                }
                const obj = await db.get(
                    `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, due_on, priority, state)
                     VALUES (?, ?, ?, ?, 'medium', 'pending') RETURNING id`,
                    [idpId, sid, text(it), due]
                );
                await IDPService._planEvent(
                    idpId,
                    obj.id,
                    'objective_added',
                    null,
                    'pending',
                    user,
                    null,
                    { source: 'feedback360' }
                );
                added++;
            }
        });
        return { idpId, created, added, skipped };
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
     * 3.23.18 — the rest of the reporting SUB-TREE READS, it does not act
     * (strict mode of the authority ladder, the default; the SuperAdmin setting
     * authority.ladder = extended lets the line above act as the manager).
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
        // The authority ladder, extended mode only (AuthorityService): the line
        // above acts as the manager. Strict mode (the default) adds nothing.
        const wide = await require('./AuthorityService').widen(user, 'idp.act', emp);
        if (wide.ok) return { canAct: true, isSubject: false, as: wide.as };
        return { canAct: false, isSubject: false };
    }

    static async _loadPlan(idpId) {
        const plan = await db.get(
            `SELECT id, employee_id AS "employeeId", status::text AS "status",
                    target_role_id AS "targetRoleId"
               FROM idp_plans WHERE id = ?`,
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
                // the authority-ladder rung the act used (` as=<rung>`)
                details: require('./AuthorityService').withAs(details, user),
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
        // What the plan achieved, recorded with the completion: skills at the
        // required level out of the plan's skills (live official levels; a
        // never-assessed skill is not met and is counted apart, never as 0).
        const prog = await IDPService.objectivesProgress(plan.id).catch(() => ({}));
        const withSkill = Object.values(prog).filter((p) => p.skillId != null);
        const outcome = {
            skillsTotal: withSkill.length,
            skillsMet: withSkill.filter((p) => p.met).length,
            skillsUnmeasured: withSkill.filter((p) => p.current == null).length,
        };
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
                { openObjectives, ...outcome }
            );
        });
        await IDPService._notify('employee', plan.employeeId, 'idp.completed', {
            link: '/v2/idp/' + Number(plan.id),
            ...outcome,
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
        return { completed: true, openObjectives, ...outcome };
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

    // =====================================================================
    //  THE ACTION LOOP (4.0.0 port, wave 4).
    //
    //  An action used to be a static line: nobody could start it, say it was
    //  done or validate it, so a plan never moved a level. Now:
    //    pending --start--> in_progress --reported done (the person)-->
    //    in_progress + reported_done_at --validate (the line)--> completed
    //  The PERSON starts their action and reports it done; only the line
    //  validates it (planAuthority: the direct line, a local administrator in
    //  clearance, a SuperAdmin, and the line above only in the extended mode
    //  of the authority ladder), with the level it OBSERVED on the action's
    //  skill (0-4), or "cannot judge yet" (evidence only, no level). An
    //  observed level becomes the official one through
    //  ActionEffectivenessService (history trigger, real actor) in the same
    //  transaction as the validation. Every move is an idp_plan_events row.
    // =====================================================================

    static async _loadAction(actionId) {
        const a = await db.get(
            `SELECT a.id, a.idp_id AS "idpId", a.objective_id AS "objectiveId",
                    a.status::text AS "status", a.type::text AS "type", a.title,
                    a.reported_done_at AS "reportedDoneAt"
               FROM idp_actions a WHERE a.id = ?`,
            [Number(actionId)]
        );
        if (!a)
            throw lifecycleError(
                'IDP_ACTION_NOT_FOUND',
                404,
                'Action not found',
                'idp:err_action_not_found'
            );
        return a;
    }

    /** Is this account the plan's person (by either of their accounts)? */
    static async _isSubject(user, plan) {
        if (!user || user.id == null) return false;
        const { personIdOf } = require('../utils/personIdentity');
        const pid = await personIdOf(user);
        return pid != null && Number(pid) === Number(plan.employeeId);
    }

    static _assertActionOpen(plan, act) {
        if (plan.status !== 'active') {
            throw lifecycleError(
                'IDP_NOT_ACTIVE',
                409,
                `Actions move only on an active plan (this one is '${plan.status}').`,
                'idp:err_not_active',
                { status: plan.status }
            );
        }
        if (act.status === 'completed' || act.status === 'cancelled') {
            throw lifecycleError(
                'IDP_ACTION_CLOSED',
                409,
                `This action is already '${act.status}'.`,
                'idp:err_action_closed'
            );
        }
    }

    /** Hours as entered (comma or point), 0-2000, one decimal; empty = null (not entered). */
    static _hours(v, field = 'hours') {
        if (v === undefined || v === null || String(v).trim() === '') return null;
        const n = Number(String(v).trim().replace(',', '.'));
        if (!Number.isFinite(n) || n < 0 || n > 2000) {
            throw lifecycleError(
                'IDP_HOURS',
                400,
                `${field} must be a number of hours between 0 and 2000.`,
                'idp:err_hours'
            );
        }
        return Math.round(n * 10) / 10;
    }

    /** pending -> in_progress: the person, or the line. */
    static async startAction({ actionId, user }) {
        const act = await IDPService._loadAction(actionId);
        const plan = await IDPService._loadPlan(act.idpId);
        if (!(await IDPService._isSubject(user, plan)))
            await IDPService._assertAuthority(user, plan);
        IDPService._assertActionOpen(plan, act);
        if (act.status !== 'pending') {
            throw lifecycleError(
                'IDP_ACTION_TRANSITION',
                409,
                `Cannot start an action from '${act.status}'.`,
                'idp:err_action_transition'
            );
        }
        await db.runTransaction(async () => {
            const row = await db.get(
                `UPDATE idp_actions SET status = 'in_progress', started_at = COALESCE(started_at, now()),
                        updated_at = now()
                  WHERE id = ? AND status = 'pending' RETURNING id`,
                [act.id]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_STALE',
                    409,
                    'This action was changed by someone else meanwhile.',
                    'idp:err_stale'
                );
            await IDPService._planEvent(
                plan.id,
                act.objectiveId,
                'action_started',
                'pending',
                'in_progress',
                user,
                null,
                { actionId: Number(act.id) }
            );
        });
        return { actionId: Number(act.id), idpId: Number(plan.id), status: 'in_progress' };
    }

    /**
     * The PERSON reports the action done, with a short note and the hours spent.
     * No official effect: the action waits for the line's validation, and the
     * line is told (idp.action_reported).
     */
    static async reportActionDone({ actionId, user, note = null, hours = null }) {
        const act = await IDPService._loadAction(actionId);
        const plan = await IDPService._loadPlan(act.idpId);
        if (!(await IDPService._isSubject(user, plan))) {
            throw lifecycleError(
                'IDP_NOT_SUBJECT',
                403,
                'Only the person the plan is for reports an action done; the line validates it.',
                'idp:err_not_subject'
            );
        }
        IDPService._assertActionOpen(plan, act);
        if (act.reportedDoneAt) {
            throw lifecycleError(
                'IDP_ACTION_REPORTED',
                409,
                'This action was already reported done; it waits for validation.',
                'idp:err_action_reported'
            );
        }
        const why = String(note == null ? '' : note)
            .trim()
            .slice(0, 1000);
        const spent = IDPService._hours(hours);
        await db.runTransaction(async () => {
            const row = await db.get(
                `UPDATE idp_actions
                    SET status = 'in_progress', started_at = COALESCE(started_at, now()),
                        reported_done_at = now(), reported_note = ?, reported_by_type = ?,
                        reported_by_id = ?, actual_hours = COALESCE(?, actual_hours), updated_at = now()
                  WHERE id = ? AND status IN ('pending', 'in_progress') AND reported_done_at IS NULL
                  RETURNING id`,
                [
                    why || null,
                    user.userType === 'admin' ? 'admin' : String(user.userType),
                    Number(user.id),
                    spent,
                    act.id,
                ]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_STALE',
                    409,
                    'This action was changed by someone else meanwhile.',
                    'idp:err_stale'
                );
            await IDPService._planEvent(
                plan.id,
                act.objectiveId,
                'action_reported_done',
                act.status,
                'in_progress',
                user,
                why || null,
                { actionId: Number(act.id), hours: spent }
            );
        });
        await IDPService._markDueActed(plan.employeeId);
        await IDPService._notifyLine(plan, 'idp.action_reported', {
            link: `/v2/idp/${Number(plan.id)}#action-${Number(act.id)}`,
            actionId: Number(act.id),
            employeeId: Number(plan.employeeId),
        });
        return { actionId: Number(act.id), idpId: Number(plan.id), reported: true };
    }

    /**
     * The line validates an action with the level it OBSERVED on the action's
     * skill (0-4), or with no level ("cannot judge yet": evidence only).
     * Never the person. The observed level goes through
     * ActionEffectivenessService (rating before and after, official level when
     * it is higher, history trigger) in ONE transaction with the validation.
     */
    static async validateAction({
        actionId,
        user,
        observedLevel = null,
        note = null,
        actualHours = null,
    }) {
        const act = await IDPService._loadAction(actionId);
        const plan = await IDPService._loadPlan(act.idpId);
        await IDPService._assertAuthority(user, plan);
        IDPService._assertActionOpen(plan, act);
        let level = null;
        if (observedLevel !== null && observedLevel !== undefined && String(observedLevel) !== '') {
            level = Number(observedLevel);
            if (!Number.isInteger(level) || level < 0 || level > 4) {
                throw lifecycleError(
                    'IDP_LEVEL',
                    400,
                    'The observed level must be an integer between 0 and 4.',
                    'idp:err_level'
                );
            }
        }
        const hours = IDPService._hours(actualHours, 'actualHours');
        const why = String(note == null ? '' : note)
            .trim()
            .slice(0, 1000);
        const AE = require('./ActionEffectivenessService');
        const skill = await AE.skillOfAction(act.id);
        const measured = level != null && skill != null;
        const assessedBy = measured ? await AE.assessorAdminId(user) : null;
        let effect = null;
        const work = async () => {
            if (measured) {
                effect = await AE.onActionClose({
                    actionId: act.id,
                    postRating: level,
                    employeeId: plan.employeeId,
                    assessedByAdminId: assessedBy,
                    updateOfficial: true,
                    evidenceSource: 'observation',
                });
            } else {
                await db.run(
                    `UPDATE idp_actions SET status = 'completed', completed_at = now(),
                            started_at = COALESCE(started_at, now()), updated_at = now()
                      WHERE id = ?`,
                    [act.id]
                );
            }
            await db.run(
                `UPDATE idp_actions
                    SET validated_by_type = ?, validated_by_id = ?, validation_note = ?,
                        actual_hours = COALESCE(?, actual_hours)
                  WHERE id = ?`,
                [
                    user.userType === 'admin' ? 'admin' : String(user.userType),
                    Number(user.id),
                    why || null,
                    hours,
                    act.id,
                ]
            );
            await IDPService._planEvent(
                plan.id,
                act.objectiveId,
                'action_validated',
                act.status,
                'completed',
                user,
                why || null,
                {
                    actionId: Number(act.id),
                    skillId: skill ? skill.skillId : null,
                    observedLevel: measured ? level : null,
                    ratingPre: effect ? effect.ratingPre : null,
                    officialUpdated: Boolean(effect && effect.officialUpdated),
                    source: 'observation',
                    hours,
                }
            );
        };
        // withActor opens the transaction and tags it with the real actor, so the
        // history trigger records the validator (a nested call would not).
        await db.withActor(user, work);
        await IDPService._audit(
            user,
            'IDP_ACTION_VALIDATED',
            plan.id,
            `action #${Number(act.id)}` +
                (measured
                    ? `; skill #${skill.skillId}: ${effect && effect.ratingPre != null ? effect.ratingPre : 'not assessed'} -> observed ${level}${effect && effect.officialUpdated ? ' (official)' : ''}`
                    : '; evidence only')
        );
        await IDPService._markDueActed(plan.employeeId);
        await require('./NotificationService').actedQuietly({
            refType: 'idp_action',
            refId: Number(act.id),
        });
        await IDPService._notify('employee', plan.employeeId, 'idp.action_validated', {
            link: `/v2/idp/${Number(plan.id)}#action-${Number(act.id)}`,
            actionId: Number(act.id),
        });
        const objective = act.objectiveId
            ? await IDPService.objectiveProgress(act.objectiveId)
            : null;
        return {
            actionId: Number(act.id),
            idpId: Number(plan.id),
            observedLevel: measured ? level : null,
            evidenceOnly: !measured,
            ratingPre: effect ? effect.ratingPre : null,
            officialUpdated: Boolean(effect && effect.officialUpdated),
            objectiveMet: Boolean(objective && objective.met),
        };
    }

    /**
     * Give an action a training. With `courseId` the course is assigned through
     * the LMS with this action as its source (its accepted completion later
     * closes the action). Without an LMS the action keeps a date, a place and
     * planned hours (an offline training): never a dead button.
     */
    static async planTraining({
        actionId,
        user,
        courseId = null,
        dueOn = null,
        place = null,
        plannedHours = null,
    }) {
        const act = await IDPService._loadAction(actionId);
        const plan = await IDPService._loadPlan(act.idpId);
        await IDPService._assertAuthority(user, plan);
        if (
            !['draft', 'active'].includes(plan.status) ||
            ['completed', 'cancelled'].includes(act.status)
        ) {
            throw lifecycleError(
                'IDP_ACTION_CLOSED',
                409,
                'This action can no longer be planned.',
                'idp:err_action_closed'
            );
        }
        const due = isoDayOrNull(dueOn);
        const hours = IDPService._hours(plannedHours, 'plannedHours');
        const where = String(place == null ? '' : place)
            .trim()
            .slice(0, 200);
        const course = Number(courseId) || null;
        if (!course && !due) {
            throw lifecycleError(
                'IDP_TRAINING_DATE',
                400,
                'An offline training needs a date.',
                'idp:err_training_date'
            );
        }
        if (course) {
            const known = await db.get('SELECT id FROM lms_courses WHERE id = ?', [course]);
            if (!known)
                throw lifecycleError(
                    'IDP_COURSE_NOT_FOUND',
                    404,
                    'Course not found',
                    'idp:err_course_not_found'
                );
        }
        let enrollment = null;
        if (course) {
            const { actorAdminId } = require('../utils/actorAdminId');
            enrollment = await require('./LmsService').assignCourse(plan.employeeId, course, {
                assignedBy: await actorAdminId(user),
                sourceActionId: Number(act.id),
                dueAt: due,
            });
        }
        await db.runTransaction(async () => {
            await db.run(
                `UPDATE idp_actions
                    SET due_on = COALESCE(?, due_on), place = COALESCE(?, place),
                        estimated_hours = COALESCE(?, estimated_hours), updated_at = now()
                  WHERE id = ?`,
                [due, where || null, hours == null ? null : Math.round(hours), act.id]
            );
            await IDPService._planEvent(
                plan.id,
                act.objectiveId,
                'action_training_planned',
                act.status,
                act.status,
                user,
                null,
                {
                    actionId: Number(act.id),
                    courseId: course,
                    dueOn: due,
                    plannedHours: hours,
                    offline: !course,
                }
            );
        });
        return {
            actionId: Number(act.id),
            idpId: Number(plan.id),
            enrollmentId: enrollment ? Number(enrollment.id) : null,
            pushState: enrollment ? enrollment.pushState : null,
        };
    }

    /**
     * A training completion whose uplift the line ACCEPTED closes the plan
     * actions that ordered the course (lms_enrollments.source_action_id), with
     * an action_effectiveness row (source "training"). Called by
     * LmsService.decideUplift inside its transaction. Returns the closed ids.
     */
    static async closeActionsFromTraining({ employeeId, courseId, raised = [], user = null }) {
        const rows = await db.all(
            `SELECT a.id, a.idp_id AS "idpId", a.objective_id AS "objectiveId", a.status::text AS "status"
               FROM lms_enrollments e
               JOIN idp_actions a ON a.id = e.source_action_id
               JOIN idp_plans p ON p.id = a.idp_id
              WHERE e.employee_id = ? AND e.course_id = ? AND p.employee_id = e.employee_id
                AND a.status::text NOT IN ('completed', 'cancelled')`,
            [Number(employeeId), Number(courseId)]
        );
        const AE = require('./ActionEffectivenessService');
        const closed = [];
        for (const a of rows || []) {
            const skill = await AE.skillOfAction(a.id);
            const hit = skill
                ? raised.find((r) => Number(r.skillId) === Number(skill.skillId))
                : null;
            if (hit) {
                await AE._writeEffectiveness(a.id, {
                    ratingPre: hit.from == null ? null : Number(hit.from),
                    postRating: Number(hit.to),
                    uplift: hit.from == null ? null : Number(hit.to) - Number(hit.from),
                    evidenceSource: 'training',
                    official: true,
                });
            }
            await db.run(
                `UPDATE idp_actions SET status = 'completed', completed_at = now(),
                        started_at = COALESCE(started_at, now()), updated_at = now(),
                        validated_by_type = ?, validated_by_id = ?
                  WHERE id = ?`,
                [
                    user ? (user.userType === 'admin' ? 'admin' : String(user.userType)) : null,
                    user && user.id != null ? Number(user.id) : null,
                    a.id,
                ]
            );
            await IDPService._planEvent(
                a.idpId,
                a.objectiveId,
                'action_validated',
                a.status,
                'completed',
                user,
                null,
                {
                    actionId: Number(a.id),
                    source: 'training',
                    courseId: Number(courseId),
                    skillId: skill ? skill.skillId : null,
                    observedLevel: hit ? Number(hit.to) : null,
                }
            );
            closed.push(Number(a.id));
        }
        if (closed.length) await IDPService._markDueActed(employeeId);
        return closed;
    }

    /**
     * A finished course with nothing to propose (no skill mapping, or the level
     * is already reached) is still evidence: the plan action it served is
     * marked reported done ("system") for the line to validate. It never
     * closes itself: the line names the level.
     */
    static async reportActionsFromTraining({ employeeId, courseId }) {
        const r = await db.all(
            `UPDATE idp_actions a SET reported_done_at = COALESCE(a.reported_done_at, now()),
                    status = 'in_progress', started_at = COALESCE(a.started_at, now()),
                    reported_by_type = COALESCE(a.reported_by_type, 'system'), updated_at = now()
               FROM lms_enrollments e
               JOIN idp_plans p ON p.employee_id = e.employee_id
              WHERE e.source_action_id = a.id AND e.employee_id = ? AND e.course_id = ?
                AND p.id = a.idp_id AND p.status = 'active'
                AND a.status::text NOT IN ('completed', 'cancelled')
             RETURNING a.id`,
            [Number(employeeId), Number(courseId)]
        );
        return (r || []).map((x) => Number(x.id));
    }

    /**
     * The live state of one objective: its skill, the level required (of the
     * target role when the objective carries one, else of the person's role),
     * the person's current OFFICIAL level (null = not assessed) and whether it
     * is met.
     */
    static async objectiveProgress(objectiveId) {
        const o = await db.get(
            `SELECT o.id, o.skill_id AS "skillId", o.state::text AS "state",
                    sa.current_level AS "current", rsr.required_level AS "required"
               FROM idp_objectives o
               JOIN idp_plans p ON p.id = o.idp_id
               JOIN employees e ON e.id = p.employee_id
               LEFT JOIN skill_assessments sa ON sa.employee_id = p.employee_id AND sa.skill_id = o.skill_id
               LEFT JOIN role_skill_requirements rsr
                      ON rsr.role_id = COALESCE(o.target_role_id, e.role_id) AND rsr.skill_id = o.skill_id
              WHERE o.id = ?`,
            [Number(objectiveId)]
        );
        if (!o || o.skillId == null) return null;
        const current = o.current == null ? null : Number(o.current);
        const required = o.required == null ? null : Number(o.required);
        return {
            objectiveId: Number(o.id),
            skillId: Number(o.skillId),
            state: o.state,
            current,
            required,
            met: current != null && required != null && current >= required,
        };
    }

    /** The live progress of every objective of a plan: a Map-like object keyed by objective id. */
    static async objectivesProgress(idpId) {
        const rows = await db.all(
            `SELECT o.id, o.skill_id AS "skillId", s.name AS "skillName",
                    sa.current_level AS "current", rsr.required_level AS "required",
                    o.target_role_id AS "targetRoleId", r.name AS "targetRoleName"
               FROM idp_objectives o
               JOIN idp_plans p ON p.id = o.idp_id
               JOIN employees e ON e.id = p.employee_id
               LEFT JOIN skills s ON s.id = o.skill_id
               LEFT JOIN roles r ON r.id = o.target_role_id
               LEFT JOIN skill_assessments sa ON sa.employee_id = p.employee_id AND sa.skill_id = o.skill_id
               LEFT JOIN role_skill_requirements rsr
                      ON rsr.role_id = COALESCE(o.target_role_id, e.role_id) AND rsr.skill_id = o.skill_id
              WHERE o.idp_id = ?`,
            [Number(idpId)]
        );
        // Keys are database ids (numbers), never client input.
        const out = Object.create(null);
        for (const r of rows || []) {
            const current = r.current == null ? null : Number(r.current);
            const required = r.required == null ? null : Number(r.required);
            out[Number(r.id)] = {
                skillId: r.skillId == null ? null : Number(r.skillId),
                skillName: r.skillName || null,
                current,
                required,
                met:
                    r.skillId != null && current != null && required != null && current >= required,
                targetRoleId: r.targetRoleId == null ? null : Number(r.targetRoleId),
                targetRoleName: r.targetRoleName || null,
            };
        }
        return out;
    }

    static async _notify(userType, userId, kind, payload) {
        try {
            await require('./NotificationService')
                .notify({
                    userType,
                    userId: Number(userId),
                    kind,
                    category: 'development',
                    payload,
                })
                .catch(() => {});
        } catch (_) {
            /* a notification never blocks the act */
        }
    }

    /**
     * An action reported, validated or closed by a training closes the weekly
     * "development actions due" reminder of its person (reminder
     * effectiveness counts it as acted).
     */
    static async _markDueActed(employeeId) {
        try {
            await require('./NotificationService')
                .markActed({
                    userType: 'employee',
                    userId: Number(employeeId),
                    kinds: ['idp.action_due'],
                })
                .catch(() => 0);
        } catch (_) {
            /* never block */
        }
    }

    static async _notifyLine(plan, kind, payload) {
        try {
            const recipients = await require('./ReportingLineService')
                .lineRecipients(Number(plan.employeeId))
                .catch(() => []);
            for (const r of recipients || [])
                await IDPService._notify(r.userType, r.id, kind, payload);
        } catch (_) {
            /* never block */
        }
    }

    // =====================================================================
    //  PROPOSALS (4.0.0 port, wave 4). The person PROPOSES (never acts on
    //  their plan); the line accepts the proposal into the plan or declines it
    //  with a reason. With no line, the proposal goes to HR: the local
    //  administrators whose clearance covers the person. Table dev_proposals
    //  (migration 192).
    // =====================================================================

    static async proposeAction({ user, skillId = null, type = DEFAULT_TYPE, text }) {
        const { personIdOf } = require('../utils/personIdentity');
        const emp = user && user.userType !== 'admin' ? await personIdOf(user) : null;
        if (emp == null) {
            throw lifecycleError(
                'IDP_PROPOSAL_EMPLOYEE_ONLY',
                403,
                'Only an employee proposes an action for their own development.',
                'idp:err_proposal_employee'
            );
        }
        const body = String(text == null ? '' : text)
            .trim()
            .slice(0, 500);
        if (!body)
            throw lifecycleError(
                'IDP_TEXT_REQUIRED',
                400,
                'Text required',
                'idp:err_text_required'
            );
        const kind = ACTION_TYPES.includes(String(type)) ? String(type) : DEFAULT_TYPE;
        // A skill counts only when the person is measured on it (their role) or
        // their plan aims at a role that requires it; anything else is dropped.
        let skill = Number(skillId) || null;
        if (skill) {
            const ok = await db.get(
                `SELECT 1 AS "ok" FROM employees e
                  WHERE e.id = ? AND (
                        EXISTS (SELECT 1 FROM role_skill_requirements r
                                 WHERE r.role_id = e.role_id AND r.skill_id = ?)
                     OR EXISTS (SELECT 1 FROM idp_plans p
                                  JOIN role_skill_requirements r ON r.role_id = p.target_role_id
                                 WHERE p.employee_id = e.id AND p.status IN ('draft', 'active')
                                   AND r.skill_id = ?))`,
                [Number(emp), skill, skill]
            );
            if (!ok) skill = null;
        }
        const line = await require('./ReportingLineService')
            .lineRecipients(Number(emp))
            .catch(() => []);
        const routedTo = line && line.length ? 'line' : 'hr';
        // A double submit of the same sentence is the same proposal.
        const dup = await db.get(
            `SELECT id FROM dev_proposals WHERE employee_id = ? AND status = 'pending'
                AND proposal_text = ? AND COALESCE(skill_id, 0) = COALESCE(?::bigint, 0)`,
            [Number(emp), body, skill]
        );
        if (dup) return { proposalId: Number(dup.id), routedTo, duplicate: true };
        const row = await db.get(
            `INSERT INTO dev_proposals (employee_id, skill_id, action_type, proposal_text, routed_to)
             VALUES (?, ?, ?, ?, ?) RETURNING id`,
            [Number(emp), skill, kind, body, routedTo]
        );
        const payload = {
            link: '/v2/idp/manage#proposals',
            proposalId: Number(row.id),
            employeeId: Number(emp),
        };
        if (routedTo === 'line') {
            for (const r of line)
                await IDPService._notify(r.userType, r.id, 'idp.proposal_received', payload);
        } else {
            for (const a of await IDPService._hrRecipients(Number(emp)))
                await IDPService._notify('admin', a, 'idp.proposal_received', payload);
        }
        return { proposalId: Number(row.id), routedTo };
    }

    /** Local administrators whose clearance covers the person (the HR fallback). */
    static async _hrRecipients(employeeId) {
        try {
            const admins = await db.all(
                `SELECT id, role::text AS "role" FROM admins
                  WHERE is_active = true AND role::text = 'localadmin' ORDER BY id`
            );
            const out = [];
            const RBACService = require('./RBACService');
            for (const a of admins || []) {
                const acct = { id: Number(a.id), userType: 'admin', role: a.role };
                const ok = await RBACService.canAccessEmployee(acct, Number(employeeId)).catch(
                    () => false
                );
                if (ok) out.push(Number(a.id));
            }
            return out;
        } catch (_) {
            return [];
        }
    }

    /** The pending proposals this reader may decide (line, or HR by clearance). */
    static async pendingProposalsFor(user) {
        let rows = [];
        try {
            rows = await db.all(
                `SELECT dp.id, dp.employee_id AS "employeeId", dp.skill_id AS "skillId", s.name AS "skillName",
                        dp.action_type AS "actionType", dp.proposal_text AS "text", dp.routed_to AS "routedTo",
                        dp.created_at AS "createdAt", e.first_name AS "firstName", e.last_name AS "lastName"
                   FROM dev_proposals dp
                   JOIN employees e ON e.id = dp.employee_id AND e.is_active AND e.erased_at IS NULL
                   LEFT JOIN skills s ON s.id = dp.skill_id
                  WHERE dp.status = 'pending'
                  ORDER BY dp.created_at, dp.id`
            );
        } catch (_) {
            return [];
        }
        const out = [];
        for (const r of rows || []) {
            const auth = await IDPService.planAuthority(user, { employeeId: r.employeeId }).catch(
                () => ({ canAct: false })
            );
            if (auth.canAct) out.push(r);
        }
        return out;
    }

    /**
     * Accept (an action in the person's open plan; a draft plan is created
     * when none is open) or decline (a reason is required; the person reads it).
     */
    static async decideProposal({ proposalId, user, decision, reason = null }) {
        const p = await db.get(
            `SELECT id, employee_id AS "employeeId", skill_id AS "skillId", action_type AS "actionType",
                    proposal_text AS "text", status FROM dev_proposals WHERE id = ?`,
            [Number(proposalId)]
        );
        if (!p)
            throw lifecycleError(
                'IDP_PROPOSAL_NOT_FOUND',
                404,
                'Proposal not found',
                'idp:err_proposal_not_found'
            );
        await IDPService._assertAuthority(user, { employeeId: p.employeeId });
        if (p.status !== 'pending') {
            throw lifecycleError(
                'IDP_PROPOSAL_DECIDED',
                409,
                'This proposal was already decided.',
                'idp:err_proposal_decided'
            );
        }
        if (decision !== 'accept' && decision !== 'decline')
            throw lifecycleError('IDP_BAD_DECISION', 400, 'Bad decision', 'idp:err_bad_decision');
        const why = String(reason == null ? '' : reason)
            .trim()
            .slice(0, 1000);
        const decider = user.userType === 'admin' ? 'admin' : String(user.userType);
        if (decision === 'decline') {
            if (!why)
                throw lifecycleError(
                    'IDP_REASON_REQUIRED',
                    400,
                    'A reason is required to decline.',
                    'idp:err_decline_reason_required'
                );
            const row = await db.get(
                `UPDATE dev_proposals SET status = 'declined', decided_by_type = ?, decided_by_id = ?,
                        decided_at = now(), decision_reason = ?, updated_at = now()
                  WHERE id = ? AND status = 'pending' RETURNING id`,
                [decider, Number(user.id), why, p.id]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_PROPOSAL_DECIDED',
                    409,
                    'This proposal was already decided.',
                    'idp:err_proposal_decided'
                );
            await IDPService._notify('employee', p.employeeId, 'idp.proposal_decided', {
                link: '/v2/idp/propose',
            });
            await IDPService._markProposalActed(p.id);
            return { proposalId: Number(p.id), decision: 'decline' };
        }
        let plan = await db.get(
            `SELECT id, employee_id AS "employeeId", status::text AS "status" FROM idp_plans
              WHERE employee_id = ? AND status IN ('draft', 'active') ORDER BY id DESC LIMIT 1`,
            [p.employeeId]
        );
        let created = null;
        await db.runTransaction(async () => {
            if (!plan) {
                const r = await db.get(
                    `INSERT INTO idp_plans (employee_id, status, priority) VALUES (?, 'draft', 'medium')
                     RETURNING id`,
                    [p.employeeId]
                );
                plan = { id: Number(r.id), employeeId: p.employeeId, status: 'draft' };
                await IDPService._planEvent(
                    plan.id,
                    null,
                    'plan_created_from_proposal',
                    null,
                    'draft',
                    user,
                    null,
                    { proposalId: Number(p.id) }
                );
            }
            let objectiveId = null;
            if (p.skillId) {
                const o = await db.get(
                    `SELECT id FROM idp_objectives WHERE idp_id = ? AND skill_id = ?
                        AND state IN ('pending', 'in_progress') ORDER BY id LIMIT 1`,
                    [plan.id, p.skillId]
                );
                objectiveId = o ? Number(o.id) : null;
            }
            const a = await db.get(
                `INSERT INTO idp_actions (idp_id, objective_id, type, title, status)
                 VALUES (?, ?, ?, ?, 'pending') RETURNING id`,
                [plan.id, objectiveId, p.actionType, p.text]
            );
            created = Number(a.id);
            if (p.skillId) {
                await db.run(
                    'INSERT INTO action_skill_links (action_id, skill_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
                    [created, p.skillId]
                );
            }
            const row = await db.get(
                `UPDATE dev_proposals SET status = 'accepted', idp_id = ?, created_action_id = ?,
                        decided_by_type = ?, decided_by_id = ?, decided_at = now(),
                        decision_reason = ?, updated_at = now()
                  WHERE id = ? AND status = 'pending' RETURNING id`,
                [plan.id, created, decider, Number(user.id), why || null, p.id]
            );
            if (!row)
                throw lifecycleError(
                    'IDP_PROPOSAL_DECIDED',
                    409,
                    'This proposal was already decided.',
                    'idp:err_proposal_decided'
                );
            await IDPService._planEvent(
                plan.id,
                objectiveId,
                'action_added',
                null,
                'pending',
                user,
                null,
                { actionId: created, type: p.actionType, fromProposal: Number(p.id) }
            );
        });
        await IDPService._notify('employee', p.employeeId, 'idp.proposal_decided', {
            link: '/v2/idp/' + Number(plan.id),
        });
        await IDPService._markProposalActed(p.id);
        return {
            proposalId: Number(p.id),
            decision: 'accept',
            idpId: Number(plan.id),
            actionId: created,
        };
    }

    /** A decided proposal closes the "proposal received" notices sent about it. */
    static async _markProposalActed(proposalId) {
        try {
            await require('./NotificationService')
                .markActed({ refType: 'dev_proposal', refId: Number(proposalId) })
                .catch(() => 0);
        } catch (_) {
            /* never block */
        }
    }

    /**
     * A plan is never signed EMPTY: at least one action, and a due date on
     * every objective. 409 with a stable code and the catalogue key.
     */
    static async assertSignable(idpId) {
        const id = Number(idpId);
        const r = await db.get(
            `SELECT (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = ?)::int AS "actions",
                    (SELECT COUNT(*) FROM idp_objectives o
                      WHERE o.idp_id = ? AND o.due_on IS NULL)::int AS "undated"`,
            [id, id]
        );
        const missing = [];
        if (!r || !Number(r.actions)) missing.push('action');
        if (r && Number(r.undated) > 0) missing.push('due_date');
        if (!missing.length) return true;
        const e = lifecycleError(
            'IDP_NOT_SIGNABLE',
            409,
            'This plan cannot be signed yet: add at least one action and a due date to every objective.',
            missing.includes('action') ? 'idp:err_not_signable_action' : 'idp:err_not_signable_due',
            { count: Number(r && r.undated) || 0 }
        );
        e.missing = missing;
        throw e;
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
