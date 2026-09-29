'use strict';
/**
 * AssessmentChangeRequestService — LA DEMANDE DE MODIFICATION.
 *
 * Règle du propriétaire, énoncée deux fois et reprise au HR policy du
 * 13/09/2026 (§3 règle 5, arbitrage A7) :
 *
 *   « ensure that everyone doing an assessment can change it except if already
 *     validated by manager or if the campaign already closed »
 *   « the supervisor and manager should be able … to cancel an assessment if only
 *     not already approved by manager, outside that the supervisor should enter a
 *     request for change, the employee to change its self assessment outside a new
 *     campaign should as well enter a request for change »
 *
 * Elle n'existait NULLE PART (HR1-15, HR4-15 — mesuré : ni table, ni route, ni
 * code), donc ces deux règles étaient inapplicables : les seules façons de rouvrir
 * un dossier décidé étaient une dérogation SuperAdmin ou un litige.
 *
 * CE QU'ELLE EST (et rien de moins — c'est la définition, pas une commodité) :
 *   - QUI demande : l'employé sur sa propre évaluation, ou le superviseur/manager ;
 *   - QUAND, et un MOTIF OBLIGATOIRE ;
 *   - QUELLE ligne, et DANS QUEL ÉTAT elle était au moment de la demande ;
 *   - une DÉCISION — accordée ou refusée — par un décideur NOMMÉ, à une date, avec
 *     un motif obligatoire sur un refus ;
 *   - visible des DEUX côtés : le demandeur voit l'issue, le décideur a une file ;
 *   - L'OCTROI EST LA SEULE CHOSE QUI ROUVRE LE DROIT DE MODIFIER ;
 *   - jamais accordée dans une campagne close, et l'octroi ne rouvre JAMAIS la
 *     campagne (seul `CycleService.reopenClosed` le fait).
 *
 * Ce qui NE passe PAS par ici :
 *   - un brouillon (ou une ligne renvoyée à l'employé) : il la modifie librement ;
 *   - une nouvelle campagne qui rouvre le tour : la personne est RE-DEMANDÉE, donc
 *     elle répond librement (`SelfAssessmentService`, événement `reopen_new_cycle`) ;
 *   - une évaluation pas encore validée que le superviseur veut retirer : il
 *     l'ANNULE directement (`SelfAssessmentWorkflowService.cancelByReviewer`).
 */
const db = require('../config/database');
const WF = require('./SelfAssessmentWorkflowService');
const LogService = require('./LogService');
const { fmtDate } = require('../utils/dateFormat');

/** A7 — délai de contestation d'une évaluation DÉCIDÉE, en jours. */
const CONTEST_WINDOW_DAYS = 30;

/** Les états dans lesquels une modification exige une demande (règle A du propriétaire). */
const REQUEST_REQUIRED_STATES = ['submitted', 'under_review', 'reviewed', 'approved'];
/** Ce que l'employé peut modifier sans rien demander à personne. */
const EDITABLE_STATES = ['draft', 'changes_requested'];

/**
 * Un refus porte quatre choses (constat M-02) :
 *   - `message` : LA PHRASE DE RÉFÉRENCE. Elle ne bouge pas — les journaux la
 *     citent et `utils/apiErrors.domainStatus` en dérive un statut quand
 *     personne n'en a posé.
 *   - `code`    : l'identifiant stable que le client teste.
 *   - `status`  : le statut HTTP, posé ici et non deviné.
 *   - `i18n`    : LA CLÉ DU CATALOGUE et ses variables. C'est elle que lit
 *     l'utilisateur : la poignée (qui tient `req.t`) la résout dans SA langue.
 *     Six refus de ce domaine étaient rendus en anglais sur une page française,
 *     dont un exposant une valeur d'énumération brute (« Cannot cancel from
 *     'draft' ») ; d'autres, écrits en français, l'étaient sur la page anglaise.
 */
function refuse(message, code, status = 400, i18n = null) {
    const e = new Error(message);
    if (code) e.code = code;
    e.status = status;
    e.expose = true;
    if (i18n) e.i18n = i18n;
    return e;
}

class AssessmentChangeRequestService {
    static get CONTEST_WINDOW_DAYS() {
        return CONTEST_WINDOW_DAYS;
    }
    static get REQUEST_REQUIRED_STATES() {
        return REQUEST_REQUIRED_STATES;
    }
    static get EDITABLE_STATES() {
        return EDITABLE_STATES;
    }

    /**
     * Le tour visé, lu dans `self_assessment_rounds` et non dans la vue : une
     * demande peut viser un tour antérieur (lot 1 — la vue ne montre que le tour
     * courant, l'historique vit dans la table des tours).
     */
    async _round(selfAssessmentId) {
        return await db.get(
            `SELECT r.id, r.employee_id AS "employeeId", r.skill_id AS "skillId",
                    r.workflow_state AS "workflowState", r.status::text AS "status",
                    r.cycle_id AS "cycleId", r.approved_at AS "approvedAt",
                    r.reviewed_at AS "reviewedAt", r.submitted_at AS "submittedAt",
                    r.superseded_at AS "supersededAt", sk.name AS "skillName"
               FROM self_assessment_rounds r
               LEFT JOIN skills sk ON sk.id = r.skill_id
              WHERE r.id = ?`,
            [selfAssessmentId]
        );
    }

