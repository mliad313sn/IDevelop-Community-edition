'use strict';

/**
 * DSRService — GDPR data-subject rights. Export (portability/access) gathers all
 * personal data for one employee; erasure pseudonymizes PII in MUTABLE tables
 * while preserving the integrity of the append-only audit trail (which references
 * opaque ids, not names). Retention sweep honours per-country dsr_sla_days.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');

/**
 * RÉTENTION (S-07 ; lois 2008-12 Sénégal, 2013-450 Côte d'Ivoire, 2013-015 Mali,
 * L/2016/037 Guinée). Chaque catégorie a une période et une action ; la seule
 * catégorie planifiée par le produit est la personne PARTIE : LifecycleService
 * pose `pii_cleanup_jobs.due_at = départ + countries.dsr_sla_days` au départ, et
 * le job de rétention la pseudonymise à l'échéance par le MÊME chemin que
 * l'effacement RGPD (`erase`), jamais par une suppression du journal d'audit.
 */
const RETENTION_CATEGORIES = [
    {
        key: 'leaver_pii',
        subjectType: 'employee',
        period: 'countries.dsr_sla_days',
        action: 'pseudonymise',
    },
];
/** A claim older than this belongs to a dead process and may be taken again. */
const CLAIM_STALE_MINUTES = 60;
/** Bounded batch per run: a backlog drains over several runs, never in one lock. */
const RETENTION_BATCH = 200;

/**
 * Where the tombstones are mirrored OUTSIDE the database. A full pg_dump
 * restore rolls `erasure_tombstones` back with everything else, so the list of
 * erased subjects must also live beside the backups it protects against.
 * ERASURE_TOMBSTONE_FILE overrides; under jest nothing is written unless set.
 */
function tombstoneFile() {
    if (process.env.ERASURE_TOMBSTONE_FILE) return process.env.ERASURE_TOMBSTONE_FILE;
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return null;
    try {
        const dir = require('../jobs/db-backup').backupDir();
        let dbName = 'db';
        try {
            dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '') || 'db';
        } catch (_) {
            /* keep the generic name */
        }
        return path.join(dir, `erasure-tombstones-${dbName.replace(/[^\w.-]/g, '_')}.jsonl`);
    } catch (_) {
        return null;
    }
}

/** Run `fn` in a savepoint when the driver offers one (a failure never poisons the tx). */
function inSavepoint(fn) {
    return typeof db.runInSavepoint === 'function' ? db.runInSavepoint(fn) : fn();
}

/**
 * CE QUE L'EFFACEMENT TRAITE COMME DONNÉE PERSONNELLE, L'EXPORT DOIT LE RESTITUER.
 * Les deux listes sont LA MÊME LISTE.
 *
 * Le défaut mesuré : `erase` redactait comme données du sujet les commentaires
 * 9-box, les notes de coaching (agenda, objectif, GROW), la justification de
 * calibration, le texte libre d'enquête et les objectifs d'IDP — et `export`
 * n'en rendait AUCUN, ni les notes de revue, ni les litiges, ni l'historique de
 * cycle de vie. On ne peut pas tenir qu'une note est la donnée personnelle du
 * sujet pour la DÉTRUIRE et pas pour la LUI MONTRER.
 *
 * Chaque entrée porte la clé de l'export et la table que l'effacement touche ;
 * le test `uat3-lot24-*` épingle la correspondance dans les deux sens, de sorte
 * qu'une catégorie ajoutée d'un côté et oubliée de l'autre fait tomber la suite.
 *
 * ÉPINGLAGE À LA COLONNE. La correspondance
 * clé↔table ne voyait RIEN à l'intérieur d'une catégorie déjà déclarée : cinq
 * colonnes rendues par l'export restaient lisibles après l'effacement alors
 * qu'une AUTRE colonne de la MÊME ligne partait — `coaching_plans.title` et
 * `.expected_outcome` (`objective` passait à NULL), `nine_box_evaluations`
 * `.disclosure_reason` (comments/evidence/calibration_notes passaient à NULL),
 * `self_assessment_rounds.cancel_reason` (alors que le même appel met
 * `employees.cancel_reason` à '[erased]') — et une catégorie entière,
 * `retention_risk`, n'était déclarée nulle part. Chaque entrée porte donc
 * maintenant la CLASSIFICATION DE CHAQUE COLONNE que l'export rend :
 *   - `erased` : l'effacement la détruit ou la pseudonymise ;
 *   - `kept`   : elle est délibérément conservée (identifiant technique de
 *                ligne, structure de la décision, état, dates) ;
 *   - `deleted: true` : l'effacement SUPPRIME la ligne entière (tout part).
 * Le test lit la liste de colonnes de chaque SELECT d'export et exige que
 * chacune soit classée : une colonne ajoutée à l'export et oubliée par
 * l'effacement ne peut plus passer inaperçue.
 */
