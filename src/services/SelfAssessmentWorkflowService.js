'use strict';
/**
 * SelfAssessmentWorkflowService — Phase 2 enhancement.
 *
 * Extends the existing self-assessment flow with an explicit lifecycle,
 * supervisor approve/reject/request-changes, threaded comments + employee
 * responses, manager arbitration/validation, and an immutable audit log.
 *
 * Authority model (per stakeholder decision):
 *   - supervisor/manager are OPTIONAL on an employee.
 *   - the superadmin account INHERITS supervisor AND manager authority when
 *     none is assigned, and may also act alongside an assigned one.
 *   - admin (non-viewer) can perform any supervisor/manager action.
 *
 * NOTE: the app db layer (PostgresDatabase) returns rows with camelCase keys,
 * so row properties are read as camelCase (sa.workflowState) while raw SQL uses
 * snake_case column names.
 *
 * Lifecycle (self_assessments.workflow_state):
 *   draft -> submitted -> under_review
 *         -> changes_requested -> submitted (employee revises)        [loop]
 *         -> reviewed (supervisor approved) -> approved (manager/admin validates)
 *         -> rejected (terminal)
 *         -> arbitration (manager resolves a dispute) -> approved|rejected
 */
const db = require('../config/database');
const EmployeeModel = require('../models/EmployeeModel');
const LogService = require('./LogService');
const RBACService = require('./RBACService');
// The ONE place the reporting line is resolved — including the person behind an
// administration account. The queue (RBACService.scopeFilter) and the reviewable
// set both go through it too, so the list and this guard cannot drift apart.
const GovernanceService = require('./GovernanceService');

const VALID_STATES = [
    'draft',
    'submitted',
    'under_review',
    'changes_requested',
    'reviewed',
    'arbitration',
    'approved',
    'rejected',
];

/**
 * A5 / HR3-02 — les transitions qui sont des ÉCRITURES DE REVUE.
 * Une campagne VERROUILLÉE laisse les revues en cours se terminer et refuse les
 * saisies (`allowReview` de `CycleService.cycleWriteGate`). Tout le reste —
 * saisie, soumission, retrait d'une revue, renvoi à l'employé, octroi d'une
 * demande de modification — est une écriture ordinaire, refusée dès le
 * verrouillage. Une campagne CLOSE refuse les deux.
 */
const REVIEW_WRITE_STATES = ['under_review', 'reviewed', 'arbitration', 'approved', 'rejected'];

/**
 * ATTACHER LE CATALOGUE À UN REFUS (constat M-02).
 *
 * Les refus de ce service sont rédigés en anglais : ils sont la phrase de
 * RÉFÉRENCE (les journaux la citent, `utils/apiErrors.domainStatus` en déduit le
 * statut, des suites l'épinglent). Ils étaient aussi ce que l'UTILISATEUR lisait,
 * y compris sur une page dont le `<html lang>` vaut « fr » — dont un qui exposait
 * une valeur d'énumération brute (« Cannot cancel from 'draft' »).
 *
 * `e.i18n` ajoute, sans rien changer à `e.message`, la clé du catalogue et ses
 * variables ; la poignée qui tient `req.t` rend la phrase dans la langue lue.
 * Même forme que `CycleService.gateMessage`, à qui ce service confie déjà les
 * refus de campagne.
 */
function say(e, key, vars = null) {
    e.i18n = vars ? { key, vars } : { key };
    return e;
}

class SelfAssessmentWorkflowService {
    // ---- authority resolution -------------------------------------------
    /**
     * The explicit campaign reviewer (3.23.17, F1). "Assign a reviewer" on the
     * campaign console promises to choose who REVIEWS — it used to write
     * cycle_participants and nothing read it but the reminder job, so the named
     * person was chased for reviews they were then refused (403) and never saw in
     * their queue. The grant is deliberately narrow:
     *   - only an EXPLICIT assignment (reviewer_assigned_at, migration 146) — the
     *     launch-time snapshot grants nothing, the live line already governs;
     *   - only for rows of THAT cycle (`cycleId` must be passed; a number, or
     *     'any' for the bulk entry point which then narrows per row);
     *   - never on oneself; a read-only delegate stays read-only (the caller
     *     applies `!isViewer`), and nothing an existing authority grants is taken.
     * Returns the list of cycle ids the user is explicitly assigned for.
     */
    async _assignedCycles(user, personId, employeeId, cycleId) {
        if (cycleId == null || cycleId === '' || !user || user.id == null) return [];
        const any = cycleId === 'any';
        if (!any && !(Number(cycleId) > 0)) return [];
        const isAdmin = user.userType === 'admin';
        if (!isAdmin && personId == null) return [];
        const rows = await db.all(
            `SELECT cp.cycle_id AS "cycleId"
               FROM cycle_participants cp
              WHERE cp.employee_id = ?
                ${any ? '' : 'AND cp.cycle_id = ?'}
                AND cp.reviewer_assigned_at IS NOT NULL
                AND cp.excluded_at IS NULL
                AND ((cp.reviewer_admin_id IS NOT NULL AND ? AND cp.reviewer_admin_id = ?)
                  OR (cp.reviewer_admin_id IS NULL AND cp.supervisor_id = ?))`,
            [
                Number(employeeId),
                ...(any ? [] : [Number(cycleId)]),
                isAdmin,
                isAdmin ? Number(user.id) : null,
                personId != null ? Number(personId) : null,
            ]
        );
        return (rows || []).map((r) => Number(r.cycleId));
    }