    /**
     * Une NOUVELLE CAMPAGNE rouvre le tour : la personne est re-demandée, elle
     * répond librement et aucune demande n'est nécessaire. Même prédicat que
     * `SelfAssessmentService` (`askedAgain`) — il n'y a pas deux définitions de
     * « on me redemande » dans le produit.
     */
    async _reopenedByNewCampaign(round) {
        const open = await db.get(
            "SELECT id, code, label FROM assessment_cycles WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
        );
        if (!open) return null;
        const rowCycle = round.cycleId != null ? String(round.cycleId) : null;
        return rowCycle !== String(open.id) ? open : null;
    }

    /** La date de la DÉCISION que l'on conteste, ou null si rien n'a été décidé. */
    _decidedAt(round) {
        const d = round.approvedAt || round.reviewedAt || null;
        if (!d) return null;
        const t = new Date(d);
        return Number.isNaN(t.getTime()) ? null : t;
    }

    /** A7 — 30 jours pour contester. Aucune décision = aucun délai qui court. */
    _assertWithinContestWindow(round) {
        const decided = this._decidedAt(round);
        if (!decided) return null;
        const days = Math.floor((Date.now() - decided.getTime()) / 86400000);
        if (days > CONTEST_WINDOW_DAYS) {
            const until = new Date(decided.getTime() + CONTEST_WINDOW_DAYS * 86400000);
            // E-13 (second foyer) — deux dates ISO dans une phrase française.
            // `src/utils/dateFormat.js` est le rendu unique du produit : jj/mm/aaaa
            // dans les deux langues, « — » pour une date illisible.
            const vars = {
                decided: fmtDate(decided),
                until: fmtDate(until),
                days: CONTEST_WINDOW_DAYS,
            };
            throw refuse(
                `Le délai pour contester cette évaluation est passé : la décision date du ` +
                    `${vars.decided} et le délai de ${CONTEST_WINDOW_DAYS} jours a expiré le ${vars.until}.`,
                'contest_window_expired',
                409,
                { key: 'assess:acr_err_contest_window', vars }
            );
        }
        return days;
    }

    // ---- création --------------------------------------------------------

    /**
     * Déposer une demande. Le demandeur est l'employé concerné OU son
     * superviseur/manager (ou un administrateur dans son périmètre).
     */
    async create(selfAssessmentId, user, { reason } = {}, req = null) {
        const round = await this._round(selfAssessmentId);
        if (!round)
            throw refuse('Self-assessment not found', 'not_found', 404, {
                key: 'assess:acr_err_sa_not_found',
            });
        const auth = await WF._auth(user, round.employeeId);
        if (!auth.isSelf && !auth.canSupervise && !auth.canManage)
            throw refuse(
                'Not authorized: the subject, their supervisor or their manager only',
                'forbidden',
                403,
                { key: 'assess:acr_err_not_authorized_subject' }
            );
        const why = String(reason == null ? '' : reason).trim();
        if (!why)
            throw refuse(
                'Un motif est obligatoire pour demander une modification.',
                'reason_required',
                400,
                { key: 'assess:acr_err_reason_required' }
            );

        // 1. UNE CAMPAGNE CLOSE OU VERROUILLÉE REFUSE TOUT — y compris de recevoir
        //    une demande, puisqu'elle ne pourrait jamais y être accordée. La phrase
        //    nomme la campagne et sa date (CycleService.gateMessage, lot 5).
        await WF._assertCycleWritable(round.cycleId, 'changes_requested', req);

        // 2. Ce qui est déjà libre ne se demande pas.
        if (auth.isSelf && EDITABLE_STATES.includes(round.workflowState))
            throw refuse(
                'Cette évaluation est encore la vôtre : modifiez-la directement, aucune demande n’est nécessaire.',
                'already_editable',
                409,
                { key: 'assess:acr_err_already_editable' }
            );
        const reopened = auth.isSelf ? await this._reopenedByNewCampaign(round) : null;
        if (reopened)
            throw refuse(
                `La campagne ${reopened.code} vous redemande cette évaluation : répondez-y directement, ` +
                    'aucune demande n’est nécessaire.',
                'reopened_by_new_campaign',
                409,
                { key: 'assess:acr_err_reopened_by_campaign', vars: { cycle: reopened.code } }
            );

        // 3. Tant que ce n'est pas VALIDÉ, le superviseur/manager ANNULE directement
        //    (règle B) : une demande serait une procédure pour rien.
        if (!auth.isSelf && round.workflowState !== 'approved')
            throw refuse(
                'Cette évaluation n’est pas encore validée : annulez-la directement (état + motif), ' +
                    'une demande de modification n’est exigée qu’au-delà de la validation.',
                'cancel_directly',
                409,
                { key: 'assess:acr_err_cancel_directly' }
            );

        // `stateRaw` et non l'état : la poignée le passe par le dictionnaire
        // d'énumérations, une page ne montre jamais une valeur de base (M-02).
        if (!REQUEST_REQUIRED_STATES.includes(round.workflowState))
            throw refuse(
                `Aucune modification à demander sur une évaluation dans l’état « ${round.workflowState} ».`,
                'state_not_requestable',
                409,
                {
                    key: 'assess:acr_err_state_not_requestable',
                    vars: { stateRaw: round.workflowState },
                }
            );

        // 4. A7 — 30 jours pour contester une décision.
        this._assertWithinContestWindow(round);

        // 5. Une seule demande ouverte par ligne (index unique partiel) — un
        //    message plutôt qu'une violation de contrainte.
        const open = await db.get(
            "SELECT id FROM assessment_change_requests WHERE self_assessment_id = ? AND status = 'pending'",
            [selfAssessmentId]
        );
        if (open)
            throw refuse(
                'Une demande est déjà en cours sur cette évaluation.',
                'already_pending',
                409,
                { key: 'assess:acr_err_already_pending' }
            );

        const requesterRef = WF._actorRef(auth, user);
        if (!requesterRef)
            throw refuse('Not authorized: a request must name who raises it', 'forbidden', 403, {
                key: 'assess:acr_err_request_unnamed',
            });
        const row = await db.get(
            `INSERT INTO assessment_change_requests
                 (self_assessment_id, employee_id, cycle_id, requester_ref, requester_role,
                  reason, target_state, target_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            [
                selfAssessmentId,
                round.employeeId,
                round.cycleId,
                requesterRef,
                auth.actorType === 'none' ? 'employee' : auth.actorType,
                why,
                round.workflowState,
                round.status,
            ]
        );
        // La demande est elle-même un mouvement du dossier : elle appartient à la
        // trace de l'évaluation, pas seulement à une table à part.
        await WF._event(
            selfAssessmentId,
            auth,
            'change_request_raised',
            round.workflowState,
            round.workflowState,
            { changeRequestId: Number(row.id), reason: why, by: requesterRef }
        );
        await this._audit(
            req,
            'SA_CHANGE_REQUEST_RAISED',
            selfAssessmentId,
            `change request #${row.id} raised by ${requesterRef} on assessment #${selfAssessmentId}` +
                ` (state '${round.workflowState}'). Reason: ${why}`
        );
        await this._notifyDeciders(round, row, auth);
        return row;
    }

