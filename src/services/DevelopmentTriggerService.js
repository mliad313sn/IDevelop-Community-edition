'use strict';
/**
 * DevelopmentTriggerService — single source of truth for the 9-box
 * "placement → development action" automation, shared by the V1
 * (NineBoxService / nine_box_evaluations) and V2 (TalentService /
 * talent_placements) grids.
 *
 *   RED  (low performance: Concern / Dilemma / Diamond-in-the-rough)
 *        → initiate a PIP (proposed) + a coaching/mentoring plan linked to it,
 *          seeded with actions for the employee's top skill gaps.
 *   BLUE (high-potential developers: Shooting Star / Emerging Star)
 *        → propose an IDP (draft) seeded with development objectives.
 *
 * Idempotent (reuses an open PIP/IDP) and defensive (a coaching/authority
 * failure never blocks the PIP/IDP; the whole trigger never throws to callers
 * that wrap it — but callers should still guard).
 *
 * TWO INVARIANTS THIS FILE MUST KEEP:
 *   1. NOTIFY. Every plan created here reaches a human: the PIP goes through
 *      PipService.proposeDirect (the only emitter of 'pip.created') and the IDP
 *      emits 'idp.created' to the employee AND their supervisor. A plan nobody is
 *      told about is a plan that never runs — do not reintroduce a raw INSERT.
 *   2. PROVENANCE. Both rows carry origin_evaluation_id (migration 72) so the
 *      chain ASSESSMENT → 9-box placement → plan is reconstructable by query.
 *      That column is PROVENANCE ONLY and must never be read by an authorization,
 *      clearance or disclosure guard.
 */
const db = require('../config/database');