    async resolveAuthority(user, employeeId, { cycleId = null } = {}) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee)
            throw say(new Error('Employee not found'), 'assess:saw_err_employee_not_found');
        const isAdmin = Boolean(user && user.userType === 'admin');
        const isSuper = RBACService.isSuperAdmin(user);
        const isLocalAdmin = RBACService.isLocalAdmin(user);
        const isViewer = RBACService.isViewer(user);
        // THE PERSON, NOT THE ACCOUNT.
        //
        // `!isAdmin &&` used to prefix the two lines below, so the moment
        // userType was 'admin' the reporting line was ERASED and only the
        // clearance was left. A supervisor or manager who also holds an admin
        // account — promote-to-admin, account linking, the SSO "explicit admin
        // connect" path, or simply typing their admin login — therefore lost
        // their WHOLE team on the review console: measured on a development
        // database, the same human went from 15 reviewable people to 5, none of
        // them theirs, with the page rendering 200 and saying nothing. And the
        // login strategy tries the ADMIN table FIRST, so a person whose two
        // accounts share a login lands there without having chosen anything.
        //
        // The database already knew: `admins.linked_employee_id` names the
        // person, uniquely. GovernanceService.actingPersonId reads it — and
        // returns null for an account that names nobody, or names someone no
        // longer active. Two authorities held by one human ADD UP; a clearance
        // grants a perimeter, it never takes one away.
        const personId = await GovernanceService.actingPersonId(user);
        const isSelf = personId != null && personId === Number(employeeId);
        const isSupervisor = Boolean(
            personId != null &&
            employee.supervisorId != null &&
            personId === Number(employee.supervisorId)
        );
        // `manager_type` is NOT optional here. `manager_id` is polymorphic — it
        // points at an EMPLOYEE or at an ADMIN — and the two id spaces overlap
        // (employees 84..68963, admins 1..666). Without the discriminator, the
        // ordinary employee whose id happens to equal the ADMIN id managing this
        // person was handed isManager = true, i.e. canSupervise AND canManage
        // over a stranger. `findGovernedIds` has always filtered it, so the LIST
        // excluded that person correctly while this function let them act: the
        // list and the authority disagreed, in the dangerous direction.
        //
        // The other half of the same discriminator: `manager_type = 'admin'`
        // names an ADMIN ACCOUNT, and that designation drew no authority at all
        // — the admin named manager of a person saw none of their assessments.
        // Either the field means something or the form must not offer it.
        const isManager = Boolean(
            (personId != null &&
                employee.managerId != null &&
                employee.managerType === 'employee' &&
                personId === Number(employee.managerId)) ||
            (isAdmin &&
                employee.managerId != null &&
                employee.managerType === 'admin' &&
                Number(user.id) === Number(employee.managerId))
        );
        // CLEARANCE — admin scopes, and nothing else. Kept apart from `inScope`
        // on purpose: clearance is the ONLY thing a bounded admin's right to ACT
        // rests on, and the house rule is that a bounded admin stays bounded on
        // every path.
        const inClearance = isSuper
            ? true
            : isAdmin
              ? await RBACService.canAccessEmployeeData(user, employee)
              : false;
        // READING scope — the UNION of the clearance and the reporting line.
        //
        // The sub-tree, not the direct link. The review console lists everyone in
        // the sub-tree (middleware/rbac.js → EmployeeModel.findGovernedIds, a
        // transitive BFS), while this function recognised only the DIRECT
        // supervisor/manager. An N+2 reviewer therefore saw their indirect
        // reports in the queue and was refused 403 on every detail and every
        // action — reported from production as "some supervisors and managers
        // cannot see the detail of a review", and it explains the "some": a
        // first-line supervisor never meets it.
        //
        // CoachingPlanService.resolveAuthority already carries this exact fix,
        // with the same comment; the self-assessment workflow never received it.
        // Following that precedent deliberately: the sub-tree grants READ
        // (canView), never the right to ACT. Approving an indirect report stays
        // with the direct supervisor/manager.
        // The reviewer explicitly named on the campaign console, for THIS cycle
        // only (see _assignedCycles). Never on oneself. Only looked up when it
        // would ADD a right to review — someone who already reviews this person
        // through the line or a clearance gains nothing from it.
        const alreadyReviews = Boolean(
            isSuper || (isLocalAdmin && inClearance) || isSupervisor || isManager
        );
        const assignedCycleIds =
            isSelf || alreadyReviews
                ? []
                : await this._assignedCycles(user, personId, employeeId, cycleId);
        const isAssignedReviewer = assignedCycleIds.length > 0;
        const inScope = Boolean(
            inClearance ||
            isSupervisor ||
            isManager ||
            isAssignedReviewer ||
            (personId != null && (await EmployeeModel.governs(personId, employeeId)))
        );
        // ACTING. A local admin acts inside their CLEARANCE (never on the line
        // sub-tree, which only grants reading); a supervisor/manager acts on
        // their DIRECT link. `!isViewer` keeps a read-only delegation read-only
        // on every path, including one that carries a reporting line.
        // An explicitly assigned campaign reviewer reviews like a supervisor
        // (canSupervise), never like a manager: arbitration stays above them.
        const canSupervise = Boolean(
            !isViewer &&
            (isSuper ||
                (isLocalAdmin && inClearance) ||
                isSupervisor ||
                isManager ||
                isAssignedReviewer)
        );
        const canManage = Boolean(
            !isViewer && (isSuper || (isLocalAdmin && inClearance) || isManager)
        );
        // Read access, deliberately wider than the right to act: the subject
        // themselves, or anyone whose scope covers this employee — which is
        // exactly the population the console already LISTS. A reviewer must
        // never be shown a line they are then refused the detail of.
        const canView = Boolean(isSelf || inScope);
        const actorType = isAdmin
            ? 'admin'
            : isManager
              ? 'manager'
              : isSupervisor || isAssignedReviewer
                ? 'supervisor'
                : isSelf
                  ? 'employee'
                  : 'none';
        return {
            employee,
            isAdmin,
            isViewer,
            isSelf,
            isSupervisor,
            isManager,
            isAssignedReviewer,
            assignedCycleIds,
            canSupervise,
            canManage,
            canView,
            actorType,
        };
    }

    async getAssessment(id) {
        return await db.get('SELECT * FROM self_assessments WHERE id = ?', [id]);
    }

    async _event(selfAssessmentId, auth, action, fromState, toState, detail = null) {
        await db.run(
            `INSERT INTO self_assessment_events (self_assessment_id, actor_id, actor_type, action, from_state, to_state, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                selfAssessmentId,
                auth && auth._userId != null ? auth._userId : null,
                auth && auth.actorType,
                action,
                fromState,
                toState,
                detail ? JSON.stringify(detail) : null,
            ]
        );
    }

    /**
     * `employee:<id>` / `admin:<id>` — la convention de `system_logs.actor_ref`,
     * la seule qui nomme aussi bien une personne qu'un compte d'administration.
     * `approved_by` est une clé étrangère vers `employees` : sur le chemin
     * administrateur elle vaut NULL, et 44 des 134 évaluations approuvées ne
     * nommaient donc personne (HR4-12, mesuré sur la base de développement). Celle-ci
     * peut nommer les deux, et la migration 116 refuse une approbation sans elle.
     */
    _actorRef(auth, user) {
        if (!user || user.id == null) return null;
        return `${auth && auth.isAdmin ? 'admin' : 'employee'}:${Number(user.id)}`;
    }

    /**
     * LA PORTE D'ÉCRITURE D'UNE CAMPAGNE (lot 5 : `CycleService.assertCycleWritable`).
     * `cycleId == null` = mesure HORS CAMPAGNE : toujours autorisée — une
     * absence de campagne ne doit jamais devenir un refus.
     */
    async _assertCycleWritable(cycleId, toState, req = null) {
        if (cycleId == null) return null;
        try {
            return await require('./CycleService').assertCycleWritable(cycleId, {
                allowReview: REVIEW_WRITE_STATES.includes(toState),
                t: req && typeof req.t === 'function' ? req.t : undefined,
            });
        } catch (e) {
            // La phrase est déjà rédigée et nomme la campagne et sa date ; on lui
            // donne seulement son statut HTTP (409, comme CycleController.fail) et
            // on la laisse traverser telle quelle — `utils/apiErrors` ne remplace
            // que les fautes techniques.
            if (e && e.gate) {
                e.status = 409;
                e.expose = true;
            }
            throw e;
        }
    }

    /**
     * @param {object|null} gate  `{ cycleId, req }` — la campagne portée par la
     *   ligne, lue par l'appelant qui a déjà la ligne en main. Omis, `_setState`
     *   la relit lui-même : la porte est inconditionnelle, jamais optionnelle.
     */
    async _setState(selfAssessmentId, toState, extra = {}, guardFrom = null, gate = null) {
        // Le SEUL refus de ce fichier qui ne porte PAS de clé, et c'est voulu :
        // il n'est pas atteignable depuis une route (aucun corps de requête ne
        // choisit `toState`), c'est un invariant de programmation — un appelant
        // interne qui passerait un état inconnu. `utils/apiErrors` le classera
        // comme faute technique et le lecteur lira la phrase générique.
        if (!VALID_STATES.includes(toState)) throw new Error('Invalid workflow_state: ' + toState);
        // A5 / HR3-02 / référentiel §3 règle 4 — LA PORTE D'ÉCRITURE D'UNE CAMPAGNE.
        // `_setState` est le seul point de passage des 7 transitions et le seul
        // UPDATE de `self_assessments` de ce fichier : la porte est branchée ici,
        // et nulle part ailleurs.
        //
        // Règle produit (2026-09-21) : la fenêtre de campagne verrouille un VERDICT
        // FINALISÉ, pas un travail encore en cours. Tant qu'une évaluation n'est
        // PAS ENCORE APPROUVÉE, elle reste corrigible même après la clôture de sa
        // campagne — on ne bloque jamais une saisie/soumission/revue inachevée
        // parce que la fenêtre s'est fermée. Une évaluation DÉJÀ APPROUVÉE, elle,
        // ne peut être rouverte / annulée / re-décidée que pendant une campagne
        // ouverte (la voie normale reste la demande de modification, elle-même
        // gardée par cette même porte). La porte ne s'applique donc qu'à un état
        // courant `approved` ; les autres transitions passent hors campagne.
        //
        // On lit toujours l'état courant (source de vérité de la ligne) ; le
        // `cycleId` porté par l'appelant est conservé quand il est fourni.
        const cur = await db.get(
            'SELECT cycle_id AS "cycleId", workflow_state AS "workflowState" FROM self_assessment_rounds WHERE id = ?',
            [selfAssessmentId]
        );
        let cycleId = gate ? gate.cycleId : undefined;
        if (cycleId === undefined) cycleId = cur ? cur.cycleId : null;
        if (cur && cur.workflowState === 'approved') {
            await this._assertCycleWritable(cycleId, toState, gate ? gate.req : null);
        }
        const sets = ['workflow_state = ?'];
        const vals = [toState];
        for (const [k, v] of Object.entries(extra)) {
            sets.push(`${k} = ?`);
            vals.push(v);
        }
        vals.push(selfAssessmentId);
        let sql = `UPDATE self_assessments SET ${sets.join(', ')}, updated_at = now() WHERE id = ?`;
        // Optimistic concurrency: when guardFrom is given, the transition only
        // applies if the row is still in one of those states. The row lock
        // serialises two reviewers; the loser then sees the new state and gets
        // 0 rows → we surface a clear "already actioned" error instead of
        // silently double-applying (double promotion, clobbered decision).
        if (guardFrom && guardFrom.length) {
            sql += ` AND workflow_state IN (${guardFrom.map(() => '?').join(',')})`;
            vals.push(...guardFrom);
        }
        const r = await db.run(sql, vals);
        if (guardFrom && (r.changes ?? r.rowCount ?? 0) === 0) {
            const e = say(
                new Error('This assessment was already actioned by another reviewer.'),
                'assess:acr_err_stale_state'
            );
            e.code = 'STALE_STATE';
            throw say(e, 'assess:acr_err_stale_state');
        }
    }

    // attach the acting user id onto the auth object for event logging
    async _auth(user, employeeId, opts = {}) {
        const a = await this.resolveAuthority(user, employeeId, opts);
        a._userId = user && user.id != null ? user.id : null;
        return a;
    }

    /**
     * Finalise the assessment's supervisor_reviews row on an approve/validate/
     * reject. When the actor is a MANAGER or SUPERVISOR (an employee), record
     * them as `reviewed_by` — so a manager reviewing directly stands in for the
     * supervisor review (the row shows who actually validated, and it surfaces
     * on the employee's own reviews page, which INNER JOINs reviewed_by to
     * employees). An ADMIN actor can't own that employee-FK column, so we leave
     * reviewed_by as-is for admins. No row (e.g. the no-supervisor/no-manager
     * admin-queue path) → the UPDATE simply affects 0 rows.
     */
    async _finalizeSupervisorReview(
        selfAssessmentId,
        auth,
        user,
        decision,
        recommendation = null,
        supervisorLevel = null
    ) {
        // The gap is what the employee reads to decide whether to contest, so it
        // is recomputed from the two ratings on EVERY finalisation. It used to be
        // written once at submit time as 0 and never touched again: a supervisor
        // moving a rating 1 -> 3 left the employee reading "Ecart 0" under a green
        // "d'accord" badge on a real divergence of 2.
        //
        // THE ROUND THAT WAS JUDGED. `supervisor_reviews.self_assessment_id` is a
        // foreign key onto ONE round; `self_assessments` is the VIEW of the
        // CURRENT round only (migration 113). Joining the view made this SELECT
        // return nothing for a replaced round, and the `if (!row) return` below
        // then read that as "no review row to finalise" — a silent no-op on a
        // decision that had just been taken. The finalisation must always address
        // the round the review actually judged, so it joins the TABLE.
        const row = await db.get(
            `SELECT sr.supervisor_rated_level AS "currentLevel", sa.self_rated_level AS "selfLevel"
               FROM supervisor_reviews sr
               JOIN self_assessment_rounds sa ON sa.id = sr.self_assessment_id
              WHERE sr.self_assessment_id = ?`,
            [selfAssessmentId]
        );
        // No review row (the no-supervisor admin-queue path) — nothing to finalise.
        if (!row) return;

        // An omitted rating means the supervisor validated the employee's own
        // level as it stands: that IS an agreement, so it resolves to the self
        // rating and a gap of 0 rather than staying unknown.
        //
        // A REJECTION IS NOT AN AGREEMENT. The supervisor refused the submission;
        // they did not endorse the level in it. Falling through to the self-rating
        // here wrote `supervisor_rated_level = <the self-rating>, gap = 0,
        // status = 'completed'` — a validated measurement fabricated out of a
        // refusal, and exactly the shape IDPService.generateDrafts selects on.
        // Probed against the running database (self 1, role requires 3):
        //   after reject, supervisor_reviews -> {"status":"completed","decision":"reject","lvl":1,"gap":0}
        //   IDPService.generateDrafts -> {"plans":1,"gaps":1}
        //   objective: "D'ici le …, monter Basic Cybersecurity du niveau 1 au niveau 3,
        //               validé par le superviseur…"
        // i.e. the employee is handed a signable plan asserting a level nobody
        // validated, off an assessment that was thrown out. On a rejection the
        // level therefore stays UNMEASURED (NULL) unless a supervisor genuinely
        // recorded one earlier in the same review, and the gap follows it.
        const isReject = decision === 'reject';
        const fallbackLevel =
            row.currentLevel != null
                ? Number(row.currentLevel)
                : isReject
                  ? null
                  : Number(row.selfLevel);
        const finalLevel =
            supervisorLevel !== null && supervisorLevel !== undefined
                ? Number(supervisorLevel)
                : fallbackLevel;
        const gap =
            row.selfLevel == null || finalLevel == null || Number.isNaN(finalLevel)
                ? null
                : finalLevel - Number(row.selfLevel);

        const recordReviewer = !auth.isAdmin && user && user.id != null;
        const params = [
            decision,
            recommendation,
            Number.isNaN(finalLevel) ? null : finalLevel,
            gap,
        ];
        // WHO RATED IS NOT WHO VALIDATED. `reviewed_by` used to be overwritten
        // with the acting employee on EVERY finalisation, so a manager's
        // validation of a row a supervisor had already completed stole the
        // supervisor's attribution: the level and gap reason stayed the
        // supervisor's, the name became the manager's, and a dispute opened next
        // (`DisputeServiceV2._reviewerOf`) notified the manager — never the person
        // who actually rated. Measured (rolled back): review {reviewed_by:136,
        // level 1} → managerValidate by 137 → {reviewed_by:137, level 1}.
        // The validation is already named on the round (`approved_by_ref`), so
        // the review row keeps its human reviewer when one has already
        // COMPLETED it and this decision CONFIRMS theirs ('approve'). A row
        // still pending, or without a reviewer, or being OVERTURNED (reject) is
        // attributed to the person acting now.
        if (recordReviewer) params.push(decision, user.id);
        params.push(selfAssessmentId);
        await db.run(
            `UPDATE supervisor_reviews
                SET decision = ?, recommendation = ?, status = 'completed', decided_at = now(),
                    supervisor_rated_level = ?, gap = ?,
                    reviewed_at = COALESCE(reviewed_at, now())${
                        recordReviewer
                            ? `, reviewed_by = CASE WHEN reviewed_by IS NOT NULL AND status <> 'pending' AND ?::text = 'approve'
                                                 THEN reviewed_by ELSE ? END`
                            : ''
                    }
              WHERE self_assessment_id = ?`,
            params
        );
    }

    // ---- transitions -----------------------------------------------------

    /** Supervisor (or admin) opens a submitted assessment for review. */
    async openReview(selfAssessmentId, user, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canSupervise)
            throw say(
                new Error('Not authorized: supervisor/admin only'),
                'assess:acr_err_not_authorized_supervisor'
            );
        if (!['submitted', 'changes_requested'].includes(sa.workflowState))
            throw say(
                new Error(`Cannot open review from state '${sa.workflowState}'`),
                'assess:saw_err_cannot_open_review',
                { stateRaw: sa.workflowState }
            );
        await this._setState(selfAssessmentId, 'under_review', {}, null, {
            cycleId: sa.cycleId,
            req,
        });
        await this._event(selfAssessmentId, auth, 'open_review', sa.workflowState, 'under_review');
        await this._audit(
            req,
            'SA_OPEN_REVIEW',
            selfAssessmentId,
            `opened review (${auth.actorType})`
        );
        return this.getAssessment(selfAssessmentId);
    }

    /** Supervisor requests modifications; assessment returns to the employee. */
    async requestChanges(selfAssessmentId, user, comment, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canSupervise)
            throw say(
                new Error('Not authorized: supervisor/admin only'),
                'assess:acr_err_not_authorized_supervisor'
            );
        // Requesting changes without saying what to change leaves the employee with a
        // red "action needed" flag and no guidance — require a comment.
        if (!comment || !String(comment).trim())
            throw say(
                new Error('Please explain what the employee needs to change.'),
                'assess:acr_err_request_changes_comment'
            );
        // A SuperAdmin may also REOPEN an assessment that is already APPROVED —
        // the maintenance case: a rating validated on a wrong reading, a skill
        // approved for the wrong person. Nobody else may: the approve guard
        // exists precisely so a stale request-changes cannot pull an approved
        // assessment back to the employee, and that stays true for every other
        // actor. The official skill profile is NOT rewritten here — the level
        // that was promoted stays until the re-approval replaces it — and the
        // reopen is recorded as its own event and audit action, never disguised
        // as an ordinary request for changes.
        const isSuper = require('./RBACService').isSuperAdmin(user);
        const reopenApproved = sa.workflowState === 'approved' && isSuper;
        const sources = reopenApproved ? ['approved'] : ['under_review', 'submitted'];
        if (!sources.includes(sa.workflowState))
            throw say(
                new Error(`Cannot request changes from '${sa.workflowState}'`),
                'assess:saw_err_cannot_request_changes',
                { stateRaw: sa.workflowState }
            );
        // Keep the legacy `status` in lockstep: the assessment is back in the
        // employee's hands, so it must NOT still count as 'submitted' in the
        // pending-review queries (SelfAssessmentService WHERE status='submitted').
        // guardFrom = the source states checked above: a stale request-changes
        // must not pull an assessment another reviewer has since APPROVED back
        // to the employee (measured: approved → changes_requested, status draft).
        await this._setState(
            selfAssessmentId,
            'changes_requested',
            reopenApproved
                ? // Un-approve: the approval stamp and the finalised lock go, so the
                  // cycle roster and the IDP generator stop treating it as decided.
                  // `approved_by_ref` follows `approved_by`: the approval it named no
                  // longer stands, and the trail keeps who it was (migration 116).
                  {
                      status: 'draft',
                      approved_by: null,
                      approved_by_ref: null,
                      approved_at: null,
                      locked_state: 'provisional',
                  }
                : { status: 'draft' },
            sources,
            { cycleId: sa.cycleId, req }
        );
        if (comment) await this.addComment(selfAssessmentId, user, comment, null, auth);
        await db.run(
            reopenApproved
                ? // The review that approved it is reopened too, or the supervisor
                  // console would show a decided review over an assessment that is
                  // back in the employee's hands.
                  `UPDATE supervisor_reviews SET decision='request_changes', status='pending', decided_at=now() WHERE self_assessment_id=?`
                : `UPDATE supervisor_reviews SET decision='request_changes', decided_at=now() WHERE self_assessment_id=?`,
            [selfAssessmentId]
        );
        await this._event(
            selfAssessmentId,
            auth,
            reopenApproved ? 'reopen_after_approval' : 'request_changes',
            sa.workflowState,
            'changes_requested',
            { comment: comment || null, ...(reopenApproved ? { superadminOverride: true } : {}) }
        );
        await this._audit(
            req,
            reopenApproved ? 'SA_REOPENED_AFTER_APPROVAL' : 'SA_REQUEST_CHANGES',
            selfAssessmentId,
            reopenApproved
                ? `SuperAdmin reopened an APPROVED assessment for changes (official skill level left as promoted until re-approval)`
                : `requested changes (${auth.actorType})`
        );
        await this._notifyEmployee(sa, 'sa.changes_requested', { comment: comment || null });
        return this.getAssessment(selfAssessmentId);
    }

    /**
     * SuperAdmin WITHDRAWS the supervisor's review of a self-assessment — the
     * maintenance case ("remove a review"): a review opened, decided or sent
     * back by the wrong person, or on a wrong reading, before anybody approved.
     *
     * The assessment goes back to 'submitted' exactly as the employee filed it
     * (nothing they wrote is touched), so it re-enters the reviewer's queue; the
     * supervisor_reviews row returns to 'pending' with its decision, rating, gap
     * and dates cleared. The withdrawn values are not lost: they travel in the
     * event detail (`priorReview`), so the trail still shows who decided what
     * before the SuperAdmin stepped in.
     *
     * Withdrawable: under_review · changes_requested · reviewed — the states
     * where a reviewer has acted and nobody has yet approved. Deliberately NOT:
     *   approved     → requestChanges by a SuperAdmin (reopen), which also
     *                  lifts the approval stamp and the finalised lock;
     *   arbitration  → a dispute is in flight and the dispute ladder owns it —
     *                  likewise a review whose row is 'disputed';
     *   submitted / draft → there is no review to withdraw;
     *   rejected     → terminal.
     * Nobody but a SuperAdmin: a supervisor undoing their own decision is not a
     * workflow step, and a manager who disagrees has arbitrate.
     */
    async withdrawReview(selfAssessmentId, user, reason, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        if (!RBACService.isSuperAdmin(user))
            throw say(
                new Error('Not authorized: SuperAdmin only'),
                'assess:saw_err_superadmin_only'
            );
        const why = String(reason == null ? '' : reason).trim();
        if (!why)
            throw say(
                new Error('A reason is required to withdraw a review.'),
                'assess:saw_err_withdraw_reason_required'
            );
        const WITHDRAWABLE = ['under_review', 'changes_requested', 'reviewed'];
        if (!WITHDRAWABLE.includes(sa.workflowState))
            throw say(
                new Error(`Cannot withdraw a review from '${sa.workflowState}'`),
                'assess:saw_err_cannot_withdraw_review',
                { stateRaw: sa.workflowState }
            );
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        const prior = await db.get(
            `SELECT status, decision, recommendation, supervisor_rated_level AS "supervisorRatedLevel",
                    gap, gap_reason AS "gapReason", reviewed_by AS "reviewedBy", decided_at AS "decidedAt"
               FROM supervisor_reviews WHERE self_assessment_id = ?`,
            [selfAssessmentId]
        );
        if (prior && prior.status === 'disputed') {
            const e = say(
                new Error(
                    'A dispute is open on this review; resolve or withdraw the dispute first.'
                ),
                'assess:saw_err_dispute_open'
            );
            e.code = 'REVIEW_DISPUTED';
            throw e;
        }
        // Legacy `status` back in lockstep: 'submitted' is what the pending-
        // review queries select on, so the file reappears in the queue. guardFrom
        // = the states checked above (a concurrent approve wins → STALE_STATE).
        await this._setState(selfAssessmentId, 'submitted', { status: 'submitted' }, WITHDRAWABLE, {
            cycleId: sa.cycleId,
            req,
        });
        await db.run(
            `UPDATE supervisor_reviews
                SET status = 'pending', decision = NULL, recommendation = NULL, decided_at = NULL,
                    supervisor_rated_level = NULL, gap = NULL, gap_reason = NULL, reviewed_at = NULL
              WHERE self_assessment_id = ?`,
            [selfAssessmentId]
        );
        await this._event(
            selfAssessmentId,
            auth,
            'review_withdrawn',
            sa.workflowState,
            'submitted',
            { superadminOverride: true, reason: why, priorReview: prior || null }
        );
        await this._audit(
            req,
            'SA_REVIEW_WITHDRAWN',
            selfAssessmentId,
            `SuperAdmin withdrew the supervisor review (from '${sa.workflowState}' back to 'submitted';` +
                ` prior decision: ${prior && prior.decision ? prior.decision : 'none'}). Reason: ${why}`
        );
        return this.getAssessment(selfAssessmentId);
    }

    /**
     * LE SUPERVISEUR / LE MANAGER ANNULE une évaluation — règle B du propriétaire,
     * verbatim : « the supervisor and manager should be able … to cancel an
     * assessment if only not already approved by manager, outside that the
     * supervisor should enter a request for change ».
     *
     * Le produit était faux dans les DEUX sens (HR1-16) : les personnes qui
     * possèdent la revue n'avaient aucune action d'annulation, et la seule qui
     * pouvait annuler — le SuperAdmin, par le panneau de maintenance — pouvait le
     * faire dans des états où il ne devrait pas, y compris sur un brouillon que
     * l'employé est encore en train de remplir.
     *
     * CE QUE C'EST : un ÉTAT plus un MOTIF OBLIGATOIRE, jamais une suppression.
     * L'état physique reste 'rejected' (migration 100 dit pourquoi une neuvième
     * valeur serait un piège : trois lecteurs filtrent négativement) et les trois
     * colonnes `cancelled_*` (migration 114) disent que c'était une ANNULATION,
     * par qui et pourquoi. L'écran affiche « Annulée ».
     *
     * CE QUE CE N'EST PAS :
     *   - un brouillon que l'employé n'a pas soumis est à lui : personne ne l'annule ;
     *   - une évaluation VALIDÉE ne s'annule plus directement — il faut une
     *     demande de modification (AssessmentChangeRequestService) ;
     *   - un dossier en ARBITRAGE appartient à l'échelle de contestation ;
     *   - le niveau officiel déjà promu n'est PAS réécrit ici (même raison que
     *     MaintenanceService.cancelAssessment : rien ne relie encore un niveau
     *     officiel au tour qui l'a produit).
     */
    async cancelByReviewer(selfAssessmentId, user, reason, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canSupervise && !auth.canManage)
            throw say(
                new Error('Not authorized: supervisor/manager/admin only'),
                'assess:acr_err_not_authorized_reviewer'
            );
        if (auth.isSelf)
            throw say(
                new Error('Not authorized: cannot cancel your own assessment'),
                'assess:acr_err_cancel_own'
            );
        const why = String(reason == null ? '' : reason).trim();
        if (!why)
            throw say(
                new Error('A reason is required to cancel an assessment.'),
                'assess:acr_err_cancel_reason_required'
            );
        if (sa.workflowState === 'approved') {
            // UNE PHRASE QUI ORDONNE UNE DÉMARCHE DIT CE QU'ELLE EMPÊCHE (M-01).
            //
            // Ce refus prononçait « déposez une demande de modification » AVANT
            // toute porte de campagne. Mesuré le 15/09 en session superviseur sur
            // l'évaluation validée 222258 : le flash ordonnait la démarche, et la
            // demande ordonnée repartait aussitôt en 409 « La campagne 2026-Q3 est
            // verrouillée (échéance du 2026-08-31) ». Le produit ordonnait donc une
            // démarche qu'aucun contrôle ne permettait d'accomplir — la phrase même
            // du constat d'origine, cette fois par l'ORDRE des gardes.
            //
            // La porte de la demande est donc lue AVANT de la conseiller, en
            // lecture seule : recevable, on l'ordonne ; empêchée, on dit PAR QUOI
            // (la campagne et sa date, le délai A7 et ses dates, ou la demande déjà
            // ouverte). Un échec de cette lecture ne change rien au refus lui-même :
            // on retombe sur la phrase de référence.
            let blocked = null;
            try {
                blocked = await require('./AssessmentChangeRequestService').whyNotRaisable(
                    selfAssessmentId,
                    req
                );
            } catch (_) {
                blocked = null;
            }
            const e = new Error(
                blocked
                    ? "Cannot cancel from 'approved': this assessment has been validated — and a request for change cannot" +
                          ` be raised on it today (${blocked.code}).`
                    : "Cannot cancel from 'approved': this assessment has been validated — raise a request for change instead."
            );
            e.code = 'CHANGE_REQUEST_REQUIRED';
            if (blocked) e.blockedBy = blocked.code;
            throw blocked
                ? say(e, blocked.key, blocked.vars)
                : say(e, 'assess:acr_err_cancel_approved');
        }
        const CANCELLABLE = ['submitted', 'under_review', 'changes_requested', 'reviewed'];
        if (!CANCELLABLE.includes(sa.workflowState))
            // `stateRaw` — la poignée rend l'état par le dictionnaire : « Cannot
            // cancel from 'draft' » exposait la valeur de la colonne (M-02).
            throw say(
                new Error(`Cannot cancel from '${sa.workflowState}'`),
                'assess:acr_err_cancel_state',
                { stateRaw: sa.workflowState }
            );
        const actorRef = this._actorRef(auth, user);
        if (!actorRef)
            throw say(
                new Error('Not authorized: a cancellation must name the person who decides it.'),
                'assess:acr_err_cancel_unnamed'
            );
        await db.runTransaction(async () => {
            await this._setState(
                selfAssessmentId,
                'rejected',
                {
                    status: 'rejected',
                    cancelled_at: new Date().toISOString(),
                    cancel_reason: why,
                    cancelled_by_ref: actorRef,
                },
                CANCELLABLE,
                { cycleId: sa.cycleId, req }
            );
            // `supervisor_reviews` n'est DÉLIBÉRÉMENT pas touchée. Une annulation
            // n'est pas une décision de revue : personne n'a noté cette
            // compétence. `_finalizeSupervisorReview` retomberait sur la note de
            // l'employé et écrirait « superviseur N, écart 0 » — une mesure
            // fabriquée sur un dossier annulé, exactement le défaut que HR1-11 a
            // fermé sur le rejet. La compétence reste NON MESURÉE.
            await this._event(selfAssessmentId, auth, 'cancel', sa.workflowState, 'rejected', {
                cancelled: true,
                reason: why,
                by: actorRef,
            });
        });
        await this._audit(
            req,
            'SA_CANCELLED_BY_REVIEWER',
            selfAssessmentId,
            `cancelled by ${auth.actorType} (${actorRef}) from '${sa.workflowState}' — state + reason, nothing deleted.` +
                ` Official skill level left UNCHANGED. Reason: ${why}`
        );
        await this._notifyEmployee(sa, 'sa.cancelled', { reason: why });
        return this.getAssessment(selfAssessmentId);
    }

    /**
     * L'OCTROI D'UNE DEMANDE DE MODIFICATION rend la ligne à l'employé.
     *
     * C'est la SEULE chose qui rouvre le droit de modifier (règle du propriétaire).
     * Appelée par `AssessmentChangeRequestService.grant`, DANS SA TRANSACTION : la
     * décision et la réouverture commettent ensemble, sinon une demande accordée
     * pourrait laisser la ligne verrouillée, ou l'inverse.
     *
     * L'octroi ne rouvre JAMAIS la campagne : `_setState` passe par la porte, donc
     * une campagne close refuse l'écriture et la demande ne peut pas y être
     * accordée. Seul `CycleService.reopenClosed` rouvre une campagne.
     */
    async applyGrantedChangeRequest(
        selfAssessmentId,
        user,
        { requestId, reason } = {},
        req = null
    ) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        const REOPENABLE = ['submitted', 'under_review', 'reviewed', 'approved'];
        if (!REOPENABLE.includes(sa.workflowState))
            throw say(
                new Error(`Cannot reopen from '${sa.workflowState}'`),
                'assess:saw_err_cannot_reopen',
                { stateRaw: sa.workflowState }
            );
        const wasApproved = sa.workflowState === 'approved';
        await this._setState(
            selfAssessmentId,
            'changes_requested',
            wasApproved
                ? // Même dé-validation que la réouverture SuperAdmin : le tampon
                  // d'approbation et le verrou « finalisé » partent, sinon le roster
                  // de campagne et le générateur d'IDP continueraient à traiter la
                  // ligne comme décidée. Le niveau officiel promu reste tel quel
                  // jusqu'à la ré-approbation.
                  {
                      status: 'draft',
                      approved_by: null,
                      approved_by_ref: null,
                      approved_at: null,
                      locked_state: 'provisional',
                  }
                : { status: 'draft' },
            REOPENABLE,
            { cycleId: sa.cycleId, req }
        );
        await db.run(
            `UPDATE supervisor_reviews SET decision = 'request_changes', status = 'pending', decided_at = now()
              WHERE self_assessment_id = ?`,
            [selfAssessmentId]
        );
        await this._event(
            selfAssessmentId,
            auth,
            'change_request_granted',
            sa.workflowState,
            'changes_requested',
            {
                changeRequestId: requestId != null ? Number(requestId) : null,
                reason: reason || null,
                wasApproved,
            }
        );
        await this._audit(
            req,
            'SA_CHANGE_REQUEST_GRANTED',
            selfAssessmentId,
            `change request #${requestId} granted (${auth.actorType}) — assessment returned to the employee from '${sa.workflowState}'.` +
                (wasApproved
                    ? ' The approval stamp was lifted; the official skill level stays as promoted until re-approval.'
                    : '')
        );
        await this._notifyEmployee(sa, 'sa.change_request_granted', {
            changeRequestId: requestId || null,
        });
        return this.getAssessment(selfAssessmentId);
    }

    /**
     * Supervisor OR manager approves → 'approved' (FINAL).
     * Per stakeholder rule: both a supervisor and a manager can approve directly;
     * there is no separate mandatory manager-validation step. Only a DISPUTE
     * escalates to the manager (see arbitrate). An approved self-rating becomes
     * the employee's official current skill level.
     */
    async approve(
        selfAssessmentId,
        user,
        recommendation = null,
        req = null,
        supervisorLevel = null
    ) {
        // `recommendation` accepts either the legacy plain string (bulk approve,
        // older callers) OR `{ recommendation, gapReason }` — gapReason being the
        // supervisor's SHORT REASON for overriding the employee's self-rating.
        // Carried on this existing parameter on purpose: no new column, no new
        // route/controller surface. It is persisted to supervisor_reviews.gap_reason.
        let gapReason = null;
        if (recommendation && typeof recommendation === 'object') {
            const r = recommendation;
            gapReason = r.gapReason != null ? String(r.gapReason).trim() : null;
            recommendation = r.recommendation != null ? r.recommendation : null;
        }
        if (gapReason === '') gapReason = null;
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canSupervise && !auth.canManage)
            throw say(
                new Error('Not authorized: supervisor/manager/admin only'),
                'assess:acr_err_not_authorized_reviewer'
            );
        if (auth.isSelf)
            throw say(
                new Error('Not authorized: cannot review your own assessment'),
                'assess:saw_err_review_own'
            );
        if (!['submitted', 'under_review', 'reviewed', 'arbitration'].includes(sa.workflowState))
            throw say(
                new Error(`Cannot approve from '${sa.workflowState}'`),
                'assess:saw_err_cannot_approve',
                { stateRaw: sa.workflowState }
            );
        // An assessment under ARBITRATION has been escalated ABOVE the supervisor:
        // closing it is the manager's (or admin's) call, as managerValidate already
        // requires. Letting canSupervise through here meant the very supervisor
        // being arbitrated could approve the escalation away themselves.
        if (sa.workflowState === 'arbitration' && !auth.canManage)
            throw say(
                new Error("Cannot approve from 'arbitration': manager/admin only"),
                'assess:saw_err_approve_arbitration_manager_only'
            );
        // Process integrity: the reviewer may enter THEIR OWN rating (0–4) instead of
        // rubber-stamping the self-rating. When provided it is what gets promoted to
        // the official skill level; when omitted the self-rating stands (explicit
        // agreement). Guard the range so a bad value can't reach the skill profile.
        let mgrLevel = null;
        if (
            supervisorLevel !== null &&
            supervisorLevel !== undefined &&
            String(supervisorLevel) !== ''
        ) {
            mgrLevel = Number(supervisorLevel);
            if (!Number.isInteger(mgrLevel) || mgrLevel < 0 || mgrLevel > 4)
                throw say(
                    new Error('Supervisor rating must be an integer between 0 and 4.'),
                    'assess:saw_err_rating_range'
                );
        }
        // Accountability: OVERRIDING the employee's own rating must be explained.
        // Agreeing with it (or leaving the rating untouched) needs no reason.
        const isOverride = mgrLevel !== null && Number(mgrLevel) !== Number(sa.selfRatedLevel);
        if (isOverride && !gapReason)
            throw say(
                new Error(
                    'Please give a short reason for rating this skill differently from the employee.'
                ),
                'assess:saw_err_rating_reason_required'
            );
        if (!isOverride) gapReason = null; // never record a reason where there is no divergence
        // Atomic: state+legacy-status, the supervisor_reviews decision, and the
        // event log must commit together (a mid-sequence failure otherwise leaves
        // the two state machines / side tables inconsistent).
        // TOUTE VALIDATION NOMME UN HUMAIN (référentiel §3 règle 2, HR4-12). Les
        // deux colonnes historiques sont des clés étrangères vers `employees` et
        // ne peuvent donc pas nommer un administrateur ; la référence d'acteur, si.
        const actorRef = this._actorRef(auth, user);
        if (!actorRef)
            throw say(
                new Error('Not authorized: an approval must name the person who gives it.'),
                'assess:saw_err_approval_unnamed'
            );
        await db.runTransaction(async () => {
            await this._setState(
                selfAssessmentId,
                'approved',
                {
                    reviewed_at: new Date().toISOString(),
                    reviewed_by: auth.isAdmin ? null : user.id,
                    reviewed_by_ref: actorRef,
                    approved_by: auth.isAdmin ? null : user.id,
                    approved_by_ref: actorRef,
                    approved_at: new Date().toISOString(),
                    status: 'approved',
                },
                ['submitted', 'under_review', 'reviewed', 'arbitration'], // guard: refuse a second concurrent approval (must match the allowed source states above)
                { cycleId: sa.cycleId, req }
            );
            // Record the acting supervisor/manager as the validator (a manager
            // reviewing directly thereby also completes the supervisor review).
            await this._finalizeSupervisorReview(
                selfAssessmentId,
                auth,
                user,
                'approve',
                recommendation || null,
                mgrLevel
            );
            // The override reason lives on the EXISTING supervisor_reviews.gap_reason
            // column (no row → 0 rows affected, same as the rest of this path).
            if (gapReason) {
                await db.run(
                    'UPDATE supervisor_reviews SET gap_reason = ? WHERE self_assessment_id = ?',
                    [gapReason, selfAssessmentId]
                );
            }
            await this._promoteToSkillAssessment(sa, user, auth, mgrLevel);
            await this._event(selfAssessmentId, auth, 'approve', sa.workflowState, 'approved', {
                recommendation: recommendation || null,
                supervisorLevel: mgrLevel,
                selfRatedLevel: sa.selfRatedLevel != null ? Number(sa.selfRatedLevel) : null,
                gapReason: gapReason || null,
            });
        });
        await this._audit(
            req,
            'SA_APPROVE',
            selfAssessmentId,
            `approved (${auth.actorType})` +
                (isOverride ? ` — override ${sa.selfRatedLevel}→${mgrLevel}: ${gapReason}` : '')
        );
        await this._notifyEmployee(sa, 'sa.approved', {
            recommendation: recommendation || null,
            gapReason: gapReason || null,
        });
        return this.getAssessment(selfAssessmentId);
    }

    /**
     * The approved rating becomes the employee's official current skill level.
     *
     * Precedence, most authoritative first:
     *   1. `level` — the rating the reviewer just entered on this action.
     *   2. supervisor_reviews.supervisor_rated_level — a rating a supervisor
     *      already validated in an EARLIER step of the same assessment.
     *   3. the self-rating — nobody ever disagreed with it.
     *
     * Step 2 was missing. `approve` passes its own level and was fine, but
     * `managerValidate` and `arbitrate({outcome:'approve'})` finalise an
     * assessment that is already in state 'reviewed' — i.e. a supervisor has
     * been through it — and called this with no level, so the fallback promoted
     * the SELF-rating and silently discarded the supervisor's judgement.
     * Measured: self 1, supervisor 4 -> skill_assessments.current_level = 1
     * while supervisor_reviews still read 4 (gap 3). The official profile feeds
     * readiness, gaps, benchmark and the 9-box, so the corruption is invisible
     * and travels everywhere.
     */
    async _promoteToSkillAssessment(sa, user, auth, level = null) {
        try {
            if (level == null && sa && sa.id != null) {
                const review = await db.get(
                    `SELECT supervisor_rated_level AS "lvl" FROM supervisor_reviews
                      WHERE self_assessment_id = ? AND supervisor_rated_level IS NOT NULL
                      ORDER BY id DESC LIMIT 1`,
                    [sa.id]
                );
                if (review && review.lvl != null) level = Number(review.lvl);
            }
        } catch (_) {
            /* fall through to the self-rating rather than blocking the approval */
        }
        try {
            const SkillAssessmentModel = require('../models/SkillAssessmentModel');
            // skill_assessments.assessed_by references admins(id) — a supervisor/
            // manager is an EMPLOYEE, so attribute to the acting admin when one is
            // acting, otherwise to the default system admin.
            let assessedBy = auth && auth.isAdmin && user && user.id ? user.id : null;
            if (!assessedBy) {
                const a =
                    (await db.get(
                        "SELECT id FROM admins WHERE username = 'admin' AND is_active = true LIMIT 1"
                    )) || (await db.get('SELECT id FROM admins ORDER BY id LIMIT 1'));
                assessedBy = a ? a.id : null;
            }
            if (!assessedBy) return; // nothing valid to attribute to — skip, don't fail
            // Re-validate the 0–4 range at promotion time: a row created by any other
            // path (import/legacy/direct SQL) must not push an invalid level into the
            // official skill profile (which feeds readiness, gaps and the 9-box).
            const lvl = Number(level != null ? level : sa.selfRatedLevel);
            if (!Number.isInteger(lvl) || lvl < 0 || lvl > 4) return;
            await SkillAssessmentModel.upsert({
                employeeId: sa.employeeId,
                skillId: sa.skillId,
                currentLevel: lvl,
                assessedBy,
                notes:
                    level != null
                        ? 'Set from supervisor-validated rating'
                        : 'Set from approved self-assessment',
            });
        } catch (_) {
            /* never block an approval on the skill-profile update */
        }
    }

    /** Bulk-approve every actionable self-assessment of one employee in one go. */
    async bulkApproveForEmployee(employeeId, user, req = null) {
        // 'any': an explicitly assigned campaign reviewer may bulk-approve too —
        // but only the rows of the cycle(s) they were assigned (narrowed below);
        // every row is re-authorised by approve against its own cycle anyway.
        const auth = await this._auth(user, employeeId, { cycleId: 'any' });
        if (!auth.canSupervise && !auth.canManage)
            throw say(
                new Error('Not authorized: supervisor/manager/admin only'),
                'assess:acr_err_not_authorized_reviewer'
            );
        // Authority that comes ONLY from a campaign assignment (resolveAuthority
        // looks one up only when nothing else grants review) covers only the
        // assigned cycles' rows.
        const onlyAssigned = Boolean(auth.isAssignedReviewer);
        // 'arbitration' is deliberately NOT swept: an escalation is a per-case
        // decision by the manager (arbitrate/managerValidate), never part of a
        // bulk "approve all" — least of all one clicked by the supervisor whose
        // rating is being arbitrated.
        const rows = await db.all(
            `SELECT id FROM self_assessments
              WHERE employee_id = ? AND workflow_state IN ('submitted','under_review','reviewed')
              ${onlyAssigned ? 'AND cycle_id = ANY(?)' : ''}
              ORDER BY id`,
            onlyAssigned ? [employeeId, auth.assignedCycleIds] : [employeeId]
        );
        let approved = 0;
        const failed = [];
        for (const r of rows) {
            try {
                await this.approve(r.id, user, null, req);
                approved++;
            } catch (e) {
                failed.push({ id: r.id, reason: e && e.message ? e.message : 'could not approve' });
            }
        }
        await this._audit(
            req,
            'SA_BULK_APPROVE',
            employeeId,
            `bulk-approved ${approved}/${rows.length} assessment(s)${failed.length ? `; ${failed.length} skipped` : ''}`
        );
        // Return the failures so the UI can tell the supervisor exactly what was
        // NOT approved (was: silent skip — "9/10 approved" with no why).
        return { employeeId: Number(employeeId), approved, total: rows.length, failed };
    }

    /** Supervisor or manager rejects (terminal). */
    async reject(selfAssessmentId, user, reason, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canSupervise && !auth.canManage)
            throw say(new Error('Not authorized'), 'assess:acr_err_not_authorized_reviewer');
        if (auth.isSelf)
            throw say(
                new Error('Not authorized: cannot review your own assessment'),
                'assess:saw_err_review_own'
            );
        // A terminal rejection must carry a reason for the employee/audit trail.
        if (!reason || !String(reason).trim())
            throw say(
                new Error('Please provide a reason for rejecting this assessment.'),
                'assess:saw_err_reject_reason_required'
            );
        // ONLY WHAT WAS HANDED TO A REVIEWER CAN BE REFUSED BY ONE. The guard
        // used to be written as an EXCLUSION (« not approved, not rejected »), so
        // REJECTABLE = VALID_STATES minus those two still admitted 'draft' and
        // 'changes_requested' — the two states in which the row belongs to the
        // EMPLOYEE (cancelByReviewer and arbitrate both say so explicitly).
        // Measured on a development database (rolled back): a never-submitted
        // draft (submitted_at NULL) and a row just handed back to its author both
        // went 'rejected'/'rejected' — TERMINAL — on a manager's call. Same set as
        // ARBITRABLE, and the same list feeds the stale-read guard below.
        const REJECTABLE = ['submitted', 'under_review', 'reviewed', 'arbitration'];
        if (!REJECTABLE.includes(sa.workflowState))
            throw say(
                new Error(`Cannot reject from '${sa.workflowState}'`),
                'assess:saw_err_cannot_reject',
                { stateRaw: sa.workflowState }
            );
        // guardFrom = every state the check above lets through. Without it a
        // rejection decided on a stale read overwrote a committed APPROVAL
        // (measured: approved → rejected, with the promoted skill level left
        // standing in the official profile).
        await db.runTransaction(async () => {
            // Keep the legacy `status` column in lockstep with workflow_state so a
            // previously-approved row can never keep feeding v_resolved_assessments
            // (which UNIONs self_assessments WHERE status='approved') after rejection.
            await this._setState(selfAssessmentId, 'rejected', { status: 'rejected' }, REJECTABLE, {
                cycleId: sa.cycleId,
                req,
            });
            // Record the acting reviewer on the row (same rule as approve).
            await this._finalizeSupervisorReview(selfAssessmentId, auth, user, 'reject');
            if (reason) await this.addComment(selfAssessmentId, user, reason, null, auth);
            await this._event(selfAssessmentId, auth, 'reject', sa.workflowState, 'rejected', {
                reason: reason || null,
            });
        });
        await this._audit(req, 'SA_REJECT', selfAssessmentId, `rejected (${auth.actorType})`);
        await this._notifyEmployee(sa, 'sa.rejected', { reason: reason || null });
        return this.getAssessment(selfAssessmentId);
    }

    /** Manager (or admin) validates a supervisor-approved assessment → 'approved' (final). */
    async managerValidate(selfAssessmentId, user, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canManage)
            throw say(
                new Error('Not authorized: manager/admin only'),
                'assess:saw_err_manager_only'
            );
        if (auth.isSelf)
            throw say(
                new Error('Not authorized: cannot review your own assessment'),
                'assess:saw_err_review_own'
            );
        if (!['reviewed', 'arbitration'].includes(sa.workflowState))
            throw say(
                new Error(`Cannot validate from '${sa.workflowState}'`),
                'assess:saw_err_cannot_validate',
                { stateRaw: sa.workflowState }
            );
        // Une validation manager nomme elle aussi son auteur (référentiel §3 règle 2).
        const actorRef = this._actorRef(auth, user);
        if (!actorRef)
            throw say(
                new Error('Not authorized: a validation must name the person who gives it.'),
                'assess:saw_err_validation_unnamed'
            );
        // Atomic, and (like approve) promote the rating to the official skill
        // profile — otherwise finalising via the manager-validate path silently
        // left the employee's skill level unchanged.
        await db.runTransaction(async () => {
            // guardFrom = the two source states checked above. Without it a stale
            // validation overwrote a committed decision: measured, a row another
            // reviewer had REJECTED came back 'approved' and was promoted into the
            // official skill profile. Same STALE_STATE contract as approve.
            await this._setState(
                selfAssessmentId,
                'approved',
                {
                    approved_by: auth.isAdmin ? null : user.id,
                    approved_by_ref: actorRef,
                    approved_at: new Date().toISOString(),
                    status: 'approved',
                },
                ['reviewed', 'arbitration'],
                { cycleId: sa.cycleId, req }
            );
            // The manager's validation also stands as the supervisor review.
            await this._finalizeSupervisorReview(selfAssessmentId, auth, user, 'approve');
            await this._promoteToSkillAssessment(sa, user, auth);
            await this._event(selfAssessmentId, auth, 'validate', sa.workflowState, 'approved');
        });
        await this._audit(
            req,
            'SA_MANAGER_VALIDATE',
            selfAssessmentId,
            `manager validated final (${auth.actorType})`
        );
        // Inform the employee their assessment was validated (was inconsistent with
        // the approve/reject paths, which already notify).
        await this._notifyEmployee(sa, 'sa.manager_validated', {});
        return this.getAssessment(selfAssessmentId);
    }

    /** Manager arbitration: resolve a disagreement, optionally setting final outcome. */
    async arbitrate(selfAssessmentId, user, { outcome, note } = {}, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        if (!auth.canManage)
            throw say(
                new Error('Not authorized: manager/admin only'),
                'assess:saw_err_manager_only'
            );
        if (auth.isSelf)
            throw say(
                new Error('Not authorized: cannot arbitrate your own assessment'),
                'assess:saw_err_arbitrate_own'
            );
        // Source-state guard. Every sibling transition in this file has one;
        // `arbitrate` had none, so a manager could arbitrate an assessment from ANY
        // state — including a DRAFT the employee had never submitted, which was then
        // promoted straight to 'approved' and written into skill_assessments as an
        // official level. Proven by probe. The same set the approve path allows.
        const ARBITRABLE = ['submitted', 'under_review', 'reviewed', 'arbitration'];
        if (!ARBITRABLE.includes(sa.workflowState))
            throw say(
                new Error(`Cannot arbitrate from state '${sa.workflowState}'`),
                'assess:saw_err_cannot_arbitrate',
                { stateRaw: sa.workflowState }
            );
        const toState =
            outcome === 'approve' ? 'approved' : outcome === 'reject' ? 'rejected' : 'arbitration';
        // Une issue « approuvée » est une validation : elle nomme son auteur.
        const actorRef = this._actorRef(auth, user);
        if (toState === 'approved' && !actorRef)
            throw say(
                new Error('Not authorized: an approval must name the person who gives it.'),
                'assess:saw_err_approval_unnamed'
            );
        const extra =
            outcome === 'approve'
                ? {
                      approved_by: auth.isAdmin ? null : user.id,
                      approved_by_ref: actorRef,
                      approved_at: new Date().toISOString(),
                      status: 'approved',
                  }
                : outcome === 'reject'
                  ? { status: 'rejected' } // keep legacy status in lockstep (don't leave a stale 'approved')
                  : {};
        await db.runTransaction(async () => {
            // guardFrom must match ARBITRABLE above: it refuses a second concurrent
            // arbitration rather than silently double-applying a decision.
            await this._setState(selfAssessmentId, toState, extra, ARBITRABLE, {
                cycleId: sa.cycleId,
                req,
            });
            // A terminal arbitration also decides supervisor_reviews (was left pending/null for ever).
            if (toState === 'approved')
                await this._finalizeSupervisorReview(selfAssessmentId, auth, user, 'approve');
            else if (toState === 'rejected')
                await this._finalizeSupervisorReview(selfAssessmentId, auth, user, 'reject');
            // Arbitrating to 'approved' is a finalisation too — promote the skill.
            if (toState === 'approved') await this._promoteToSkillAssessment(sa, user, auth);
            if (note) await this.addComment(selfAssessmentId, user, note, null, auth);
            await this._event(selfAssessmentId, auth, 'arbitrate', sa.workflowState, toState, {
                outcome: outcome || 'review',
                note: note || null,
            });
        });
        await this._audit(req, 'SA_ARBITRATE', selfAssessmentId, `manager arbitrated → ${toState}`);
        return this.getAssessment(selfAssessmentId);
    }

    /** Employee responds to review comments (and may revise then re-submit separately). */
    async employeeRespond(selfAssessmentId, user, body, inReplyTo = null, req = null) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this._auth(user, sa.employeeId, { cycleId: sa.cycleId });
        // Scoped: the owner, or an in-scope non-viewer reviewer. Raw isAdmin let an
        // out-of-scope admin inject a comment on any assessment in the org.
        if (!auth.isSelf && !auth.canSupervise && !auth.canManage)
            throw say(
                new Error('Not authorized: owner/reviewer only'),
                'assess:saw_err_owner_or_reviewer_only'
            );
        const c = await this.addComment(selfAssessmentId, user, body, inReplyTo, auth);
        await this._event(selfAssessmentId, auth, 'comment', sa.workflowState, sa.workflowState, {
            commentId: c.id,
        });
        return c;
    }

    /** Add a discussion-thread comment with NO state transition — usable by a
     *  reviewer (supervisor/manager/admin) or the employee. Distinct from
     *  requestChanges, which both comments AND moves the assessment. */
    async comment(selfAssessmentId, user, body, req = null) {
        const text = String(body || '').trim();
        if (!text) throw say(new Error('Comment cannot be empty'), 'assess:saw_err_comment_empty');
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Self-assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this.resolveAuthority(user, sa.employeeId, { cycleId: sa.cycleId });
        // The SAME predicate as _assertCanView. `actorType !== 'none'` admitted
        // ANY admin (resolveAuthority labels every admin 'admin'), so a read-only
        // Viewer and an out-of-scope local admin could write into a confidential
        // thread they were refused from reading (reproduced by rolled-back probe:
        // _assertCanView "refused", comment written).
        if (!auth || !(auth.isSelf || auth.canSupervise || auth.canManage)) {
            throw say(
                new Error('Not authorized to comment on this assessment'),
                'assess:saw_err_comment_not_authorized'
            );
        }
        const c = await this.addComment(selfAssessmentId, user, text, null, auth);
        await this._event(selfAssessmentId, auth, 'comment', sa.workflowState, sa.workflowState, {
            commentId: c.id,
        });
        return c;
    }

    // ---- comments --------------------------------------------------------
    async addComment(selfAssessmentId, user, body, inReplyTo = null, auth = null) {
        let a = auth;
        if (!a) {
            const sa = await this.getAssessment(selfAssessmentId);
            a = await this.resolveAuthority(user, sa.employeeId, { cycleId: sa.cycleId });
        }
        const row = await db.get(
            `INSERT INTO self_assessment_comments (self_assessment_id, author_id, author_type, body, in_reply_to)
             VALUES (?, ?, ?, ?, ?) RETURNING *`,
            [
                selfAssessmentId,
                user && user.id != null ? user.id : null,
                a.actorType === 'none' ? 'employee' : a.actorType,
                body,
                inReplyTo,
            ]
        );
        return row;
    }

    // Confidential: only the subject, their supervisor/manager, or an in-scope
    // admin may read an assessment's thread/events.
    async _assertCanView(selfAssessmentId, user) {
        const sa = await this.getAssessment(selfAssessmentId);
        if (!sa) throw say(new Error('Assessment not found'), 'assess:acr_err_sa_not_found');
        const auth = await this.resolveAuthority(user, sa.employeeId, { cycleId: sa.cycleId });
        // canView, not canSupervise: this is the READ gate behind the thread, the
        // events and the detail panel. It must admit exactly the population the
        // console LISTS — the whole reporting sub-tree — or a reviewer is shown a
        // line and then refused everything behind it, which is what production
        // reported as "cannot see the detail". Acting (approve, request changes,
        // arbitrate) is still gated on canSupervise / canManage below.
        if (!auth.canView) {
            throw say(
                new Error('Not authorized to view this assessment'),
                'assess:saw_err_view_not_authorized'
            );
        }
        return auth;
    }

    async getThread(selfAssessmentId, user) {
        await this._assertCanView(selfAssessmentId, user);
        return await db.all(
            'SELECT * FROM self_assessment_comments WHERE self_assessment_id = ? ORDER BY created_at, id',
            [selfAssessmentId]
        );
    }

    async getEvents(selfAssessmentId, user) {
        await this._assertCanView(selfAssessmentId, user);
        return await db.all(
            'SELECT * FROM self_assessment_events WHERE self_assessment_id = ? ORDER BY created_at, id',
            [selfAssessmentId]
        );
    }

    // ---- lists -----------------------------------------------------------
    /**
     * Assessments the current user can act on (their reports, or all for admin).
     *
     * The reviewer must be able to DECIDE WITH CONTEXT, so every row carries, on
     * top of the workflow fields:
     *   - `employeeNotes`  — the employee's own justification (self_assessments.notes)
     *   - `requiredLevel` / `isCritical` — the ROLE REQUIREMENT for that skill
     *     (role_skill_requirements for the employee's current role; NULL when the
     *     skill is not part of the role's requirement set)
     *   - `validatedLevel` / `validatedAt` — the PREVIOUSLY VALIDATED official level
     *     (skill_assessments), i.e. what the org last confirmed.
     * Both LEFT JOINs are on UNIQUE keys — (role_id, skill_id) and
     * (employee_id, skill_id) — so they can never fan a row out into duplicates
     * (a duplicated row would look like an extra skill in the queue).
     *
     * NOTE on the db compat layer: raw SQL uses snake_case, and result keys come
     * back camelCased, so the aliases below are deliberately snake_case
     * (`required_level` → `requiredLevel`, `validated_at` → `validatedAt`, …).
     *
     * READS THE VIEW ON PURPOSE. Since migration 113 `self_assessments` is the
     * CURRENT round of each (employee, skill), and that is exactly what this
     * queue means: the measurements there are to take or to decide NOW. A
     * replaced round must not come back here — it would show the reviewer two
     * lines for one competency and make "approve all" act on a measurement the
     * person has already been asked to redo. (Contrast
     * SupervisorReviewModel, which lists REVIEWS: a review belongs to the round
     * it judged, so every join there addresses `self_assessment_rounds`. A
     * decision still owed on a replaced round therefore surfaces in the
     * supervisor review console, not here.) Same reasoning for
     * bulkApproveForEmployee and completionStats below.
     */
    async reviewQueue(user, { cycleId } = {}) {
        // Leavers are not reviewed: every scoped user already got active staff
        // only (scopeFilter), a SuperAdmin — unrestricted — saw their cards too.
        let where = "sa.workflow_state <> 'draft' AND e.is_active = true";
        const params = [];
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        // THE ASSIGNED CAMPAIGN REVIEWER SEES WHAT THEY WERE ASSIGNED (3.23.17,
        // F1): the rows of the cycle for which the console named them — never
        // their own, never another cycle's. The same predicate as
        // resolveAuthority's _assignedCycles, so the queue and the authority
        // cannot disagree. Added to the scope, never substituted for it.
        const isAdmin = Boolean(user && user.userType === 'admin');
        const personId = await GovernanceService.actingPersonId(user);
        if (sc.clause && user && user.id != null && (isAdmin || personId != null)) {
            where += ` AND ((1=1${sc.clause}) OR (
                    (?::bigint IS NULL OR sa.employee_id <> ?::bigint)
                    AND EXISTS (SELECT 1 FROM cycle_participants cp
                                 WHERE cp.cycle_id = sa.cycle_id AND cp.employee_id = sa.employee_id
                                   AND cp.reviewer_assigned_at IS NOT NULL AND cp.excluded_at IS NULL
                                   AND ((cp.reviewer_admin_id IS NOT NULL AND ? AND cp.reviewer_admin_id = ?)
                                     OR (cp.reviewer_admin_id IS NULL AND cp.supervisor_id = ?)))))`;
            params.push(
                ...sc.params,
                personId,
                personId,
                isAdmin,
                isAdmin ? Number(user.id) : null,
                personId
            );
        } else {
            where += sc.clause;
            params.push(...sc.params);
        }
        // Campaign filter: the queue mixes organic rows (cycle_id NULL)
        // with campaign rows; `cycleId` narrows it to one campaign so a manager
        // can answer "what is left for 2026-Q3". 'none' = outside any campaign.
        if (cycleId === 'none') where += ' AND sa.cycle_id IS NULL';
        else if (Number(cycleId) > 0) {
            where += ' AND sa.cycle_id = ?';
            params.push(Number(cycleId));
        }
        return await db.all(
            `SELECT sa.id, sa.workflow_state, sa.self_rated_level, sa.skill_id,
                    sa.notes AS employee_notes,
                    sa.cycle_id AS cycle_id, cyc.code AS cycle_code,
                    e.id AS employee_id, e.first_name, e.last_name,
                    sk.name AS skill_name,
                    rsr.required_level AS required_level,
                    COALESCE(rsr.is_critical, false) AS is_critical,
                    ska.current_level AS validated_level,
                    ska.assessed_at AS validated_at,
                    (SELECT COUNT(*) FROM self_assessment_comments c WHERE c.self_assessment_id = sa.id)::int AS comment_count
             FROM self_assessments sa
             JOIN employees e ON e.id = sa.employee_id
             LEFT JOIN assessment_cycles cyc ON cyc.id = sa.cycle_id
             LEFT JOIN skills sk ON sk.id = sa.skill_id
             LEFT JOIN role_skill_requirements rsr
                    ON rsr.skill_id = sa.skill_id AND rsr.role_id = e.role_id
             LEFT JOIN skill_assessments ska
                    ON ska.employee_id = sa.employee_id AND ska.skill_id = sa.skill_id
             WHERE ${where}
             ORDER BY sa.updated_at DESC, sa.id DESC`,
            params
        );
    }

    /** Review queue grouped BY EMPLOYEE — one card per person with counts + the
     *  per-skill rows, so a supervisor/manager can see and bulk-approve a whole
     *  person's assessment at once. */
    async reviewQueueByEmployee(user, opts = {}) {
        const rows = await this.reviewQueue(user, opts);
        // 3.23.21: the reviewer sees what the employee saw — the skill's
        // description and the meaning of each level (the self-rating's and the
        // required one). Two batched queries for the whole queue; best-effort.
        await require('./SkillHelpService').attach(rows);
        const byEmp = new Map();
        for (const r of rows) {
            const key = Number(r.employeeId);
            if (!byEmp.has(key)) {
                byEmp.set(key, {
                    employeeId: key,
                    firstName: r.firstName,
                    lastName: r.lastName,
                    items: [],
                    counts: {},
                    cycles: [],
                    pending: 0,
                    total: 0,
                });
            }
            const g = byEmp.get(key);
            g.items.push(r);
            // Which campaign(s) the person's rows belong to (a chip on the card).
            const code = r.cycleId != null ? String(r.cycleCode || r.cycleId) : null;
            if (!g.cycles.some((c) => c.code === code))
                g.cycles.push({ id: r.cycleId != null ? Number(r.cycleId) : null, code });
            g.total++;
            g.counts[r.workflowState] = (g.counts[r.workflowState] || 0) + 1;
            if (['submitted', 'under_review', 'reviewed', 'arbitration'].includes(r.workflowState))
                g.pending++;
        }
        // People with something to act on first.
        return Array.from(byEmp.values()).sort(
            (a, b) => b.pending - a.pending || a.lastName.localeCompare(b.lastName)
        );
    }

    /** Movement timeline for ONE employee: every workflow handoff between the
     *  employee and their reviewer across all of their assessments. */
    async movementForEmployee(employeeId, user) {
        const auth = await this.resolveAuthority(user, employeeId);
        // READ, so canView — which covers the whole reporting sub-tree, the same
        // population the console lists. Gating a read on canSupervise refused an
        // N+2 reviewer the detail of a line their own queue had just shown them.
        if (!auth.canView) {
            throw say(
                new Error('Not authorized to view this timeline'),
                'assess:saw_err_timeline_not_authorized'
            );
        }
        return await db.all(
            `SELECT ev.id, ev.self_assessment_id, ev.actor_type, ev.action,
                    ev.from_state, ev.to_state, ev.created_at,
                    sk.name AS skill_name
               FROM self_assessment_events ev
               JOIN self_assessments sa ON sa.id = ev.self_assessment_id
               LEFT JOIN skills sk ON sk.id = sa.skill_id
              WHERE sa.employee_id = ?
              ORDER BY ev.created_at DESC, ev.id DESC
              LIMIT 500`,
            [employeeId]
        );
    }

    /** An employee's own assessments with current state + comment counts. */
    async listForEmployee(employeeId) {
        // CLOSING THE LOOP FOR THE EMPLOYEE.
        // The old projection stopped at "state + comment count", so somebody whose
        // level had been LOWERED saw a badge and nothing else: not who is holding
        // the file, not the level that was retained, not the reason. Three joins
        // fix that — the current holder resolved to a name, and the supervisor's
        // own ruling (retained level, gap reason, notes, date) carried alongside.
        //
        // This ADDS explanation to rows that already exist. It does not filter,
        // sample or group the skill list: every self-assessment row the employee
        // owns is still returned, one per department-designed skill.
        const rows = await db.all(
            `SELECT sa.id, sa.workflow_state, sa.self_rated_level, sa.skill_id, sk.name AS skill_name,
                    sa.current_reviewer_id,
                    rv.first_name || ' ' || rv.last_name AS current_reviewer_name,
                    sr.supervisor_rated_level, sr.gap, sr.gap_reason, sr.supervisor_notes, sr.reviewed_at,
                    rb.first_name || ' ' || rb.last_name AS reviewed_by_name,
                    (SELECT COUNT(*) FROM self_assessment_comments c WHERE c.self_assessment_id = sa.id)::int AS comment_count
             FROM self_assessments sa
             LEFT JOIN skills sk ON sk.id = sa.skill_id
             LEFT JOIN employees rv ON rv.id = sa.current_reviewer_id
             LEFT JOIN LATERAL (
                 SELECT r.supervisor_rated_level, r.gap, r.gap_reason, r.supervisor_notes,
                        r.reviewed_at, r.reviewed_by
                   FROM supervisor_reviews r
                  WHERE r.self_assessment_id = sa.id
                  ORDER BY r.reviewed_at DESC, r.id DESC
                  LIMIT 1
             ) sr ON true
             LEFT JOIN employees rb ON rb.id = sr.reviewed_by
             WHERE sa.employee_id = ? ORDER BY sa.updated_at DESC, sa.id DESC`,
            [employeeId]
        );

        // WHERE THE PERSON STANDS IN THE CAMPAIGN, from the roster view (migration 70).
        // Attached as a property of the returned array rather than changing the
        // return shape: callers (the /api/self-assessment/mine JSON handler and the
        // server-rendered status page) both still receive the plain list of rows.
        // `expected_skills` is the FULL department-designed requirement count — it is
        // reported, never reduced.
        //
        // A LOCKED campaign is still returned (the person's enrolment and counters
        // are real history), but it is not "en cours": SelfAssessmentService files
        // a rating written now under the OPEN cycle only, so nothing saved today
        // can move a locked campaign's counters. `cycle_status` + `is_open` let
        // the status page say so instead of offering a "Continue" that leads
        // nowhere. An open campaign always wins over a locked one when both exist.
        try {
            rows.campaign =
                (await db.get(
                    `SELECT c.id AS cycle_id, c.code AS cycle_code, c.label AS cycle_label,
                        c.closes_at, c.status AS cycle_status,
                        (c.status = 'open') AS is_open,
                        s.expected_skills, s.rated_skills, s.submitted_skills, s.approved_skills,
                        s.participant_state
                   FROM v_cycle_participant_status s
                   JOIN assessment_cycles c ON c.id = s.cycle_id
                  WHERE s.employee_id = ? AND s.excluded_at IS NULL
                    AND c.status IN ('open', 'locked')
                  ORDER BY (c.status = 'open') DESC, c.closes_at ASC
                  LIMIT 1`,
                    [employeeId]
                )) || null;
        } catch (_) {
            // A campaign banner must never cost the employee their assessment list.
            rows.campaign = null;
        }
        return rows;
    }

    // ---- analytics (manager/admin) --------------------------------------
    async completionStats(user) {
        const params = [];
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const where = 'WHERE 1=1' + sc.clause;
        params.push(...sc.params);
        const byState = await db.all(
            `SELECT sa.workflow_state AS state, COUNT(*)::int AS n
             FROM self_assessments sa JOIN employees e ON e.id = sa.employee_id
             ${where} GROUP BY sa.workflow_state ORDER BY 1`,
            params
        );
        return { byState };
    }

    /** Email/in-app notify the assessment's owner of a workflow change (best-effort). */
    async _notifyEmployee(sa, kind, payload = {}) {
        try {
            // SAVEPOINT: a swallowed failure inside a caller's transaction would
            // otherwise abort every statement after it (see `_audit` below).
            await db.runInSavepoint(() =>
                require('./NotificationService')
                    .notify({
                        userType: 'employee',
                        userId: sa.employeeId,
                        kind,
                        category: 'workflow',
                        payload: { skillId: sa.skillId, ...payload },
                    })
                    .catch(() => {})
            );
        } catch (_) {
            /* never block a transition on notification */
        }
    }

    /**
     * HR4-25 — l'acteur est nommé SANS CONDITION, par `actor_ref`.
     *
     * `system_logs.admin_id` est une clé étrangère vers `admins`, et un
     * superviseur ou un manager est un EMPLOYÉ : l'insertion échouait donc en
     * 23503. Hors transaction c'est sans conséquence (LogService réessaie en
     * `actor_ref`), mais DANS une transaction l'échec avorte tout ce qui suit —
     * mesuré : l'octroi d'une demande de modification par un manager répondait
     * 500 « current transaction is aborted » pour cette seule raison, la ligne
     * étant pourtant correctement rendue à l'employé juste avant.
     *
     * La référence d'acteur supprime la cause ; le SAVEPOINT supprime la classe
     * entière de défaut : un audit délibérément avalé ne peut plus empoisonner la
     * transaction de son appelant.
     */
    async _audit(req, action, entityId, details) {
        const u = req && req.user;
        try {
            await db.runInSavepoint(() =>
                LogService.log({
                    adminId: u && u.id != null ? u.id : null,
                    actorRef:
                        u && u.id != null
                            ? `${u.userType === 'admin' ? 'admin' : 'employee'}:${u.id}`
                            : null,
                    action,
                    entityType: 'selfAssessment',
                    entityId,
                    details,
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                })
            );
        } catch (_) {
            /* audit must never break the transition */
        }
    }
}

module.exports = new SelfAssessmentWorkflowService();