    // ---- décision --------------------------------------------------------

    async _request(id) {
        return await db.get(
            `SELECT id, self_assessment_id AS "selfAssessmentId", employee_id AS "employeeId",
                    cycle_id AS "cycleId", requester_ref AS "requesterRef", requester_role AS "requesterRole",
                    reason, target_state AS "targetState", target_status AS "targetStatus", status,
                    decided_by_ref AS "decidedByRef", decided_by_role AS "decidedByRole",
                    decided_at AS "decidedAt", decision_reason AS "decisionReason", created_at AS "createdAt"
               FROM assessment_change_requests WHERE id = ?`,
            [id]
        );
    }

    /**
     * Accorder ou refuser. Un refus porte TOUJOURS son motif ; un octroi rend la
     * ligne à l'employé dans la MÊME transaction que la décision.
     */
    async decide(requestId, user, { decision, reason } = {}, req = null) {
        const cr = await this._request(requestId);
        if (!cr)
            throw refuse('Change request not found', 'not_found', 404, {
                key: 'assess:acr_err_cr_not_found',
            });
        if (cr.status !== 'pending')
            throw refuse(
                `Cette demande a déjà été traitée (${cr.status}).`,
                'already_decided',
                409,
                { key: 'assess:acr_err_already_decided', vars: { outcomeRaw: cr.status } }
            );
        if (!['granted', 'refused'].includes(decision))
            throw refuse('Décision invalide.', 'invalid_decision', 400, {
                key: 'assess:acr_err_invalid_decision',
            });
        const why = String(reason == null ? '' : reason).trim();
        if (decision === 'refused' && !why)
            throw refuse(
                'Un motif est obligatoire pour refuser une demande de modification.',
                'reason_required',
                400,
                { key: 'assess:acr_err_refuse_reason_required' }
            );

        const auth = await WF._auth(user, cr.employeeId);
        // Une évaluation VALIDÉE ne se rouvre que par l'autorité qui peut la
        // rouvrir : le manager ou un administrateur, jamais le seul superviseur.
        const needsManager = cr.targetState === 'approved';
        if (needsManager ? !auth.canManage : !(auth.canSupervise || auth.canManage))
            throw refuse(
                needsManager
                    ? 'Not authorized: manager/admin only — this assessment has been validated'
                    : 'Not authorized: supervisor/manager/admin only',
                'forbidden',
                403,
                {
                    key: needsManager
                        ? 'assess:acr_err_decide_manager_only'
                        : 'assess:acr_err_not_authorized_reviewer',
                }
            );
        const deciderRef = WF._actorRef(auth, user);
        if (!deciderRef)
            throw refuse('Not authorized: a decision must name its decider', 'forbidden', 403, {
                key: 'assess:acr_err_decision_unnamed',
            });
        // Personne ne décide sa propre demande : ce serait l'octroi sans la demande.
        // Par PERSONNE, pas par compte (3.23.17, B-3) : la demande faite sur le
        // compte employé et tranchée sur le compte d'administration lié
        // (admins.linked_employee_id) reste la même paire d'yeux.
        if (
            deciderRef === cr.requesterRef ||
            (await require('../utils/personIdentity').isSamePerson(user, cr.requesterRef))
        )
            throw refuse(
                'Not authorized: you cannot decide your own request for change',
                'forbidden',
                403,
                { key: 'assess:acr_err_decide_own' }
            );

        const round = await this._round(cr.selfAssessmentId);
        if (!round)
            throw refuse('Self-assessment not found', 'not_found', 404, {
                key: 'assess:acr_err_sa_not_found',
            });

        await db.runTransaction(async () => {
            // UNE DEMANDE NE PEUT PAS ÊTRE ACCORDÉE DANS UNE CAMPAGNE CLOSE, et
            // l'octroi ne rouvre JAMAIS la campagne : la porte est lue sur la
            // campagne ACTUELLE de la ligne (`applyGrantedChangeRequest` la
            // repasse de toute façon dans `_setState`). Lecture seule : avant
            // toute écriture.
            if (decision === 'granted')
                await WF._assertCycleWritable(round.cycleId, 'changes_requested', req);
            // LA DÉCISION D'ABORD, ET SON ROWCOUNT EST LU. La pré-lecture de
            // `cr.status` ci-dessus n'est pas un verrou : entre elle et cette
            // transaction, un second décideur peut avoir REFUSÉ la demande. La
            // réouverture s'exécutait AVANT cet UPDATE et `changes` n'était jamais
            // lu : mesuré (rollback), après un refus concurrent l'octroi rendait
            // la ligne à l'employé ('changes_requested'), journalisait
            // « change_request_granted » (table en ajout seul) et notifiait
            // « accordée » — sur une demande restée « refusée ». Même garde que
            // `CancellationService.decide` : zéro ligne = déjà décidée, 409, et la
            // transaction n'a rien écrit d'autre.
            const { changes } = await db.run(
                `UPDATE assessment_change_requests
                    SET status = ?, decided_by_ref = ?, decided_by_role = ?, decided_at = now(),
                        decision_reason = ?, updated_at = now()
                  WHERE id = ? AND status = 'pending'`,
                [
                    decision,
                    deciderRef,
                    auth.actorType === 'none' ? 'employee' : auth.actorType,
                    why || null,
                    cr.id,
                ]
            );
            if (!changes) {
                const now = await this._request(cr.id);
                throw refuse(
                    `Cette demande a déjà été traitée (${now ? now.status : '?'}).`,
                    'already_decided',
                    409,
                    {
                        key: 'assess:acr_err_already_decided',
                        vars: { outcomeRaw: now ? now.status : '—' },
                    }
                );
            }
            if (decision === 'granted') {
                await WF.applyGrantedChangeRequest(
                    cr.selfAssessmentId,
                    user,
                    { requestId: cr.id, reason: why || cr.reason },
                    req
                );
            }
        });

        await this._audit(
            req,
            decision === 'granted' ? 'SA_CHANGE_REQUEST_GRANTED' : 'SA_CHANGE_REQUEST_REFUSED',
            cr.selfAssessmentId,
            `change request #${cr.id} ${decision} by ${deciderRef}` +
                ` (raised by ${cr.requesterRef} on a '${cr.targetState}' assessment).` +
                (why ? ` Reason: ${why}` : '')
        );
        // LE DEMANDEUR VOIT L'ISSUE — des deux côtés, toujours.
        await this._notifyRequester(cr, decision, why);
        return await this._request(cr.id);
    }

