-- ATTRIBUTION, TRACE ET COHÉRENCE D'ÉTAT.
-- Référentiel RH 13/09/2026 §3 règles 2, 6 et 16 ; HR1-06, HR1-13, HR4-12.
--
-- Trois défauts mesurés sur la base de développement le 13/09/2026, corrigés ici :
--
-- 1) UNE VALIDATION QUI NE NOMME PERSONNE. `approved_by` et `reviewed_by` sont des
--    clés étrangères vers `employees`, et un administrateur n'est pas un employé :
--    le code écrit donc `approved_by = NULL` sur le chemin administrateur
--    (SelfAssessmentWorkflowService `auth.isAdmin ? null : user.id`). Mesuré :
--    **44 des 134** évaluations approuvées ne nomment personne sur la ligne.
--    Correctif : deux colonnes de RÉFÉRENCE D'ACTEUR (`approved_by_ref`,
--    `reviewed_by_ref`), au format déjà utilisé par `system_logs.actor_ref` —
--    `employee:<id>` / `admin:<id>` — qui peuvent nommer l'un comme l'autre.
--    REPRISE : l'auteur est retrouvé dans `self_assessment_events` (l'événement qui
--    a réellement porté la ligne à « approuvé ») et seulement s'il existe encore
--    dans `admins` / `employees` ; sinon la ligne est marquée `unknown`
--    (« auteur inconnu » à l'écran). **Aucun auteur n'est inventé.**
--
-- 2) UN JOURNAL D'ÉVÉNEMENTS MODIFIABLE. `self_assessment_events` — la seule trace
--    qui nomme l'acteur d'une approbation administrateur — acceptait UPDATE et
--    DELETE. Sondé puis annulé, connecté en SUPERUTILISATEUR PostgreSQL :
--    `UPDATE ... SET action='__PROBE__'` → 1 ligne ; `DELETE ...` → 1 ligne.
--    « Une trace qui peut être modifiée n'est pas une trace » (règle 16).
--    Correctif : les deux mêmes gardes que `system_logs` — `block_mutation`
--    (BEFORE DELETE OR UPDATE, par ligne) et `block_truncate` (BEFORE TRUNCATE,
--    par instruction, car TRUNCATE ne déclenche aucun déclencheur de ligne).
--
-- 3) DEUX COLONNES D'ÉTAT QUI PEUVENT DIVERGER. `status` (énum historique) et
--    `workflow_state` (8 valeurs) décrivent le même fait. Une seule fait foi —
--    `workflow_state` — et `status` en est la projection. La contrainte ci-dessous
--    rend TOUTE paire incohérente inconstructible, en écrivant noir sur blanc la
--    correspondance que le code applique déjà :
--        draft/changes_requested -> draft   ·  submitted/under_review -> submitted
--        reviewed -> reviewed               ·  arbitration -> l'état d'avant
--        approved -> approved               ·  rejected -> rejected
--    Les 182 lignes existantes la satisfont toutes (mesuré : 134 approved/approved,
--    46 draft/draft, 1 reviewed/reviewed, 1 submitted/submitted).
--
-- Idempotente : sûre à rejouer.

-- 1) Référence d'acteur sur la validation ---------------------------------------
ALTER TABLE public.self_assessment_rounds ADD COLUMN IF NOT EXISTS approved_by_ref text;
ALTER TABLE public.self_assessment_rounds ADD COLUMN IF NOT EXISTS reviewed_by_ref text;

COMMENT ON COLUMN public.self_assessment_rounds.approved_by_ref IS
    'Qui a validé : employee:<id> | admin:<id> | unknown (auteur non retrouvable dans le journal — jamais inventé). Pose la règle « toute validation nomme un humain » là où approved_by, clé étrangère vers employees, ne peut pas nommer un administrateur.';

-- Reprise. Ordre de préférence, du plus sûr au moins sûr, et RIEN au-delà :
--   a. la colonne existante approved_by / reviewed_by (un employé, déjà vérifié par la FK) ;
--   b. l'événement qui a porté la ligne à 'approved', si son acteur existe encore ;
--   c. 'unknown'.
UPDATE public.self_assessment_rounds sa
   SET approved_by_ref = COALESCE(
         CASE WHEN sa.approved_by IS NOT NULL THEN 'employee:' || sa.approved_by::text END,
         (SELECT CASE
                   WHEN ev.actor_type = 'admin' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.id = ev.actor_id)
                        THEN 'admin:' || ev.actor_id::text
                   WHEN ev.actor_type IN ('manager','supervisor','employee')
                        AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = ev.actor_id)
                        THEN 'employee:' || ev.actor_id::text
                 END
            FROM public.self_assessment_events ev
           WHERE ev.self_assessment_id = sa.id
             AND ev.to_state = 'approved'
             AND ev.actor_id IS NOT NULL
           ORDER BY ev.created_at DESC, ev.id DESC
           LIMIT 1),
         'unknown')
 WHERE sa.workflow_state = 'approved' AND sa.approved_by_ref IS NULL;