const REDACTED_ON_ERASURE = [
    // LE DOSSIER DE LA PERSONNE lui-même. `username`, `employee_number`,
    // `external_id` et `auth_provider` sont les identifiants directs que
    // l'effacement pseudonymise ou coupe ; le rattachement (rôle, site,
    // département, service) et l'identifiant de ligne restent, sans quoi la
    // ligne pseudonymisée ne serait plus rattachable à rien.
    {
        key: 'profile',
        table: 'employees',
        erased: [
            'employee_number',
            'username',
            'first_name',
            'last_name',
            'email',
            'phone',
            'external_id',
            'auth_provider',
            'cancel_reason',
            'is_active',
            'is_account_active',
            'erased_at',
        ],
        kept: ['id', 'role_id', 'site_id', 'department_id', 'service_id', 'cancelled_at'],
    },
    // A-04 — les quatre catégories que l'effacement DÉTRUISAIT sans
    // que l'export les rende jamais, mesurées sur le sujet 138 : `username`
    // ('uat.employee' en base, ABSENTE des 14 clés du profil exporté),
    // `user_identities` (l'export ne mentionnait pas la table : false),
    // `external_id`/`auth_provider` (absents du profil), et les recognitions
    // ÉMISES (l'export ne lisait que `to_employee_id` quand l'effacement supprime
    // `to OR from`). Cinquième trou trouvé en instrumentant erase : les comptes
    // d'administration LIÉS, dont le code pseudonymise nommément le login et
    // l'adresse — « employee_number and username are DIRECT identifiers ».
    {
        key: 'userIdentities',
        table: 'user_identities',
        deleted: true,
        erased: ['id', 'sso_provider', 'sso_uid', 'email', 'is_primary', 'linked_at'],
        kept: [],
    },
    // SSO-migration mappings (migration 144) carry the person's directory
    // identifiers — objectId, UPN, employeeId — whether still open or bound.
    {
        key: 'ssoMappings',
        table: 'sso_pending_links',
        deleted: true,
        erased: [
            'id',
            'provider',
            'match_object_id',
            'match_upn',
            'match_employee_id',
            'status',
            'bound_uid',
            'created_at',
            'bound_at',
        ],
        kept: [],
    },
    // The dry-run/apply history keeps the uploaded directory line (UPN, mail,
    // display name) of each row matched to the subject: the line is redacted,
    // the outcome kept so a batch's counts still add up.
    {
        key: 'ssoMigrationRows',
        table: 'sso_remap_rows',
        erased: ['input'],
        kept: ['id', 'batch_id', 'row_no', 'match_key', 'outcome'],
    },
    {
        key: 'linkedAdminAccounts',
        table: 'admins',
        erased: ['username', 'email', 'external_id', 'auth_provider', 'is_active'],
        kept: ['id', 'role', 'created_at'],
    },
    {
        key: 'selfAssessments',
        table: 'self_assessment_rounds',
        // `cancel_reason` REJOINT les deux autres textes libres (résidu A-04) :
        // c'est le motif qu'un opérateur a écrit SUR le tour du sujet, et le
        // même appel met déjà `employees.cancel_reason` à '[erased]'.
        erased: ['notes', 'justification', 'cancel_reason'],
        kept: [
            'id',
            'skill_id',
            'round_no',
            'self_rated_level',
            'status',
            'workflow_state',
            'cycle_id',
            'created_at',
            'submitted_at',
            'approved_at',
            'approved_by_ref',
            'cancelled_at',
        ],
    },
    {
        key: 'skillAssessments',
        table: 'skill_assessments',
        erased: ['notes'],
        kept: ['skill_id', 'current_level', 'assessed_at'],
    },
    {
        key: 'nineBox',
        table: 'nine_box_evaluations',
        // `disclosure_reason` REJOINT comments/evidence/calibration_notes
        // (résidu A-04) : c'est le motif écrit par un tiers pour divulguer la
        // case au sujet, du texte libre sur la personne comme les trois autres.
        erased: ['comments', 'evidence', 'calibration_notes', 'disclosure_reason'],
        kept: [
            'id',
            'performance',
            'potential',
            'box',
            'box_label',
            'status',
            'disclosed_to_employee',
            'disclosed_at',
            'created_at',
        ],
    },
    {
        key: 'calibrationAdjustments',
        table: 'calibration_adjustments',
        erased: ['rationale'],
        kept: ['id', 'created_at'],
    },
    {
        key: 'coachingSessions',
        table: 'coaching_sessions',
        erased: ['agenda'],
        kept: ['id', 'created_at'],
    },
    {
        key: 'coachingPlans',
        table: 'coaching_plans',
        // `title` et `expected_outcome` REJOIGNENT `objective` (résidu A-04) :
        // ce sont les deux autres champs narratifs de la MÊME ligne, saisis par
        // le même coach sur la même personne ('Coaching to support PIP',
        // 'Gap closed; evidence attached.'). `title` est NOT NULL → marqueur.
        erased: ['title', 'objective', 'expected_outcome'],
        kept: ['id', 'state', 'created_at'],
    },
    {
        key: 'coachingGrow',
        table: 'coaching_grow',
        erased: ['goal', 'reality', 'options', 'way_forward'],
        kept: ['session_id'],
    },
    {
        key: 'idpObjectives',
        table: 'idp_objectives',
        erased: ['smart_text'],
        kept: ['id', 'idp_id'],
    },
    { key: 'pips', table: 'pips', erased: ['summary', 'outcome'], kept: ['id', 'state'] },
    {
        key: 'goals',
        table: 'goals',
        erased: ['title', 'description'],
        kept: ['id', 'status', 'current_value', 'target_value'],
    },
    {
        key: 'checkins',
        table: 'check_ins',
        erased: ['title', 'shared_notes'],
        kept: ['id', 'kind', 'created_at'],
    },
    {
        key: 'surveyResponses',
        table: 'survey_responses',
        erased: ['text_answer'],
        kept: ['id', 'created_at'],
    },
    {
        key: 'recognitions',
        table: 'recognitions',
        deleted: true,
        erased: ['id', 'value_tag', 'message', 'created_at'],
        kept: [],
    },
    {
        key: 'demographics',
        table: 'employee_demographics',
        deleted: true,
        erased: ['gender', 'ethnicity', 'age_band', 'disability', 'nationality'],
        kept: [],
    },
    // RISQUE DE PERTE (résidu A-04). L'export rendait `retentionRisk` sans que
    // la clé figure dans AUCUNE des deux listes, et l'effacement ne touchait
    // jamais la table : la bande de risque de départ, l'impact de perte, le
    // score et les facteurs — dont une COPIE de la case 9-box confidentielle du
    // sujet, que `RetentionRiskService` range dans `risk_factors.nineBox` —
    // restaient lisibles à vie. C'est un jugement PROFILÉ sur la personne, pas
    // une décision gouvernée : la ligne ne porte ni état, ni approbateur, ni
    // dates de décision, rien ne la référence (0 clé étrangère, 0 déclencheur),
    // elle est clé-unique par employé et le recalcul nocturne ne balaie que les
    // employés ACTIFS — après un effacement elle ne serait plus jamais
    // rafraîchie, juste un verdict figé sur quelqu'un qui a demandé l'oubli.
    // L'effacement SUPPRIME donc la ligne entière, comme la démographie.
    {
        key: 'retentionRisk',
        table: 'retention_risk',
        deleted: true,
        erased: ['flight_risk', 'impact_of_loss', 'risk_factors', 'computed_score'],
        kept: [],
    },
    // ASYMÉTRIE INVERSE TRANCHÉE :
    // l'export rendait ces trois catégories et l'effacement n'y touchait PAS.
    // Décision : une note de revue NOMINATIVE est une donnée personnelle du
    // sujet, au même titre que le commentaire 9-box, la justification de
    // calibration, le résumé de PIP et la réponse d'enquête — que ce service
    // redacte déjà. Laisser « ce que le superviseur a écrit sur Untel » lisible
    // à vie après un effacement serait le SEUL endroit du produit où les deux
    // définitions de « donnée personnelle » divergent. Ce qui est redacté est le
    // TEXTE LIBRE seul ; la structure de la décision (niveaux, écart, état,
    // auteur, dates) reste intacte, donc aucune machine à états, aucune
    // contrainte de validation nommée et aucun journal en ajout seul n'est
    // touché. Voir `erase` pour les colonnes exactes et le traitement des
    // colonnes NOT NULL.
    {
        key: 'supervisorReviews',
        table: 'supervisor_reviews',
        erased: ['supervisor_notes', 'gap_reason'],
        kept: [
            'self_assessment_id',
            'skill_id',
            'supervisor_rated_level',
            'gap',
            'decision',
            'status',
            'reviewed_at',
            'decided_at',
        ],
    },
    {
        key: 'disputes',
        table: 'assessment_disputes',
        erased: ['reason'],
        kept: [
            'id',
            'supervisor_review_id',
            'level',
            'state',
            'final_level',
            'decided_rating',
            'opened_at',
            'escalated_at',
            'resolved_at',
        ],
    },
    {
        key: 'changeRequests',
        table: 'assessment_change_requests',
        erased: ['reason', 'decision_reason'],
        kept: [
            'id',
            'self_assessment_id',
            'requester_ref',
            'requester_role',
            'target_state',
            'status',
            'decided_by_ref',
            'decided_at',
            'created_at',
        ],
    },
];