    /** Le demandeur retire sa demande tant qu'elle n'a pas été décidée. */
    async withdraw(requestId, user, req = null) {
        const cr = await this._request(requestId);
        if (!cr)
            throw refuse('Change request not found', 'not_found', 404, {
                key: 'assess:acr_err_cr_not_found',
            });
        if (cr.status !== 'pending')
            throw refuse(
                `Cette demande a déjà été traitée (${cr.status}).`,
                'already_decided',
                409,
                { key: 'assess:acr_err_already_decided', vars: { outcomeRaw: cr.status } }
            );
        const auth = await WF._auth(user, cr.employeeId);
        const ref = WF._actorRef(auth, user);
        if (ref !== cr.requesterRef)
            throw refuse(
                'Not authorized: only the person who raised the request may withdraw it',
                'forbidden',
                403,
                { key: 'assess:acr_err_withdraw_not_requester' }
            );
        const { changes } = await db.run(
            `UPDATE assessment_change_requests
                SET status = 'withdrawn', decided_by_ref = ?, decided_by_role = ?, decided_at = now(),
                    updated_at = now()
              WHERE id = ? AND status = 'pending'`,
            [ref, auth.actorType === 'none' ? 'employee' : auth.actorType, cr.id]
        );
        // Même garde que `decide` : décidée entre la pré-lecture et l'UPDATE, la
        // demande n'est pas « retirée » — et on ne journalise pas un retrait qui
        // n'a pas eu lieu.
        if (!changes) {
            const now = await this._request(cr.id);
            throw refuse(
                `Cette demande a déjà été traitée (${now ? now.status : '?'}).`,
                'already_decided',
                409,
                {
                    key: 'assess:acr_err_already_decided',
                    vars: { outcomeRaw: now ? now.status : '—' },
                }
            );
        }
        await this._audit(
            req,
            'SA_CHANGE_REQUEST_WITHDRAWN',
            cr.selfAssessmentId,
            `change request #${cr.id} withdrawn by ${ref}`
        );
        return await this._request(cr.id);
    }