UPDATE public.self_assessment_rounds sa
   SET reviewed_by_ref = COALESCE(
         CASE WHEN sa.reviewed_by IS NOT NULL THEN 'employee:' || sa.reviewed_by::text END,
         sa.approved_by_ref)
 WHERE sa.workflow_state = 'approved' AND sa.reviewed_by_ref IS NULL;

-- Toute validation nomme quelqu'un — ou dit explicitement qu'elle ne le peut pas.
-- Une ligne « approuvée » sans référence d'acteur n'est plus constructible.
ALTER TABLE public.self_assessment_rounds DROP CONSTRAINT IF EXISTS chk_sa_approval_named;
ALTER TABLE public.self_assessment_rounds ADD CONSTRAINT chk_sa_approval_named CHECK (
    workflow_state <> 'approved'
 OR (approved_by_ref IS NOT NULL AND btrim(approved_by_ref) <> '')
);

-- 2) Cohérence des deux colonnes d'état -----------------------------------------
ALTER TABLE public.self_assessment_rounds DROP CONSTRAINT IF EXISTS chk_sa_state_pair;
ALTER TABLE public.self_assessment_rounds ADD CONSTRAINT chk_sa_state_pair CHECK (
    (workflow_state = 'draft'             AND status = 'draft')
 OR (workflow_state = 'changes_requested' AND status = 'draft')
 OR (workflow_state = 'submitted'         AND status = 'submitted')
 OR (workflow_state = 'under_review'      AND status = 'submitted')
 OR (workflow_state = 'reviewed'          AND status = 'reviewed')
 -- L'arbitrage n'a pas de contrepartie historique : la colonne `status` conserve
 -- l'état d'avant l'escalade, qui ne peut être que l'un de ces deux.
 OR (workflow_state = 'arbitration'       AND status IN ('submitted','reviewed'))
 OR (workflow_state = 'approved'          AND status = 'approved')
 OR (workflow_state = 'rejected'          AND status = 'rejected')
);

-- 3) Le journal d'événements passe en AJOUT SEUL ---------------------------------
-- Mêmes fonctions que system_logs / assessment_history / review_signatures
-- (01_schema.sql, 101_append_only_truncate_guard.sql) : un seul vocabulaire
-- d'erreur, donc tous les gestionnaires existants le lisent déjà.
DROP TRIGGER IF EXISTS trg_sa_events_immutable ON public.self_assessment_events;
CREATE TRIGGER trg_sa_events_immutable
    BEFORE DELETE OR UPDATE ON public.self_assessment_events
    FOR EACH ROW EXECUTE FUNCTION public.block_mutation();

DROP TRIGGER IF EXISTS trg_sa_events_no_truncate ON public.self_assessment_events;
CREATE TRIGGER trg_sa_events_no_truncate
    BEFORE TRUNCATE ON public.self_assessment_events
    FOR EACH STATEMENT EXECUTE FUNCTION public.block_truncate();

COMMENT ON TABLE public.self_assessment_events IS
    'Journal des transitions d''une évaluation — EN AJOUT SEUL (trg_sa_events_immutable / trg_sa_events_no_truncate), comme system_logs. C''est la seule trace qui nomme l''acteur d''une approbation administrateur.';

-- 4) La vue des tours courants porte les nouvelles colonnes ----------------------
-- Mêmes règles qu'en 114 : ajouts EN FIN de liste uniquement, l'ordre d'origine
-- est conservé, la vue reste auto-modifiable.
CREATE OR REPLACE VIEW public.self_assessments AS
    SELECT id, employee_id, skill_id, self_rated_level, status, submitted_at,
           reviewed_at, reviewed_by, notes, created_at, updated_at, cycle_id,
           justification, locked_state, workflow_state, approved_by, approved_at,
           current_reviewer_id,
           cancelled_at, cancel_reason, cancelled_by_ref,
           approved_by_ref, reviewed_by_ref
      FROM public.self_assessment_rounds
     WHERE superseded_at IS NULL;

INSERT INTO schema_meta(key, value) VALUES ('116_assessment_attribution_and_append_only', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