/**
 * Ce qui est ÉCRIT SUR la personne et qu'elle doit pouvoir lire, même si
 * l'effacement ne le detruit pas : son histoire dans l'organisation.
 * L'événement de cycle de vie (arrivée, mutation, départ, motif) est le registre
 * de la RELATION D'EMPLOI, pas une appréciation sur la personne : il porte sa
 * propre rétention légale et l'effacement l'écrit lui-même (il pose le motif sur
 * la ligne 'leaver' qu'il crée). Nommé ici pour que son oubli fasse tomber un test.
 * Une entrée ici ne porte QUE des colonnes `kept` : déclarer une catégorie
 * conservée, c'est affirmer qu'aucune de ses colonnes n'est du texte libre écrit
 * sur la personne — le test le vérifie.
 */
const DISCLOSED_ABOUT_SUBJECT = [
    {
        key: 'lifecycleEvents',
        table: 'lifecycle_events',
        kept: [
            'id',
            'kind',
            'reason',
            'decision',
            'occurred_at',
            'effective_at',
            'reverted_at',
            'revert_note',
        ],
    },
    // LE PLAN D'IDP (résidu A-04 : la clé `idp` n'était déclarée nulle part).
    // L'export n'en rend que l'ÉTAT et la PRIORITÉ — aucune narration : tout le
    // texte du plan est dans `idp_objectives.smart_text`, que l'effacement
    // redacte et qui est déclaré ci-dessus. L'en-tête du plan est la structure
    // du dossier de développement, pas une appréciation sur la personne.
    { key: 'idp', table: 'idp_plans', kept: ['id', 'status', 'priority'] },
];

class DSRService {
    /** Ce que l'effacement redacte — l'export DOIT rendre chacune de ces catégories. */
    static get REDACTED_ON_ERASURE() {
        return REDACTED_ON_ERASURE;
    }
    /** Ce qui est écrit sur la personne et que l'export doit rendre aussi. */
    static get DISCLOSED_ABOUT_SUBJECT() {
        return DISCLOSED_ABOUT_SUBJECT;
    }

    /** Full personal-data export for a subject (access / portability). */
    async export(employeeId) {
        const out = { employeeId: Number(employeeId), generatedAt: new Date().toISOString() };
        const q = async (label, sql, params) => {
            try {
                out[label] = await db.all(sql, params);
            } catch (e) {
                out[label] = { error: e.message };
            }
        };
        // Record state travels with the data: a subject (or a reader of the
        // export) must be able to tell a LEAVER (is_active=false, cancelled_at
        // NULL) from a record VOIDED as created-in-error (cancelled_at +
        // cancel_reason, MaintenanceService) and from an ERASED one (erased_at).
        // A-04 : `username`, `external_id` et `auth_provider` sont détruits par
        // l'effacement (`username` y est explicitement appelé « DIRECT
        // identifier ») — ils doivent donc figurer ici. `is_account_active` suit,
        // parce que l'effacement le coupe aussi et que le sujet doit pouvoir lire
        // l'état de son compte. `password_hash` reste VOLONTAIREMENT hors export :
        // un secret d'authentification n'est pas une donnée à restituer, et le
        // divulguer serait une faille, pas une conformité.
        out.profile = await db
            .get(
                `SELECT id, employee_number, username, first_name, last_name, email, phone, role_id, site_id, department_id, service_id,
                    external_id, auth_provider, is_active, is_account_active, cancelled_at, cancel_reason, erased_at
             FROM employees WHERE id = ?`,
                [employeeId]
            )
            .catch(() => null);
        // IDENTITÉS EXTERNES — l'effacement les SUPPRIME (« user_identities holds
        // the subject's email + IdP subject — direct identifiers ») ; l'export ne
        // les mentionnait pas une seule fois. Le `sso_uid` est l'identifiant que
        // le fournisseur d'identité porte sur la personne : il est à elle.
        await q(
            'userIdentities',
            `SELECT id, sso_provider, sso_uid, email, is_primary, linked_at
               FROM user_identities WHERE subject_type = 'employee' AND subject_id = ? ORDER BY id`,
            [employeeId]
        );
        await q(
            'ssoMappings',
            `SELECT id, provider, match_object_id, match_upn, match_employee_id, status, bound_uid, created_at, bound_at
               FROM sso_pending_links WHERE employee_id = ? ORDER BY id`,
            [employeeId]
        );
        await q(
            'ssoMigrationRows',
            `SELECT id, batch_id, row_no, input, match_key, outcome
               FROM sso_remap_rows WHERE employee_id = ? ORDER BY id`,
            [employeeId]
        );
        // COMPTES D'ADMINISTRATION LIÉS — l'effacement pseudonymise leur login et
        // leur adresse et supprime leurs identités externes : ce sont les mêmes
        // identifiants directs, sur un autre compte de la même personne.
        await q(
            'linkedAdminAccounts',
            `SELECT a.id, a.username, a.email, a.role, a.external_id, a.auth_provider, a.is_active, a.created_at,
                    (SELECT COUNT(*) FROM user_identities ui
                      WHERE ui.subject_type = 'admin' AND ui.subject_id = a.id) AS identity_count
               FROM admins a WHERE a.linked_employee_id = ? ORDER BY a.id`,
            [employeeId]
        );
        await q(
            'skillAssessments',
            'SELECT skill_id, current_level, assessed_at, notes FROM skill_assessments WHERE employee_id = ?',
            [employeeId]
        );
        // EVERY ROUND, not only the current one. `self_assessments` is the view of
        // the current measurement (migration 113); a subject's own earlier answers
        // and justifications are theirs too, and the erase below reaches them.
        await q(
            'selfAssessments',
            `SELECT id, skill_id, round_no, self_rated_level, status, workflow_state, cycle_id,
                    notes, justification, created_at, submitted_at, approved_at, approved_by_ref,
                    cancelled_at, cancel_reason
               FROM self_assessment_rounds WHERE employee_id = ? ORDER BY skill_id, round_no`,
            [employeeId]
        );
        // NOTES DE REVUE — what the reviewer wrote about the person: the retained
        // level, the gap, the reason for a divergence and the free-text notes.
        await q(
            'supervisorReviews',
            `SELECT sr.self_assessment_id, sr.skill_id, sr.supervisor_rated_level, sr.gap, sr.gap_reason,
                    sr.supervisor_notes, sr.decision, sr.status, sr.reviewed_at, sr.decided_at
               FROM supervisor_reviews sr WHERE sr.employee_id = ?`,
            [employeeId]
        );
        // LITIGES — the person's own contestations and how they were decided.
        await q(
            'disputes',
            `SELECT id, supervisor_review_id, level, state, reason, final_level, decided_rating,
                    opened_at, escalated_at, resolved_at
               FROM assessment_disputes WHERE employee_id = ?`,
            [employeeId]
        );
        await q(
            'changeRequests',
            `SELECT id, self_assessment_id, requester_ref, requester_role, reason, target_state, status,
                    decided_by_ref, decided_at, decision_reason, created_at
               FROM assessment_change_requests WHERE employee_id = ?`,
            [employeeId]
        );
        // COMMENTAIRES 9-BOX + JUSTIFICATION DE CALIBRATION — written opinions
        // about the person. Erasure redacts them, so the export must return them.
        await q(
            'nineBox',
            `SELECT id, performance, potential, box, box_label, comments, evidence,
                    calibration_notes, status, disclosed_to_employee, disclosed_at, disclosure_reason,
                    created_at
               FROM nine_box_evaluations WHERE employee_id = ?`,
            [employeeId]
        );
        await q(
            'calibrationAdjustments',
            'SELECT id, rationale, created_at FROM calibration_adjustments WHERE employee_id = ?',
            [employeeId]
        );
        // NOTES DE COACHING — agenda, objectif du plan, et le GROW.
        await q(
            'coachingSessions',
            'SELECT id, agenda, created_at FROM coaching_sessions WHERE employee_id = ?',
            [employeeId]
        );
        await q(
            'coachingPlans',
            'SELECT id, title, objective, expected_outcome, state, created_at FROM coaching_plans WHERE employee_id = ?',
            [employeeId]
        );
        await q(
            'coachingGrow',
            `SELECT g.session_id, g.goal, g.reality, g.options, g.way_forward
               FROM coaching_grow g
               JOIN coaching_sessions s ON s.id = g.session_id
              WHERE s.employee_id = ?`,
            [employeeId]
        );
        await q(
            'goals',
            'SELECT id, title, description, status, current_value, target_value FROM goals WHERE employee_id = ?',
            [employeeId]
        );
        await q(
            'checkins',
            'SELECT id, kind, title, shared_notes, created_at FROM check_ins WHERE employee_id = ?',
            [employeeId]
        );
        await q('idp', 'SELECT id, status, priority FROM idp_plans WHERE employee_id = ?', [
            employeeId,
        ]);
        await q(
            'idpObjectives',
            `SELECT o.id, o.idp_id, o.smart_text
               FROM idp_objectives o
               JOIN idp_plans p ON p.id = o.idp_id
              WHERE p.employee_id = ?`,
            [employeeId]
        );
        await q('pips', 'SELECT id, state, summary, outcome FROM pips WHERE employee_id = ?', [
            employeeId,
        ]);
        await q(
            'surveyResponses',
            'SELECT id, text_answer, created_at FROM survey_responses WHERE employee_id = ?',
            [employeeId]
        );
        // RECONNAISSANCES REÇUES **ET ÉMISES** — l'effacement supprime
        // `to_employee_id = ? OR from_employee_id = ?` ; l'export ne rendait que
        // les reçues, donc un message écrit PAR la personne disparaissait sans
        // lui avoir jamais été restitué. `direction` distingue les deux sens.
        await q(
            'recognitions',
            `SELECT id, value_tag, message, created_at,
                    CASE WHEN to_employee_id = ? THEN 'received' ELSE 'sent' END AS direction
               FROM recognitions WHERE to_employee_id = ? OR from_employee_id = ? ORDER BY id`,
            [employeeId, employeeId, employeeId]
        );
        await q(
            'demographics',
            'SELECT gender, ethnicity, age_band, disability, nationality FROM employee_demographics WHERE employee_id = ?',
            [employeeId]
        );
        // HISTORIQUE DE CYCLE DE VIE — arrivée, mutation, départ, avec leurs motifs.
        await q(
            'lifecycleEvents',
            `SELECT id, kind, reason, decision, occurred_at, effective_at, reverted_at, revert_note
               FROM lifecycle_events WHERE employee_id = ? ORDER BY id`,
            [employeeId]
        );
        await q(
            'retentionRisk',
            'SELECT flight_risk, impact_of_loss, risk_factors, computed_score FROM retention_risk WHERE employee_id = ?',
            [employeeId]
        );
        return out;
    }