    // ---- lectures (les deux côtés) ---------------------------------------

    /**
     * Colonnes communes aux deux listes, avec le nom de la compétence — ET LE NOM
     * DES DEUX PERSONNES QUI ONT AGI (constat M-04, et sa jumelle E-12).
     *
     * L'écran ne portait que `requester_ref` / `decided_by_ref` et les recollait
     * en « Employé #136 » : sur une file de onze lignes mélangeant les demandes
     * de la personne et celles déposées par son superviseur, rien ne disait qui
     * avait demandé quoi. Le reste du produit résout ces références en nom
     * (`system-logs/index.ejs:97`, `employees/show.ejs:686`) ; on les résout donc
     * ici, une fois, pour les deux listes. Les deux jointures sont sur des clés
     * primaires et le nom reste NULL si la référence ne désigne personne — la vue
     * retombe alors sur la référence, jamais sur un nom inventé.
     */
    _selectList() {
        return `SELECT cr.id, cr.self_assessment_id AS "selfAssessmentId", cr.employee_id AS "employeeId",
                       cr.cycle_id AS "cycleId", cyc.code AS "cycleCode", cyc.status AS "cycleStatus",
                       cr.requester_ref AS "requesterRef", cr.requester_role AS "requesterRole",
                       cr.reason, cr.target_state AS "targetState", cr.status,
                       cr.decided_by_ref AS "decidedByRef", cr.decided_at AS "decidedAt",
                       cr.decision_reason AS "decisionReason", cr.created_at AS "createdAt",
                       sk.name AS "skillName", r.workflow_state AS "currentState",
                       e.first_name || ' ' || e.last_name AS "employeeName",
                       e.manager_id AS "subjectManagerId",
                       COALESCE(re.first_name || ' ' || re.last_name, ra.username) AS "requesterName",
                       COALESCE(de.first_name || ' ' || de.last_name, da.username) AS "deciderName"
                  FROM assessment_change_requests cr
                  JOIN self_assessment_rounds r ON r.id = cr.self_assessment_id
                  LEFT JOIN skills sk ON sk.id = r.skill_id
                  LEFT JOIN employees e ON e.id = cr.employee_id
                  LEFT JOIN assessment_cycles cyc ON cyc.id = cr.cycle_id
                  LEFT JOIN employees re ON 'employee:' || re.id = cr.requester_ref
                  LEFT JOIN admins ra ON 'admin:' || ra.id = cr.requester_ref
                  LEFT JOIN employees de ON 'employee:' || de.id = cr.decided_by_ref
                  LEFT JOIN admins da ON 'admin:' || da.id = cr.decided_by_ref`;
    }

    /** Ce que MOI, demandeur, ai demandé — et ce qui en a été décidé. */
    async listMine(user) {
        const isAdmin = Boolean(user && user.userType === 'admin');
        const ref =
            user && user.id != null ? `${isAdmin ? 'admin' : 'employee'}:${Number(user.id)}` : null;
        if (!ref) return [];
        // L'employé concerné voit aussi les demandes déposées SUR son évaluation
        // par son superviseur : la décision le concerne au premier chef.
        return await db.all(
            `${this._selectList()} WHERE cr.requester_ref = ?${isAdmin ? '' : ' OR cr.employee_id = ?'}
              ORDER BY cr.created_at DESC, cr.id DESC LIMIT 200`,
            isAdmin ? [ref] : [ref, Number(user.id)]
        );
    }