const DAY = 86400000;
function isoDate(offsetDays = 0) {
    return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

/**
 * LE PLAN DE COACHING QUE LE PRODUIT ÉCRIT LUI-MÊME.
 * ------------------------------------------------------------------------
 * Le plan créé à côté du PIP était rédigé en ANGLAIS SEUL, quelle que soit la
 * langue de la session : titre « Coaching to support PIP », objectif « Improve
 * performance and close the skill gaps identified in the PIP. » et les CINQ
 * actions que le collaborateur coche (« Develop "…" from level 1 to 4 »).
 * Mesuré : `/api/coaching/mine` en FR puis en EN rendait des octets identiques.
 * Aucune de ces phrases n'existait dans `locales/` — ce n'était pas un repli sur
 * clé manquante, c'étaient des littéraux figés en base par le code.
 *
 * CHOIX RETENU : écrire dans la langue de la personne AU MOMENT DE LA CRÉATION,
 * avec des gabarits indexés par locale — exactement le patron déjà en place dans
 * ce produit pour le même genre de texte (`IDPService.SMART_TEMPLATES`).
 *
 * LOT « parité » (finition) — LA VOIE BLEUE AVAIT LE DÉFAUT MIROIR. Le premier
 * correctif a rendu la voie ROUGE (coaching) bilingue et laissé la voie BLEUE
 * (les objectifs du PDI, `_triggerBlue`) en FRANÇAIS CODÉ EN DUR : `_triggerBlue`
 * ne recevait même pas `req`, donc aucune locale ne pouvait l'atteindre. Un
 * lecteur anglophone recevait un plan de développement rédigé en français, ce
 * qui est le constat P2-03 exactement retourné. Les deux voies partagent
 * maintenant LA MÊME phrase d'écart, dans les deux langues : c'est la même
 * mesure décrite au même collaborateur, elle ne doit pas diverger.
 *
 * Pourquoi PAS « stocker une clé et traduire à l'affichage » :
 *   - le titre, l'objectif et les actions sont du texte HR ÉDITABLE
 *     (`CoachingPlanService.addAction`, modification par le superviseur) : dès la
 *     première retouche humaine la colonne mêlerait clés et texte libre ;
 *   - le libellé part déjà en copie figée dans DEUX endroits que ce lot ne
 *     possède pas — la ligne d'audit `COACHING_PLAN_CREATED` et la charge utile
 *     de la notification `coaching.created` ;
 *   - un plan de coaching est un document daté que la personne ET son manager
 *     ont lu et accepté : le réécrire parce que quelqu'un bascule l'interface en
 *     anglais changerait après coup un texte déjà convenu.
 * CONSÉQUENCE ASSUMÉE, dite franchement : un plan créé en français reste en
 * français si la personne passe ensuite l'interface en anglais. Les lignes déjà
 * anglaises en base ne sont pas réparées par ce code — la migration 121 s'en
 * charge, en ne touchant QUE les littéraux produits par la machine.
 *
 * `g.current == null` reste énoncé comme NON MESURÉ, jamais comme un niveau 0
 * que personne n'a relevé.
 */
const COACHING_PIP_TEMPLATES = {
    fr: {
        title: 'Coaching d’accompagnement du plan de performance',
        objective:
            'Améliorer la performance et combler les écarts de compétences identifiés dans le plan de performance.',
        action: (g) =>
            g.current == null
                ? `Atteindre le niveau ${g.required} en « ${g.skillName} » (niveau actuel non évalué)`
                : `Développer « ${g.skillName} » du niveau ${g.current} au niveau ${g.required}`,
    },
    en: {
        title: 'Coaching to support PIP',
        objective: 'Improve performance and close the skill gaps identified in the PIP.',
        action: (g) =>
            g.current == null
                ? `Reach level ${g.required} in "${g.skillName}" (current level not assessed)`
                : `Develop "${g.skillName}" from level ${g.current} to ${g.required}`,
    },
};

/**
 * La langue du texte écrit en base. Aucune colonne de préférence linguistique
 * n'existe sur `employees` (vérifié en base) : la meilleure approximation
 * disponible est la locale de la requête qui déclenche l'ouverture du plan —
 * le produit est francophone d'abord, donc 'fr' par défaut, jamais 'en'.
 */
function planLocale(req) {
    const raw = (req && (req.language || (req.i18n && req.i18n.language))) || '';
    return String(raw).slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr';
}

class DevelopmentTriggerService {
    zoneFor(performance, potential) {
        if (performance === 'low') return 'red';
        if (
            (potential === 'high' && performance === 'medium') ||
            (potential === 'medium' && performance === 'high')
        )
            return 'blue';
        return null;
    }

    /** Parse a V2 "potential-performance" box string into levels. */
    levelsFromBox(box) {
        const [potential, performance] = String(box || '').split('-');
        return { performance, potential };
    }

    // NOTE: the local _actorAdminId copy was dropped when the PIP INSERT moved to
    // PipService.proposeDirect — pips.initiated_by is now resolved by
    // PipService._actorAdminId, so there is exactly one rule for "which admin id
    // owns an auto-created PIP" instead of two that could drift apart.

    /**
     * The employee's hierarchical superior when that is an EMPLOYEE: the ACTIVE
     * supervisor, else the ACTIVE employee-manager (3.23.18 R2 — one rule,
     * ReportingLineService). A departed supervisor is skipped, never returned.
     */
    async _supervisorOf(employeeId) {
        const r = await require('./ReportingLineService')
            .effectiveReviewer(employeeId)
            .catch(() => null);
        return r && r.type === 'employee' && r.id !== Number(employeeId) ? r.id : null;
    }

    /**
     * Notify a recipient, AWAITED and never throwing.
     * Awaited on purpose: these triggers run INSIDE the 9-box approve transaction
     * (NineBoxService.approve wraps everything in db.runTransaction), so a
     * fire-and-forget INSERT could execute after the transaction's client is
     * released and be silently dropped — exactly the failure this task is fixing.
     * Wrapped so a notification failure can never roll back the plan.
     */
    async _notify(userId, kind, link) {
        if (!userId) return null;
        try {
            return await require('./NotificationService').notify({
                userType: 'employee',
                userId: Number(userId),
                kind,
                category: 'talent',
                // CONFIDENTIALITY: payload carries the deep link ONLY — never the
                // 9-box label, performance or potential. Detail stays behind the link.
                payload: { link },
            });
        } catch (_) {
            return null;
        }
    }

    /** Same notification, addressed to an ADMIN recipient (user_type 'admin'). */
    async _notifyAdmin(adminId, kind, link) {
        if (!adminId) return null;
        try {
            return await require('./NotificationService').notify({
                userType: 'admin',
                userId: Number(adminId),
                kind,
                category: 'talent',
                payload: { link },
            });
        } catch (_) {
            return null;
        }
    }

    /** The ACTIVE admin who manages this employee, when the manager is an admin (polymorphic manager_id). */
    async _managingAdminOf(employeeId) {
        const m = await require('./ReportingLineService')
            .managerOf(employeeId)
            .catch(() => null);
        return m && m.type === 'admin' ? m.id : null;
    }

    /**
     * Notify the person's LINE about a plan decision (3.23.18 R2): the
     * effective reviewer (ACTIVE supervisor → ACTIVE employee-manager → ACTIVE
     * admin-manager) AND the manager when different — a PIP task or a new IDP
     * is manager-owned, so the validator must hear of it even when a direct
     * reviewer exists. Departed accounts are never addressed; an admin-managed
     * person still reaches a human (the managing admin, user_type 'admin').
     * @returns {{userType:'employee'|'admin', userId:number,
     *   all:Array<{userType:string, userId:number}>}|null} first = the reviewer
     */
    async _notifyManager(employeeId, kind, link) {
        const recipients = await require('./ReportingLineService')
            .lineRecipients(employeeId, { includeManager: true })
            .catch(() => []);
        if (!recipients.length) return null;
        for (const r of recipients) {
            if (r.userType === 'admin') await this._notifyAdmin(r.id, kind, link);
            else await this._notify(r.id, kind, link);
        }
        const first = { userType: recipients[0].userType, userId: recipients[0].id };
        // `all` is non-enumerable: the documented return stays the reviewer
        // { userType, userId }; callers that need every recipient read `.all`.
        Object.defineProperty(first, 'all', {
            value: recipients.map((r) => ({ userType: r.userType, userId: r.id })),
            enumerable: false,
        });
        return first;
    }

    /**
     * PROVENANCE (migration 72) — resolve the nine_box_evaluations row that caused
     * this trigger, so pips.origin_evaluation_id / idp_plans.origin_evaluation_id
     * make the chain ASSESSMENT → placement → plan reconstructable by query.
     *
     * An explicit placement.evaluationId always wins. Otherwise we look for an
     * evaluation for THIS employee, with THESE levels, approved inside the current
     * transaction window — the 9-box approve path stamps approved_at = now one
     * statement earlier, so it matches; an unrelated V2 talent override (which has
     * no evaluation at all) finds nothing and correctly records NULL rather than
     * borrowing an old, unrelated evaluation.
     *
     * NULL is a normal outcome, and the resulting column is PROVENANCE ONLY —
     * never an input to an authorization or disclosure decision.
     */
    async _resolveOriginEvaluationId(placement) {
        const explicit = placement && (placement.evaluationId ?? placement.originEvaluationId);
        if (explicit) return Number(explicit) || null;
        if (!placement || !placement.performance || !placement.potential) return null;
        try {
            const row = await db.get(
                `SELECT id FROM nine_box_evaluations
                  WHERE employee_id = ? AND status = 'approved'
                    AND performance = ? AND potential = ?
                    AND approved_at >= now() - interval '5 minutes'
                  ORDER BY approved_at DESC, id DESC LIMIT 1`,
                [placement.employeeId, placement.performance, placement.potential]
            );
            return row ? Number(row.id) || null : null;
        } catch (_) {
            return null; // provenance is never worth failing a plan for
        }
    }

    async _topGaps(employeeId, limit = 5) {
        // `current` is the TRUE value: NULL when the skill has never been
        // assessed. It used to be COALESCE(..., 0), and that 0 was written into
        // the IDP objective the employee signs — "Développer X du niveau 0 au
        // niveau 3" asserts a measured incompetence on a competency nobody has
        // ever evaluated. The selection and ordering below still treat an
        // unmeasured requirement as a development need (it is one), so nothing
        // is dropped from the department-designed requirement set.
        //
        // It also used to read raw skill_assessments, which is blind to two
        // things every other surface honours (v_resolved_assessments +
        // v_certification_lapsed): an APPROVED self-assessment that meets the
        // requirement (raw has no row → the plan proposed an objective the
        // canonical view calls met) and a LAPSED certificate (raw still shows
        // the pre-lapse rating → the plan MISSED a critical skill the person can
        // no longer perform). It now reads the resolved view and degrades a lapse
        // to 0, so the objectives written into the IDP/PIP agree with the profile
        // and readiness the manager and employee see everywhere else.
        return db.all(
            `SELECT s.id AS skill_id, s.name AS skill_name, rsr.required_level AS required,
                    CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE ra.level END AS current
             FROM employees e
             JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
             JOIN skills s ON s.id = rsr.skill_id
             LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.id AND ra.skill_id = rsr.skill_id
             LEFT JOIN v_certification_lapsed cl ON cl.employee_id = e.id AND cl.skill_id = rsr.skill_id
             WHERE e.id = ? AND rsr.required_level > 0
               AND rsr.required_level > COALESCE(CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE ra.level END, 0)
             ORDER BY (rsr.required_level - COALESCE(CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE ra.level END, 0)) DESC, rsr.is_critical DESC, s.name
             LIMIT ?`,
            [employeeId, limit]
        );
    }

    /**
     * @param user  the acting user (approver / placer)
     * @param placement { employeeId, performance, potential, label }
     * @returns summary object or null (neutral box)
     */
    async triggerForPlacement(user, placement, req = null) {
        const { employeeId } = placement;
        const zone = this.zoneFor(placement.performance, placement.potential);
        if (!zone) return null;
        const label = placement.label || `${placement.potential}/${placement.performance}`;
        // Provenance for the plan we are about to create (migration 72).
        const originEvaluationId = await this._resolveOriginEvaluationId(placement);

        if (zone === 'red')
            return this._triggerRed(user, employeeId, label, req, originEvaluationId);
        // `req` porte la locale d'écriture : la voie BLEUE en a besoin comme la
        // voie ROUGE (elle l'ignorait, d'où des objectifs de PDI toujours
        // français). Les trois appelants passent déjà `req` jusqu'ici.
        return this._triggerBlue(employeeId, label, originEvaluationId, req);
    }

    /**
     * RED zone — A3: the software proposes, the manager decides.
     *
     * This used to CREATE a performance-improvement plan (plus a coaching plan)
     * inside the 9-box approve transaction. A PIP is the start of a process that
     * can end someone's employment, and it was being opened by nobody, with a
     * boilerplate reason, on a judgement the person had not been shown. Measured
     * on a development database: PIP #12 sat in 'proposed' from 2026-06-15 to its own end date
     * with objectives, success criteria and review checkpoints all NULL.
     *
     * Now it raises ONE task for the person's hierarchical superior. The plan is
     * created only by TalentTaskService/-the manager, with a written reason (see
     * src/routes/v2-pip.js, POST /v2/pip/tasks/:id/open-plan). An already-open
     * PIP means the conversation has happened: no task, nothing to decide.
     */
    async _triggerRed(user, employeeId, label, req, originEvaluationId = null) {
        const openPip = await db.get(
            "SELECT id FROM pips WHERE employee_id = ? AND state IN ('proposed','approved','active') ORDER BY created_at DESC LIMIT 1",
            [employeeId]
        );
        if (openPip) {
            return {
                zone: 'red',
                pipId: openPip.id,
                createdPip: false,
                taskId: null,
                createdTask: false,
                notified: null,
                originEvaluationId,
                existingPlan: true,
            };
        }

        const task = await require('./TalentTaskService').raisePipTask({
            employeeId,
            originEvaluationId,
            originKind: 'ninebox_approval',
        });

        // TELL THE MANAGER. A task nobody is told about is a task that never runs
        // — the same failure the auto-PIP had. The payload carries the deep link
        // ONLY (see _notify): never the box, the label or the coordinates. For an
        // admin-managed employee there is no employee superior, so the managing
        // admin is notified instead (see _notifyManager) — the task no longer
        // reaches nobody.
        let notified = null;
        if (task.created) {
            const recipient = await this._notifyManager(
                employeeId,
                'talent.task.created',
                '/v2/pip'
            );
            const all = (recipient && recipient.all) || [];
            notified = {
                supervisor: all.some((r) => r.userType === 'employee'),
                admin: all.some((r) => r.userType === 'admin'),
            };
        }
        // The EMPLOYEE is deliberately not notified here: nothing has been decided
        // about them yet, and telling them "a task exists about you" would disclose
        // the confidential placement A4 keeps closed.
        return {
            zone: 'red',
            pipId: null,
            createdPip: false,
            taskId: task.id,
            createdTask: task.created,
            notified,
            originEvaluationId,
        };
    }

    /**
     * The coaching/mentoring plan that used to be created beside the automatic
     * PIP. It is support, not judgement, so it survives A3 — but it now hangs off
     * the plan the MANAGER opened, which is the only thing it can be attached to
     * (CoachingPlanService refuses a plan with no IDP, PIP or named skill gap).
     * Called by POST /v2/pip/tasks/:id/open-plan.
     *
     * Best-effort by contract: a coaching authority failure (e.g. the caller does
     * not supervise this employee) must never undo the plan that was just opened.
     *
     * HR2-26 / le texte n'est plus de l'anglais codé en dur : il est pris
     * dans `COACHING_PIP_TEMPLATES` à la locale de la personne (voir l'en-tête de
     * ce fichier pour le choix de conception). La garde F5 (« jamais "from level
     * null" ») est conservée, dans les DEUX langues.
     */
    async createSupportCoaching(user, employeeId, pipId, req = null) {
        const existing = await db.get(
            "SELECT id FROM coaching_plans WHERE employee_id = ? AND pip_id = ? AND state <> 'cancelled' LIMIT 1",
            [employeeId, pipId]
        );
        if (existing)
            return { coachingPlanId: existing.id, createdCoaching: false, coachingError: null };
        let coachingPlanId = null;
        try {
            const CoachingPlanService = require('./CoachingPlanService');
            const gaps = await this._topGaps(employeeId, 5);
            const tpl = COACHING_PIP_TEMPLATES[planLocale(req)];
            const plan = await CoachingPlanService.createPlan(
                user,
                {
                    employeeId,
                    kind: 'coaching',
                    title: tpl.title,
                    objective: tpl.objective,
                    targetDate: isoDate(60),
                    contextType: 'pip',
                    pipId,
                    // A never-assessed starting point is stated as unmeasured, never
                    // as a level 0 nobody recorded. Measured gaps come first — they
                    // are the ones a coach can act on today.
                    actions: gaps
                        .slice()
                        .sort((a, b) => (a.current == null ? 1 : 0) - (b.current == null ? 1 : 0))
                        .map((g) => ({ description: tpl.action(g) })),
                },
                req
            );
            coachingPlanId = plan.id;
            return { coachingPlanId, createdCoaching: true, coachingError: null };
        } catch (e) {
            return {
                coachingPlanId: null,
                createdCoaching: false,
                coachingError: e && e.message ? e.message : 'coaching plan not created',
            };
        }
    }

    async _triggerBlue(employeeId, label, originEvaluationId = null, req = null) {
        let idp = await db.get(
            "SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft','active') ORDER BY created_at DESC LIMIT 1",
            [employeeId]
        );
        let createdIdp = false;
        let objectives = 0;
        let notified = null;
        if (!idp) {
            const gaps = await this._topGaps(employeeId, 5);
            // Atomic: the plan and its objectives must commit together (nest-safe — when
            // called from inside the 9-box approve transaction this joins it via ALS).
            await db.runTransaction(async () => {
                // ON CONFLICT guards a concurrent placement racing between the SELECT
                // above and this INSERT (uq_idp_open_per_employee). Mirrors _triggerRed:
                // without it the unique violation would poison the enclosing 9-box
                // approve transaction and roll back the whole approval.
                idp = await db.get(
                    "INSERT INTO idp_plans (employee_id, status, priority, starts_on, ends_on, origin_evaluation_id) VALUES (?, 'draft', 'medium', ?, ?, ?) " +
                        "ON CONFLICT (employee_id) WHERE status IN ('draft','active') DO NOTHING RETURNING id",
                    [employeeId, isoDate(0), isoDate(180), originEvaluationId || null]
                );
                if (!idp) {
                    // Lost the race — an open IDP now exists; adopt it and do NOT
                    // duplicate objectives onto the winning plan.
                    idp = await db.get(
                        "SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft','active') ORDER BY created_at DESC LIMIT 1",
                        [employeeId]
                    );
                    return;
                }
                // La phrase d'écart est CELLE DE LA VOIE ROUGE, délibérément
                // partagée : le PDI et le plan de coaching décrivent le même
                // écart à la même personne, les deux textes ne doivent pas
                // diverger. Elle était ici codée en dur en FRANÇAIS — un
                // lecteur anglophone recevait un plan français.
                const gapText = COACHING_PIP_TEMPLATES[planLocale(req)].action;
                for (const g of gaps) {
                    await db.run(
                        "INSERT INTO idp_objectives (idp_id, skill_id, smart_text, priority) VALUES (?, ?, ?, 'medium')",
                        // Same confidentiality rule as the PIP summary above: the
                        // objective text is read by the employee, so it states the
                        // DEVELOPMENT NEED and never the 9-box placement it came from.
                        // An unmeasured starting point is stated as unmeasured.
                        [idp.id, g.skillId, gapText(g)]
                    );
                    objectives++;
                }
                createdIdp = true;
            });
            // Auto-push: if any gap skill maps to an LMS course, enrol the employee
            // (best-effort, OUTSIDE the tx — no LMS configured / no mapping = no-op).
            // Only when we actually created the plan (not when we adopted a racer's).
            if (createdIdp) {
                try {
                    await require('./LmsService').autoAssignForSkills(
                        employeeId,
                        gaps.map((g) => g.skillId)
                    );
                } catch (_) {
                    /* never block the IDP trigger */
                }
            }
        }
        // TELL SOMEBODY. This path used to INSERT idp_plans/idp_objectives with raw
        // SQL and emit nothing, so an auto-created development plan was invisible:
        // the employee was never invited to it and the manager never knew to sign it
        // off. Employee AND supervisor, both awaited (see _notify), both best-effort —
        // a notification failure must never undo the plan we just committed.
        if (createdIdp) {
            notified = { employee: false, supervisor: false, admin: false };
            await this._notify(employeeId, 'idp.created', '/v2/idp');
            notified.employee = true;
            // The superior, whoever they are: an admin-managed employee has no
            // employee superior, so notify the managing admin instead of dropping
            // the signal (twin of the red-zone fix).
            const recipient = await this._notifyManager(employeeId, 'idp.created', '/v2/idp');
            const all = (recipient && recipient.all) || [];
            notified.supervisor = all.some((r) => r.userType === 'employee');
            notified.admin = all.some((r) => r.userType === 'admin');
        }
        return {
            zone: 'blue',
            idpId: idp.id,
            createdIdp,
            objectives,
            notified,
            originEvaluationId,
        };
    }
}

module.exports = new DevelopmentTriggerService();