    /**
     * Erase a subject: pseudonymize identifying fields in mutable tables and drop
     * special-category data, keeping the append-only audit chain intact (it
     * references ids, not names). Returns a summary. Irreversible.
     */
    async erase(
        employeeId,
        actorAdminId = null,
        { reason = null, method = 'dsr_erase', reapply = false } = {}
    ) {
        const emp = await db.get(
            'SELECT id, is_active, email, employee_number FROM employees WHERE id = ?',
            [employeeId]
        );
        if (!emp) throw new Error(`Employee ${employeeId} not found`);
        // Read BEFORE the pseudonymisation below: the SSO-migration history is
        // searched with the real identifiers.
        const origEmail = String(emp.email || '')
            .trim()
            .toLowerCase();
        const origNumber = String(emp.employeeNumber ?? emp.employee_number ?? '')
            .trim()
            .toLowerCase();
        const out = await db.runTransaction(async () => {
            const tag = `erased-${employeeId}`;
            // erasure is at least the LEAVER cascade. A subject
            // still active goes through deprovision first — sessions (both
            // buckets), linked admin accounts, their API keys and sessions, the
            // PII job — the very cascade a departure runs, recorded as a leaver
            // event with the reason. A subject already departed is left as is
            // (a second leaver row would be a lie).
            // A RE-APPLICATION after a restore is not a departure either: the
            // person left and was erased before; the restore only brought back
            // stale rows. Recording a new leaver event dated today would be a lie
            // too — the switch-off, sessions and linked accounts are handled below.
            if (emp.isActive && !reapply) {
                await require('./LifecycleService').deprovision(Number(employeeId), {
                    source: 'dsr_erase',
                    actorRef: actorAdminId ? `admin:${actorAdminId}` : null,
                });
                if (reason)
                    await db.run(
                        "UPDATE lifecycle_events SET reason = ? WHERE id = (SELECT MAX(id) FROM lifecycle_events WHERE employee_id = ? AND kind = 'leaver')",
                        [reason, employeeId]
                    );
            }
            // The linked ADMIN account(s) of a promoted subject carried the real
            // username / e-mail after erasure (reproduced: admins.username kept).
            // Pseudonymise them to the same opaque tag, switch them off, revoke
            // every key and session, and drop their SSO identities. The rows stay
            // (system_logs references them; audit tables are append-only).
            const linked = await db.all('SELECT id FROM admins WHERE linked_employee_id = ?', [
                employeeId,
            ]);
            for (const a of linked) {
                const aid = Number(a.id);
                await db.run(
                    `UPDATE admins SET username = ?, email = ?, is_active = false, external_id = NULL, auth_provider = NULL
                      WHERE id = ?`,
                    [`${tag}-a${aid}`, `${tag}-a${aid}@erased.local`, aid]
                );
                try {
                    await require('./ApiKeyService').revokeByOwner(aid);
                } catch (_) {
                    /* best-effort */
                }
                try {
                    await require('./SessionService').revokeAllForUser(aid, 'admin');
                } catch (_) {
                    /* best-effort */
                }
                await db.run(
                    "DELETE FROM user_identities WHERE subject_type = 'admin' AND subject_id = ?",
                    [aid]
                );
            }
            // The retention job has nothing left to do once the subject is erased.
            await db.run(
                "UPDATE pii_cleanup_jobs SET completed_at = now(), notes = COALESCE(notes, '') || ' erased' WHERE employee_id = ? AND completed_at IS NULL",
                [employeeId]
            );
            // employee_number and username are DIRECT identifiers (the payroll
            // number and the login the person typed every day) and cancel_reason
            // is operator free text about the subject — all three survived the
            // first version of this UPDATE (reproduced: employee_number
            // 'EMP-1781607788701', username 'btoure', cancel_reason 'operator
            // free text about Jean' still readable after erase). Pseudonymise
            // both identifiers to the same opaque tag and drop the narrative.
            // cancel_reason is CHECK-constrained to be non-empty whenever
            // cancelled_at is set, so a voided-then-erased record keeps a
            // placeholder rather than the text. erased_at is the irreversible
            // stamp every reactivation path refuses (migration 104).
            await db.run(
                `UPDATE employees SET first_name = 'Erased', last_name = ?, email = ?, phone = NULL,
                   employee_number = ?, username = ?,
                   cancel_reason = CASE WHEN cancelled_at IS NULL THEN NULL ELSE '[erased]' END,
                   erased_at = COALESCE(erased_at, now()),
                   is_active = false, is_account_active = false
                 WHERE id = ?`,
                [String(employeeId), `${tag}@erased.local`, tag, tag, employeeId]
            );
            await db.run('DELETE FROM employee_demographics WHERE employee_id = ?', [employeeId]);
            // Identity erasure (Art. 17): user_identities holds the subject's email +
            // IdP subject (sso_uid) — direct identifiers, and a live sso_uid could
            // otherwise re-associate a future SSO login to the "erased" account. Also
            // clear the inline external_id/auth_provider and re-enable a (now useless)
            // local password field so no dangling identity linkage survives.
            await db.run(
                "DELETE FROM user_identities WHERE subject_type = 'employee' AND subject_id = ?",
                [employeeId]
            );
            // Same for an SSO-migration mapping: an open one could still be claimed
            // by a sign-in and re-attach the erased account.
            await db.run('DELETE FROM sso_pending_links WHERE employee_id = ?', [employeeId]);
            // …including the lines the matcher could NOT attach to anyone
            // (no match, ambiguous) that still carry this person's address or number.
            await db.run(
                `UPDATE sso_remap_rows SET input = '{}'::jsonb
                  WHERE employee_id = ?
                     OR (employee_id IS NULL AND (
                            (? <> '' AND (lower(input->>'mail') = ? OR lower(input->>'upn') = ?))
                         OR (? <> '' AND lower(input->>'employeeId') = ?)))`,
                [employeeId, origEmail, origEmail, origEmail, origNumber, origNumber]
            );
            await db.run(
                'UPDATE employees SET external_id = NULL, auth_provider = NULL, password_hash = NULL, password_disabled = false WHERE id = ?',
                [employeeId]
            );
            // Redact free-text personal data in mutable operational tables (the
            // subject's row is already pseudonymized; this removes the remaining
            // identifying/sensitive narrative). Only confirmed columns, so none of
            // these can abort the transaction.
            await db.run(
                "UPDATE check_ins SET title = '[erased]', shared_notes = NULL WHERE employee_id = ?",
                [employeeId]
            );
            await db.run('UPDATE skill_assessments SET notes = NULL WHERE employee_id = ?', [
                employeeId,
            ]);
            // EVERY ROUND. `self_assessments` is the CURRENT-round view since
            // migration 113, so this statement used to leave the person's earlier
            // answers and justifications readable after an erasure — the base
            // table is the only thing that reaches all of them.
            // `cancel_reason` (résidu A-04) : le motif d'annulation d'un tour est
            // du texte libre d'opérateur SUR le sujet — exactement ce que la même
            // transaction efface déjà sur `employees.cancel_reason`. La contrainte
            // chk_sa_cancel_reasoned exige un motif NON VIDE dès que `cancelled_at`
            // est posé : marqueur sur une ligne annulée, NULL sinon — jamais un
            // NULL qui ferait avorter l'effacement.
            await db.run(
                "UPDATE self_assessment_rounds SET notes = NULL, justification = NULL, cancel_reason = CASE WHEN cancelled_at IS NULL THEN NULL ELSE '[erased]' END WHERE employee_id = ?",
                [employeeId]
            );
            await db.run(
                "UPDATE goals SET title = '[erased]', description = NULL WHERE employee_id = ?",
                [employeeId]
            );
            await db.run(
                "UPDATE idp_objectives SET smart_text = '[erased]' WHERE idp_id IN (SELECT id FROM idp_plans WHERE employee_id = ?)",
                [employeeId]
            );
            await db.run(
                "UPDATE pips SET summary = '[erased]', outcome = NULL WHERE employee_id = ?",
                [employeeId]
            );
            await db.run('UPDATE survey_responses SET text_answer = NULL WHERE employee_id = ?', [
                employeeId,
            ]);
            await db.run(
                'DELETE FROM recognitions WHERE to_employee_id = ? OR from_employee_id = ?',
                [employeeId, employeeId]
            );
            // Coaching free-text narrative (agenda, plan objective, and the GROW notes)
            // is sensitive PII too — redact it under erasure. Columns confirmed present.
            await db.run('UPDATE coaching_sessions SET agenda = NULL WHERE employee_id = ?', [
                employeeId,
            ]);
            // `title` et `expected_outcome` (résidu A-04) : les deux autres champs
            // narratifs de la MÊME ligne ('Coaching to support PIP', 'Gap closed;
            // evidence attached.'), que l'export rend et que l'effacement laissait
            // lisibles alors qu'`objective`, saisi au même endroit par la même
            // personne sur le même sujet, partait. `title` est NOT NULL → marqueur.
            await db.run(
                "UPDATE coaching_plans SET title = '[erased]', objective = NULL, expected_outcome = NULL WHERE employee_id = ?",
                [employeeId]
            );
            await db.run(
                'UPDATE coaching_grow SET goal = NULL, reality = NULL, options = NULL, way_forward = NULL WHERE session_id IN (SELECT id FROM coaching_sessions WHERE employee_id = ?)',
                [employeeId]
            );
            // 9-box and calibration free-text commentary about the subject is sensitive
            // performance PII too. (rationale is NOT NULL, so redact rather than null it.)
            // `disclosure_reason` (résidu A-04) : le motif écrit pour divulguer la
            // case au sujet est du texte libre sur la personne comme les trois
            // autres colonnes de la même ligne. La contrainte
            // chk_ninebox_disclosure_complete exige un motif NON VIDE dès que
            // `disclosed_to_employee` est vrai → marqueur quand il y en avait un,
            // NULL quand il n'y en avait pas ; jamais un NULL qui ferait avorter.
            await db.run(
                "UPDATE nine_box_evaluations SET comments = NULL, evidence = NULL, calibration_notes = NULL, disclosure_reason = CASE WHEN disclosure_reason IS NULL THEN NULL ELSE '[erased]' END WHERE employee_id = ?",
                [employeeId]
            );
            await db.run(
                "UPDATE calibration_adjustments SET rationale = '[erased]' WHERE employee_id = ?",
                [employeeId]
            );
            // RISQUE DE PERTE (résidu A-04) : la ligne entière part. Voir la note
            // sur `retentionRisk` en tête de fichier — jugement profilé sur la
            // personne, aucune référence entrante, jamais recalculé après le
            // départ. Supprimée comme la démographie, et pour la même raison.
            await db.run('DELETE FROM retention_risk WHERE employee_id = ?', [employeeId]);
            // A-04, asymétrie inverse TRANCHÉE : ce que l'export restitue déjà et
            // que l'effacement laissait intact — le texte libre écrit SUR la
            // personne, ou PAR elle, dans la revue, le litige et la demande de
            // modification. Une note de revue nominative est sa donnée personnelle
            // exactement comme un commentaire 9-box. On ne touche QUE le texte :
            // niveaux, écart, état, décideur et dates restent, donc la décision
            // reste lisible et vérifiable. Les colonnes NOT NULL / CHECK non vides
            // (`assessment_disputes.reason`, `assessment_change_requests.reason`,
            // et `decision_reason` sur un refus) reçoivent '[erased]' — jamais un
            // NULL qui ferait échouer la transaction d'effacement.
            // Bornage : `employee_id = ?` seulement. Les lignes où le sujet n'est
            // que DEMANDEUR ou DÉCIDEUR du dossier d'autrui ne sont pas touchées —
            // les effacer détruirait le motif du dossier d'une AUTRE personne ;
            // son identité y reste une référence opaque (`employee:<id>`), comme
            // dans le journal d'audit.
            await db.run(
                'UPDATE supervisor_reviews SET supervisor_notes = NULL, gap_reason = NULL WHERE employee_id = ?',
                [employeeId]
            );
            await db.run(
                "UPDATE assessment_disputes SET reason = '[erased]' WHERE employee_id = ?",
                [employeeId]
            );
            await db.run(
                `UPDATE assessment_change_requests
                             SET reason = '[erased]',
                                 decision_reason = CASE WHEN decision_reason IS NULL THEN NULL ELSE '[erased]' END
                           WHERE employee_id = ?`,
                [employeeId]
            );
            // Terminate any live session for the erased subject so an open browser
            // can't keep an authenticated view onto the now-anonymized record. The
            // deserialize gate (is_active/is_account_active=false) is the backstop;
            // this makes it immediate. Runs inside the tx so it rolls back with it.
            try {
                const SessionService = require('./SessionService');
                await SessionService.revokeAllForUser(employeeId, 'employee');
                await SessionService.revokeAllForUser(employeeId, 'manager');
            } catch (_) {
                /* best-effort; deserialize gate backstops it */
            }
            // THE TOMBSTONE (S-07): the erasure outlives any backup restored
            // later. No FK to employees, so a snapshot restore's wipe keeps it;
            // a re-application only stamps `last_reapplied_at`.
            await this._writeTombstoneRow('employee', employeeId, method, reapply);
            // Record the erasure itself in the audit trail.
            try {
                await require('./LogService').log({
                    adminId: actorAdminId,
                    action: reapply ? 'GDPR_ERASURE_REAPPLIED' : 'GDPR_ERASURE',
                    entityType: 'employee',
                    entityId: employeeId,
                    details:
                        `Subject ${employeeId} pseudonymized under right-to-erasure` +
                        ` (method: ${method}${reapply ? ', re-applied after a restore' : ''})` +
                        (linked.length
                            ? `; ${linked.length} linked admin account(s) pseudonymised and switched off`
                            : '') +
                        (reason ? ` — reason: ${reason}` : ''),
                    severity: 'warning',
                    category: 'maintenance',
                    actorRef: actorAdminId ? `admin:${actorAdminId}` : null,
                });
            } catch (_) {
                /* best-effort */
            }
            return {
                erased: true,
                employeeId: Number(employeeId),
                linkedAdminsErased: linked.length,
            };
        });
        // Mirror outside the database, once the transaction has committed.
        if (!reapply) this._appendTombstoneFile('employee', employeeId, method);
        return out;
    }