    /**
     * LA FILE DU DÉCIDEUR : les demandes sur les personnes de son périmètre.
     *
     * Constat M-03 — elle n'appliquait que le périmètre RBAC, si bien qu'elle
     * contenait LES DEMANDES DU LECTEUR LUI-MÊME, boutons actifs, alors que
     * `decide` les refuse par deux règles distinctes : « personne ne décide sa
     * propre demande » (règle des deux personnes) et « une évaluation VALIDÉE ne
     * se rouvre que par le manager ou un administrateur ».
     *
     *   - ma propre demande sort de MA file : elle n'y a aucune décision à
     *     prendre, et elle reste entièrement lisible dans « Mes demandes » — rien
     *     n'est masqué, c'est la même ligne vue du bon côté ;
     *   - une demande portant sur une évaluation VALIDÉE que je ne peux pas
     *     décider reste affichée — c'est de l'information de périmètre — mais
     *     elle porte `canDecide:false` et l'écran dit alors QUI décide, au lieu
     *     d'offrir deux boutons qui rendront 403 (arbitrage §7-5 : la règle des
     *     deux personnes est gardée, la voie est expliquée).
     */
    async queue(user, { status = 'pending' } = {}) {
        const RBACService = require('./RBACService');
        const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
        const isAdmin = Boolean(user && user.userType === 'admin');
        const me = user && user.id != null ? Number(user.id) : null;
        const myRef = me != null ? `${isAdmin ? 'admin' : 'employee'}:${me}` : null;
        const params = [];
        let where = '1=1';
        if (status && status !== 'all') {
            where += ' AND cr.status = ?';
            params.push(status);
        }
        if (myRef) {
            where += ' AND cr.requester_ref <> ?';
            params.push(myRef);
        }
        where += sc.clause;
        params.push(...sc.params);
        const rows = await db.all(
            `${this._selectList()} WHERE ${where} ORDER BY cr.created_at ASC, cr.id ASC LIMIT 200`,
            params
        );
        // Même prédicat que `decide` : `canManage` pour une cible VALIDÉE,
        // `canSupervise` sinon. Un lecteur seul (viewer) ne décide rien.
        const isViewer = RBACService.isViewer(user);
        return rows.map((r) => {
            const mine = me != null && Number(r.employeeId) === me;
            const manages = isAdmin ? !isViewer : Number(r.subjectManagerId) === me;
            const supervises = isAdmin ? !isViewer : !mine;
            return {
                ...r,
                canDecide:
                    r.status === 'pending' &&
                    !mine &&
                    (r.targetState === 'approved' ? manages : supervises),
            };
        });
    }

    /**
     * Les demandes portées par UNE évaluation (les deux côtés voient la même chose).
     *
     * `user` est OBLIGATOIRE et la garde est ici, dans le service, pas seulement
     * sur la route : cette lecture a été livrée sans aucun contrôle, et
     * `GET /api/self-assessment/:id/change-requests` n'ayant qu'un `requireAuth`
     * avec un identifiant numérique énumérable, n'importe quel compte connecté
     * lisait le motif confidentiel, le demandeur et le décideur d'une demande
     * portée sur quelqu'un d'autre. Reproduit par design review QA (constat E-05) :
     * en session de l'employé 138, lecture d'une demande de l'employé 87, motif
     * en clair compris. Seul le jeu d'essai le masquait.
     *
     * Même règle que `create` : le sujet, son superviseur, son manager, ou un
     * administrateur dans son périmètre — personne d'autre.
     */
    async listForAssessment(selfAssessmentId, user) {
        const round = await this._round(selfAssessmentId);
        if (!round)
            throw refuse('Self-assessment not found', 'not_found', 404, {
                key: 'assess:acr_err_sa_not_found',
            });
        const auth = await WF._auth(user, round.employeeId);
        if (!auth.isSelf && !auth.canSupervise && !auth.canManage) {
            throw refuse(
                'Not authorized: the subject, their supervisor or their manager only',
                'forbidden',
                403,
                { key: 'assess:acr_err_not_authorized_subject' }
            );
        }
        return await db.all(
            `${this._selectList()} WHERE cr.self_assessment_id = ? ORDER BY cr.created_at DESC, cr.id DESC`,
            [selfAssessmentId]
        );
    }