    // ===================== Erasure tombstones (S-07) ==========================

    /** Insert (or re-stamp) the tombstone row. Never aborts the erasure. */
    async _writeTombstoneRow(subjectType, subjectId, method, reapply = false) {
        try {
            await inSavepoint(() =>
                db.run(
                    `INSERT INTO erasure_tombstones (subject_type, subject_id, method)
                     VALUES (?, ?, ?)
                     ON CONFLICT (subject_type, subject_id) DO UPDATE
                        SET last_reapplied_at = CASE WHEN ? THEN now()
                                                     ELSE erasure_tombstones.last_reapplied_at END`,
                    [subjectType, Number(subjectId), String(method), Boolean(reapply)]
                )
            );
            return true;
        } catch (e) {
            // Table absent (migration 151 not applied): the erasure itself still
            // stands — refusing a legally due erasure over its receipt would be worse.
            console.error('[dsr] erasure tombstone NOT written for', subjectId, e && e.message);
            return false;
        }
    }

    /** Append one line to the out-of-database tombstone mirror. Best-effort. */
    _appendTombstoneFile(subjectType, subjectId, method) {
        const file = tombstoneFile();
        if (!file) return false;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(
                file,
                JSON.stringify({
                    subjectType,
                    subjectId: Number(subjectId),
                    erasedAt: new Date().toISOString(),
                    method,
                }) + '\n'
            );
            return true;
        } catch (e) {
            console.error('[dsr] tombstone mirror NOT written:', e && e.message);
            return false;
        }
    }

    /** Parse the mirror file (unknown / malformed lines are skipped). */
    readTombstoneFile(file = tombstoneFile()) {
        if (!file) return [];
        let raw = '';
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (_) {
            return [];
        }
        const out = [];
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const t = JSON.parse(line);
                const id = Number(t.subjectId);
                if (t.subjectType === 'employee' && Number.isInteger(id) && id > 0)
                    out.push({
                        subjectType: 'employee',
                        subjectId: id,
                        erasedAt: t.erasedAt || null,
                        method: String(t.method || 'dsr_erase'),
                    });
            } catch (_) {
                /* skip a torn line */
            }
        }
        return out;
    }

    /**
     * RE-APPLY every erasure after a restore (snapshot, pg_restore, Manage
     * -Restore). A restored backup taken BEFORE an erasure brings the person's
     * data back; the tombstone says it must not stay. Each subject whose row
     * exists again with `erased_at` empty goes through erase once more, in
     * its own savepoint. Tombstones only in the mirror file (the pg_dump
     * rolled the table back) are written back to the table first.
     * Returns { tombstones, reapplied: [ids], failed: [{ id, error }] }.
     */
    async reapplyTombstones({ actorAdminId = null, source = 'restore', file } = {}) {
        let merged = 0;
        for (const t of this.readTombstoneFile(file === undefined ? tombstoneFile() : file)) {
            try {
                const r = await inSavepoint(() =>
                    db.run(
                        `INSERT INTO erasure_tombstones (subject_type, subject_id, erased_at, method)
                         VALUES (?, ?, COALESCE(?::timestamptz, now()), ?)
                         ON CONFLICT (subject_type, subject_id) DO NOTHING`,
                        [t.subjectType, t.subjectId, t.erasedAt, t.method]
                    )
                );
                merged += (r && r.changes) || 0;
            } catch (_) {
                /* counted below as the table read */
            }
        }
        const total = await db.get('SELECT COUNT(*)::int AS n FROM erasure_tombstones');
        const stale = await db.all(
            `SELECT t.subject_id, t.method
               FROM erasure_tombstones t
               JOIN employees e ON e.id = t.subject_id
              WHERE t.subject_type = 'employee' AND e.erased_at IS NULL
              ORDER BY t.subject_id`
        );
        const reapplied = [];
        const failed = [];
        for (const row of stale) {
            const id = Number(row.subjectId);
            try {
                await inSavepoint(() =>
                    this.erase(id, actorAdminId, {
                        reason: `erasure re-applied after ${source}`,
                        method: row.method || 'dsr_erase',
                        reapply: true,
                    })
                );
                reapplied.push(id);
            } catch (e) {
                failed.push({ id, error: String((e && e.message) || e).slice(0, 200) });
            }
        }
        const summary = {
            tombstones: Number((total && total.n) || 0),
            mergedFromFile: merged,
            reapplied,
            failed,
        };
        try {
            await require('./LogService').log({
                adminId: actorAdminId,
                action: 'GDPR_ERASURE_REAPPLY_RUN',
                entityType: 'system',
                entityId: null,
                details:
                    `Erasure tombstones re-applied after ${source}: ${summary.tombstones} tombstone(s), ` +
                    `${reapplied.length} subject(s) erased again` +
                    (reapplied.length ? ` [${reapplied.join(', ')}]` : '') +
                    (failed.length
                        ? `; ${failed.length} FAILED [${failed.map((f) => f.id).join(', ')}]`
                        : '') +
                    (merged ? `; ${merged} restored from the mirror file` : ''),
                severity: failed.length ? 'error' : reapplied.length ? 'warning' : 'info',
                category: 'maintenance',
                actorRef: actorAdminId ? `admin:${actorAdminId}` : 'system:restore',
            });
        } catch (_) {
            /* best-effort */
        }
        return summary;
    }

    // ===================== Retention purge (S-07) =============================

    get RETENTION_CATEGORIES() {
        return RETENTION_CATEGORIES;
    }

    /** 'apply' only when a SuperAdmin set it so; anything else REPORTS (fail closed). */
    async retentionMode() {
        try {
            const v = await require('../models/AppSettingsModel').getValue(
                'retentionPurgeMode',
                'report'
            );
            return String(v || '').trim() === 'apply' ? 'apply' : 'report';
        } catch (_) {
            return 'report';
        }
    }

    async _ledger(runId, category, subjectId, mode, action, detail = null) {
        try {
            await db.run(
                `INSERT INTO retention_ledger (run_id, category, subject_type, subject_id, mode, action, detail)
                 VALUES (?, ?, 'employee', ?, ?, ?, ?)`,
                [runId, category, Number(subjectId), mode, action, detail]
            );
        } catch (e) {
            console.error('[retention] ledger write failed:', e && e.message);
        }
    }

    /**
     * One retention pass. For every leaver whose retention period has expired:
     *   - legal hold          → skipped, ledger 'skipped_legal_hold';
     *   - active again        → skipped (a rehire is never erased by a clock);
     *   - already erased      → ledger 'already_erased' (apply: job closed);
     *   - mode 'report'       → ledger 'would_erase', NOTHING else is written;
     *   - mode 'apply'        → CLAIM the job row (one worker at a time), then
     *                           erase — the DSR path — with method
     *                           'retention_purge'; ledger 'erased' + audit row.
     * Idempotent: an erased subject's job is completed by erase itself, so a
     * second pass finds nothing to do.
     */
    async runRetention({ mode, actorRef = null } = {}) {
        const effective = mode === 'apply' || mode === 'report' ? mode : await this.retentionMode();
        const runId = `ret-${new Date()
            .toISOString()
            .replace(/[-:.TZ]/g, '')
            .slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
        const cat = RETENTION_CATEGORIES[0].key;
        const counts = {};
        const bump = (k) => {
            counts[k] = (counts[k] || 0) + 1;
        };
        const due = await db.all(
            `SELECT j.employee_id, j.country_code, j.due_at, j.legal_hold_at,
                    e.id AS emp_id, e.is_active, e.erased_at
               FROM pii_cleanup_jobs j
               LEFT JOIN employees e ON e.id = j.employee_id
              WHERE j.completed_at IS NULL AND j.due_at <= now()
              ORDER BY j.due_at, j.employee_id
              LIMIT ${RETENTION_BATCH}`
        );
        for (const r of due) {
            const id = Number(r.employeeId);
            const dueOn = r.dueAt ? new Date(r.dueAt).toISOString().slice(0, 10) : '?';
            const where = `country ${r.countryCode || '?'}, due ${dueOn}`;
            if (r.legalHoldAt) {
                await this._ledger(runId, cat, id, effective, 'skipped_legal_hold', where);
                bump('skipped_legal_hold');
                continue;
            }
            if (r.empId == null) {
                await this._ledger(runId, cat, id, effective, 'skipped_missing', where);
                bump('skipped_missing');
                continue;
            }
            if (r.erasedAt) {
                if (effective === 'apply') {
                    await db.run(
                        "UPDATE pii_cleanup_jobs SET completed_at = now(), notes = COALESCE(notes, '') || ' already erased' WHERE employee_id = ? AND completed_at IS NULL",
                        [id]
                    );
                    await this._writeTombstoneRow('employee', id, 'dsr_erase');
                }
                await this._ledger(runId, cat, id, effective, 'already_erased', where);
                bump('already_erased');
                continue;
            }
            if (r.isActive) {
                await this._ledger(runId, cat, id, effective, 'skipped_active', where);
                bump('skipped_active');
                continue;
            }
            if (effective !== 'apply') {
                await this._ledger(runId, cat, id, effective, 'would_erase', where);
                bump('would_erase');
                continue;
            }
            // CLAIM before acting: only the worker whose UPDATE flips the row
            // proceeds; a concurrent run (second instance, manual click during
            // the scheduled tick) sees 0 rows and moves on.
            const claim = await db.run(
                `UPDATE pii_cleanup_jobs SET claimed_at = now()
                  WHERE employee_id = ? AND completed_at IS NULL AND legal_hold_at IS NULL
                    AND (claimed_at IS NULL OR claimed_at < now() - interval '${CLAIM_STALE_MINUTES} minutes')`,
                [id]
            );
            if (!claim || claim.changes !== 1) {
                await this._ledger(runId, cat, id, effective, 'skipped_claimed', where);
                bump('skipped_claimed');
                continue;
            }
            try {
                await this.erase(id, null, {
                    reason: `retention period expired (${where})`,
                    method: 'retention_purge',
                });
                await this._ledger(runId, cat, id, effective, 'erased', where);
                bump('erased');
                try {
                    await require('./LogService').log({
                        action: 'RETENTION_PURGE',
                        entityType: 'employee',
                        entityId: id,
                        details: `Retention period expired (${where}) — subject pseudonymised (run ${runId})`,
                        severity: 'warning',
                        category: 'maintenance',
                        actorRef: actorRef || 'system:retention-purge',
                    });
                } catch (_) {
                    /* best-effort */
                }
            } catch (e) {
                // Release the claim so the next run can try again.
                await db
                    .run('UPDATE pii_cleanup_jobs SET claimed_at = NULL WHERE employee_id = ?', [
                        id,
                    ])
                    .catch(() => {});
                await this._ledger(
                    runId,
                    cat,
                    id,
                    effective,
                    'failed',
                    `${where}: ${String((e && e.message) || e).slice(0, 200)}`
                );
                bump('failed');
            }
        }
        try {
            await require('./LogService').log({
                action: 'RETENTION_RUN',
                entityType: 'system',
                entityId: null,
                details: `Retention run ${runId} (mode ${effective}): ${due.length} due — ${
                    Object.entries(counts)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ') || 'nothing to do'
                }`,
                severity: counts.failed ? 'error' : 'info',
                category: 'maintenance',
                actorRef: actorRef || 'system:retention-purge',
            });
        } catch (_) {
            /* best-effort */
        }
        return { runId, mode: effective, due: due.length, counts };
    }

    /** Put a subject's retention job on / off legal hold (SuperAdmin, reason required). */
    async setLegalHold(employeeId, { hold, reason, actorRef = null } = {}) {
        const id = Number(employeeId);
        const why = String(reason || '').trim();
        if (!why) {
            const e = new Error('reason_required');
            e.status = 400;
            e.code = 'reason_required';
            e.expose = true;
            throw e;
        }
        const r = hold
            ? await db.run(
                  `UPDATE pii_cleanup_jobs SET legal_hold_at = now(), legal_hold_by = ?, legal_hold_reason = ?
                    WHERE employee_id = ? AND completed_at IS NULL`,
                  [actorRef, why, id]
              )
            : await db.run(
                  `UPDATE pii_cleanup_jobs SET legal_hold_at = NULL, legal_hold_by = NULL, legal_hold_reason = NULL
                    WHERE employee_id = ? AND completed_at IS NULL`,
                  [id]
              );
        if (!r || r.changes !== 1) {
            // 3.23.21: no retention job yet (the person has not left) —
            // the hold is set on the employee and carried onto the job at departure.
            const emp = await db.get(`SELECT id, erased_at FROM employees WHERE id = ?`, [id]);
            if (emp && !emp.erasedAt) {
                return require('./LifecycleService').setEmployeeLegalHold(id, {
                    hold,
                    reason: why,
                    actorRef,
                });
            }
            const e = new Error('no_open_retention_job');
            e.status = 404;
            e.code = 'no_open_retention_job';
            e.expose = true;
            throw e;
        }
        try {
            await require('./LogService').log({
                action: hold ? 'RETENTION_LEGAL_HOLD_SET' : 'RETENTION_LEGAL_HOLD_RELEASED',
                entityType: 'employee',
                entityId: id,
                details: `${hold ? 'Legal hold set' : 'Legal hold released'} — reason: ${why}`,
                severity: 'warning',
                category: 'maintenance',
                actorRef,
            });
        } catch (_) {
            /* best-effort */
        }
        return { ok: true, employeeId: id, hold: Boolean(hold) };
    }

    /** Everything the Retention panel shows, in one read. */
    async retentionStatus() {
        // One read at a time (not Promise.all): inside a transaction the reads
        // share ONE client, and a failed read runs in its own savepoint so it
        // is reported as "not measured" without poisoning anything.
        const safe = async (fn, dflt) => {
            try {
                return await inSavepoint(fn);
            } catch (_) {
                return dflt;
            }
        };
        const mode = await this.retentionMode();
        const periods = await safe(
            () =>
                db.all(
                    'SELECT code, name, dsr_sla_days FROM countries WHERE is_active = true ORDER BY code'
                ),
            null
        );
        const due = await safe(
            () =>
                db.all(
                    `SELECT j.employee_id, j.country_code, j.due_at, j.legal_hold_at, j.legal_hold_reason,
                            e.first_name, e.last_name, e.is_active
                       FROM pii_cleanup_jobs j LEFT JOIN employees e ON e.id = j.employee_id
                      WHERE j.completed_at IS NULL AND j.due_at <= now()
                      ORDER BY j.due_at LIMIT 200`
                ),
            null
        );
        const pending = await safe(
            () =>
                db.get(
                    'SELECT COUNT(*)::int AS n FROM pii_cleanup_jobs WHERE completed_at IS NULL AND due_at > now()'
                ),
            null
        );
        const unscheduled = await safe(
            () =>
                db.get(
                    `SELECT COUNT(*)::int AS n FROM employees e
                      WHERE e.is_active = false AND e.erased_at IS NULL AND e.cancelled_at IS NULL
                        AND NOT EXISTS (SELECT 1 FROM pii_cleanup_jobs j WHERE j.employee_id = e.id)
                        AND EXISTS (SELECT 1 FROM lifecycle_events le
                                     WHERE le.employee_id = e.id AND le.kind = 'leaver' AND le.reverted_at IS NULL)`
                ),
            null
        );
        const lastRun = await safe(
            () =>
                db.all(
                    `SELECT run_id, mode, action, COUNT(*)::int AS n, MAX(created_at) AS at
                       FROM retention_ledger
                      WHERE run_id = (SELECT run_id FROM retention_ledger ORDER BY created_at DESC, id DESC LIMIT 1)
                      GROUP BY run_id, mode, action`
                ),
            null
        );
        const tomb = await safe(
            () => db.get('SELECT COUNT(*)::int AS n FROM erasure_tombstones'),
            null
        );
        let last = null;
        if (Array.isArray(lastRun) && lastRun.length) {
            last = { runId: lastRun[0].runId, mode: lastRun[0].mode, at: null, counts: {} };
            for (const r of lastRun) {
                last.counts[r.action] = Number(r.n);
                if (!last.at || new Date(r.at) > new Date(last.at)) last.at = r.at;
            }
        }
        let lastRunOn = null;
        try {
            lastRunOn = await require('../models/AppSettingsModel').getValue(
                'retentionPurgeLastRunOn',
                null
            );
        } catch (_) {
            /* unread */
        }
        // `null` = NOT MEASURED (table absent, query failed) — never a zero.
        return {
            mode,
            categories: RETENTION_CATEGORIES,
            periods,
            due,
            pendingNotDue: pending ? Number(pending.n) : null,
            unscheduledLeavers: unscheduled ? Number(unscheduled.n) : null,
            lastRun: last,
            lastRunOn,
            tombstones: tomb ? Number(tomb.n) : null,
        };
    }

    /** Subjects past their country DSR SLA (for a retention sweep / review). */
    async dueForRetention() {
        return db
            .all(
                `SELECT j.employee_id, j.country_code, j.due_at
             FROM pii_cleanup_jobs j
             WHERE j.completed_at IS NULL AND j.due_at <= now()
             ORDER BY j.due_at`
            )
            .catch(() => []);
    }
}

const service = new DSRService();
// Exposées sur l'instance : le test épingle la correspondance des deux listes,
// et il n'existe qu'UNE définition de « donnée personnelle du sujet ».
service.REDACTED_ON_ERASURE = REDACTED_ON_ERASURE;
service.DISCLOSED_ABOUT_SUBJECT = DISCLOSED_ABOUT_SUBJECT;

module.exports = service;