    /**
     * CE QUE L'ON PEUT RÉELLEMENT DEMANDER — pour les DEUX rôles (E-02, M-01).
     *
     * L'écran construisait la liste de dépôt à partir des évaluations DU LECTEUR
     * (`WF.listForEmployee(req.user.id)`) : structurellement vide pour un
     * superviseur, qui recevait pourtant du produit l'ORDRE de « déposer une
     * demande de modification » sur le refus d'annulation. La capacité serveur
     * existait — `create` accepte un superviseur sur une évaluation VALIDÉE —
     * mais aucun écran ne la rendait.
     *
     * La liste est donc calculée avec LES MÊMES PRÉDICATS que `create` : rien
     * n'y est proposé que le serveur refusera, rien de ce qu'il accepte n'y
     * manque.
     *   `mine`   mes évaluations dans un état qui exige une demande ;
     *   `others` les évaluations VALIDÉES des personnes de mon périmètre (en deçà
     *            de la validation, le superviseur ANNULE directement — règle B).
     * Des deux côtés : un tour ENCORE COURANT (`self_assessments` ne garde que
     * `superseded_at IS NULL` ; un tour dépassé ne pourrait jamais être rendu à
     * la personne), aucune demande déjà ouverte, le délai A7 de 30 jours non
     * expiré, et une campagne ouverte à l'écriture.
     */
    async raisable(user) {
        const out = { mine: [], others: [] };
        if (!user || user.id == null) return out;
        const isAdmin = Boolean(user.userType === 'admin');
        const me = Number(user.id);
        const CycleService = require('./CycleService');
        const gates = new Map();
        const writable = async (cycleId) => {
            if (cycleId == null) return true; // A6 — hors campagne, toujours
            const k = String(cycleId);
            if (!gates.has(k)) {
                let ok = false;
                try {
                    ok = Boolean(
                        (await CycleService.cycleWriteGate(cycleId, { allowReview: false }))
                            .writable
                    );
                } catch (_) {
                    ok = false;
                } // campagne introuvable = pas de dépôt
                gates.set(k, ok);
            }
            return gates.get(k);
        };
        const openCycle = await db.get(
            "SELECT id, code FROM assessment_cycles WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
        );
        const fresh = (r) => {
            const d = this._decidedAt(r);
            return !d || Math.floor((Date.now() - d.getTime()) / 86400000) <= CONTEST_WINDOW_DAYS;
        };
        const cols = `r.id, r.employee_id AS "employeeId", r.skill_id AS "skillId",
                      r.workflow_state AS "workflowState", r.cycle_id AS "cycleId",
                      r.approved_at AS "approvedAt", r.reviewed_at AS "reviewedAt",
                      sk.name AS "skillName", e.first_name AS "firstName", e.last_name AS "lastName",
                      EXISTS (SELECT 1 FROM assessment_change_requests o
                               WHERE o.self_assessment_id = r.id AND o.status = 'pending') AS "hasOpenRequest"`;
        const from = `FROM self_assessment_rounds r
                      JOIN self_assessments sa ON sa.id = r.id
                      JOIN employees e ON e.id = r.employee_id
                      LEFT JOIN skills sk ON sk.id = r.skill_id`;

        if (!isAdmin) {
            const rows = await db.all(
                `SELECT ${cols} ${from} WHERE r.employee_id = ? AND r.workflow_state = ANY(?)
                  ORDER BY sk.name LIMIT 300`,
                [me, REQUEST_REQUIRED_STATES]
            );
            for (const r of rows) {
                if (r.hasOpenRequest || !fresh(r)) continue;
                // Une NOUVELLE campagne me redemande la ligne : j'y réponds
                // directement, `create` refuserait la demande.
                if (openCycle && String(r.cycleId) !== String(openCycle.id)) continue;
                if (!(await writable(r.cycleId))) continue;
                out.mine.push(r);
            }
        }
        const canDecide = Boolean(isAdmin || user.userType === 'manager');
        if (canDecide) {
            const RBACService = require('./RBACService');
            const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
            const params = [];
            let where = "r.workflow_state = 'approved'";
            if (!isAdmin) {
                where += ' AND r.employee_id <> ?';
                params.push(me);
            }
            where += sc.clause;
            params.push(...sc.params);
            const rows = await db.all(
                `SELECT ${cols} ${from} WHERE ${where} ORDER BY e.last_name, e.first_name, sk.name LIMIT 300`,
                params
            );
            for (const r of rows) {
                if (r.hasOpenRequest || !fresh(r)) continue;
                if (!(await writable(r.cycleId))) continue;
                out.others.push(r);
            }
        }
        return out;
    }

    /**
     * POURQUOI une demande de modification ne serait PAS recevable sur CETTE
     * ligne, aujourd'hui — lecture seule, aucune écriture, aucune exception.
     *
     * Constat M-01, second temps. Le produit refusait l'annulation d'une
     * évaluation validée par « déposez une demande de modification » AVANT toute
     * porte de campagne : sur le jeu du 15/09 c'était la SEULE phrase adressée à
     * un superviseur, et dans ce seul cas elle restait inexécutable — la demande
     * ordonnée repartait en 409 « La campagne 2026-Q3 est verrouillée ». Une
     * phrase qui ordonne une démarche doit tenir compte de ce qui l'empêche.
     *
     * Les trois portes reproduites ici sont EXACTEMENT celles de `create`, dans
     * son ordre — campagne, délai A7, demande déjà ouverte : ce sont les seules
     * qui peuvent refuser une demande de superviseur sur une évaluation VALIDÉE
     * (l'autorité, elle, a déjà été résolue par l'appelant). Rien n'est dupliqué
     * en règle : chaque porte est relue par `create` au dépôt.
     *
     * Rend `null` quand la demande est recevable, sinon `{ code, key, vars }` —
     * la clé du catalogue et ses variables, pour que le refus soit rédigé dans la
     * langue du lecteur par la même poignée que les autres (M-02).
     */
    async whyNotRaisable(selfAssessmentId, req = null) {
        const round = await this._round(selfAssessmentId);
        if (!round) return null; // pas notre sujet : l'appelant a déjà la ligne
        // 1. La campagne. La phrase de la porte est déjà rédigée et nomme la
        //    campagne et sa date ; elle est traduite ici (`req.t`), puis portée
        //    telle quelle dans la phrase composée.
        try {
            await WF._assertCycleWritable(round.cycleId, 'changes_requested', req);
        } catch (e) {
            if (!e || !e.gate) throw e; // une faute technique reste une faute
            return {
                code: e.gate.code || 'cycle_write_refused',
                key: 'assess:acr_err_cancel_approved_cycle',
                vars: { gate: String(e.message || '') },
            };
        }
        // 2. A7 — 30 jours pour contester une décision.
        try {
            this._assertWithinContestWindow(round);
        } catch (e) {
            if (!e || e.code !== 'contest_window_expired') throw e;
            return {
                code: e.code,
                key: 'assess:acr_err_cancel_approved_window',
                vars: (e.i18n && e.i18n.vars) || {},
            };
        }
        // 3. Une seule demande ouverte par ligne.
        const open = await db.get(
            "SELECT id FROM assessment_change_requests WHERE self_assessment_id = ? AND status = 'pending'",
            [selfAssessmentId]
        );
        if (open) {
            return {
                code: 'already_pending',
                key: 'assess:acr_err_cancel_approved_pending',
                vars: { requestId: Number(open.id) },
            };
        }
        return null;
    }

    // ---- notifications / audit -------------------------------------------

    async _notifyDeciders(round, request, auth) {
        try {
            const NotificationService = require('./NotificationService');
            const EmployeeModel = require('./../models/EmployeeModel');
            const employee = await EmployeeModel.findById(round.employeeId);
            // La demande de l'employé va à son superviseur (à défaut, son manager).
            // Celle d'un superviseur va au manager, seule autorité qui peut rouvrir
            // une évaluation validée.
            const target = auth.isSelf
                ? employee &&
                  (employee.supervisorId ||
                      (employee.managerType === 'employee' ? employee.managerId : null))
                : employee && employee.managerType === 'employee'
                  ? employee.managerId
                  : null;
            if (target) {
                await NotificationService.notify({
                    userType: 'employee',
                    userId: Number(target),
                    kind: 'sa.change_request_raised',
                    category: 'reviews',
                    payload: {
                        changeRequestId: Number(request.id),
                        skillId: round.skillId,
                        link: '/assessment-changes',
                    },
                }).catch(() => {});
            }
            // LE SUJET EST PRÉVENU AUSSI (constat E-02, second temps).
            //
            // Quand la demande n'est PAS la sienne — son superviseur demande la
            // réouverture de SON évaluation validée — la seule notification écrite
            // partait au décideur. Mesuré sur la demande #35 : une ligne, pour
            // l'employé 137 ; l'employé 138, SUJET de la demande, ne recevait rien
            // et ne l'apprenait qu'en ouvrant le menu de lui-même. Le référentiel
            // (§3 règle 5) veut la demande visible des DEUX côtés : la file du
            // décideur ne suffit pas, il faut la pousser à la personne concernée.
            //
            // `kind` distinct et non `sa.change_request_raised` : ce libellé-là dit
            // « attend VOTRE décision » — faux pour le sujet, qui ne décide rien.
            const subject = Number(round.employeeId);
            if (!auth.isSelf && Number.isFinite(subject) && subject > 0) {
                await NotificationService.notify({
                    userType: 'employee',
                    userId: subject,
                    kind: 'sa.change_request_raised_on_me',
                    category: 'reviews',
                    payload: {
                        changeRequestId: Number(request.id),
                        skillId: round.skillId,
                        link: '/assessment-changes',
                    },
                }).catch(() => {});
            }
        } catch (_) {
            /* une demande ne tombe jamais pour une notification */
        }
    }

    async _notifyRequester(cr, decision, why) {
        try {
            // `employee:<id>` → la personne ; `admin:<id>` → pas de boîte employé,
            // la file lui suffit.
            const m = /^employee:(\d+)$/.exec(String(cr.requesterRef || ''));
            if (!m) return;
            await require('./NotificationService')
                .notify({
                    userType: 'employee',
                    userId: Number(m[1]),
                    kind:
                        decision === 'granted'
                            ? 'sa.change_request_granted'
                            : 'sa.change_request_refused',
                    category: 'workflow',
                    payload: {
                        changeRequestId: Number(cr.id),
                        reason: why || null,
                        link: '/assessment-changes',
                    },
                })
                .catch(() => {});
        } catch (_) {
            /* idem */
        }
    }

    async _audit(req, action, entityId, details) {
        // SAVEPOINT + `actorRef` : même raison que `SelfAssessmentWorkflowService
        // ._audit` — un audit avalé ne doit jamais avorter la transaction de son
        // appelant, et `admin_id` ne peut pas porter l'identifiant d'un employé.
        try {
            await db.runInSavepoint(() =>
                LogService.log({
                    adminId: req && req.user ? req.user.id : null,
                    action,
                    entityType: 'selfAssessment',
                    entityId,
                    details,
                    actorRef:
                        req && req.user
                            ? `${req.user.userType === 'admin' ? 'admin' : 'employee'}:${req.user.id}`
                            : null,
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                })
            );
        } catch (_) {
            /* l'audit ne casse jamais la décision */
        }
    }
}

module.exports = new AssessmentChangeRequestService();
module.exports.CONTEST_WINDOW_DAYS = CONTEST_WINDOW_DAYS;
module.exports.REQUEST_REQUIRED_STATES = REQUEST_REQUIRED_STATES;
module.exports.EDITABLE_STATES = EDITABLE_STATES;
