-- LA DEMANDE DE MODIFICATION (HR policy 13/09/2026, §3 règle 5 ;
-- RULES-assessment-change.md « What "request for change" has to be » ; HR1-15, HR4-15).
--
-- Elle n'existait NULLE PART : ni table, ni route, ni code (mesuré le 13/09/2026 —
-- 0 table dont le nom contient change_request / request_for_change / assessment_request).
-- Deux règles du propriétaire étaient donc inapplicables :
--   « après soumission, passer par une demande de modification »
--   « au-delà de la validation, le superviseur passe par une demande de modification »
--
-- Ce que la table doit porter, sans exception (c'est la règle, pas une commodité) :
--   QUI demande (employé OU superviseur/manager), QUAND, et un MOTIF OBLIGATOIRE ;
--   QUELLE ligne est visée et DANS QUEL ÉTAT elle était au moment de la demande ;
--   la DÉCISION — accordée ou refusée — par un décideur NOMMÉ, à une date, avec un
--   motif obligatoire sur un refus ;
--   la campagne de rattachement au moment de la demande (une campagne close refuse).
--
-- L'octroi est la SEULE chose qui rouvre le droit de modifier : c'est pourquoi
-- `status='granted'` est écrit dans la même transaction que la transition de la
-- ligne visée vers `changes_requested` (AssessmentChangeRequestService.grant).
--
-- 2) L'ANNULATION PAR LE SUPERVISEUR / LE MANAGER (règle B du propriétaire).
-- Elle est un ÉTAT plus un MOTIF, jamais une suppression. L'état physique reste
-- `rejected` — la migration 100 explique pourquoi une neuvième valeur d'état serait
-- un piège : trois lecteurs filtrent NÉGATIVEMENT (IDPService `<> 'rejected'`, la file
-- de revue `<> 'draft'`, DeptAnalytics `NOT IN ('draft','changes_requested')`) et une
-- valeur inédite repasserait silencieusement dans les trois. Ce qui manquait, et que
-- ces trois colonnes ajoutent, c'est de pouvoir DIRE que c'est une annulation : qui,
-- quand, pourquoi. L'état montré à l'utilisateur est « Annulée / Cancelled ».
--
-- Idempotente : sûre à rejouer.

-- 1) La demande de modification ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assessment_change_requests (
    id                 bigserial PRIMARY KEY,
    self_assessment_id bigint      NOT NULL REFERENCES public.self_assessment_rounds(id) ON DELETE CASCADE,
    employee_id        bigint      NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    -- La campagne au moment de la demande (NULL = mesure hors campagne, A6).
    cycle_id           bigint      REFERENCES public.assessment_cycles(id) ON DELETE SET NULL,
    -- QUI demande. `requester_ref` suit la convention system_logs.actor_ref
    -- (`employee:<id>` / `admin:<id>`) : c'est le seul format qui nomme aussi bien
    -- une personne qu'un compte d'administration.
    requester_ref      text        NOT NULL CHECK (btrim(requester_ref) <> ''),
    requester_role     text        NOT NULL CHECK (requester_role IN ('employee','supervisor','manager','admin')),
    -- POURQUOI. Obligatoire : une demande sans motif ne peut pas être décidée.
    reason             text        NOT NULL CHECK (btrim(reason) <> ''),
    -- L'ÉTAT DE LA CIBLE AU MOMENT DE LA DEMANDE — figé, jamais recalculé ensuite.
    target_state       text        NOT NULL CHECK (btrim(target_state) <> ''),
    target_status      text,
    status             text        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','granted','refused','withdrawn')),
    decided_by_ref     text,
    decided_by_role    text        CHECK (decided_by_role IS NULL OR decided_by_role IN ('supervisor','manager','admin','employee')),
    decided_at         timestamptz,
    decision_reason    text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Une décision nomme toujours quelqu'un, à une date.
    CONSTRAINT chk_acr_decided_named CHECK (
        (status = 'pending'  AND decided_at IS NULL AND decided_by_ref IS NULL)
     OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_ref IS NOT NULL AND btrim(decided_by_ref) <> '')
    ),
    -- Un REFUS porte toujours son motif (règle du propriétaire, sans exception).
    CONSTRAINT chk_acr_refusal_reason CHECK (
        status <> 'refused' OR (decision_reason IS NOT NULL AND btrim(decision_reason) <> '')
    )
);

-- Une seule demande OUVERTE par ligne visée : deux demandes concurrentes sur la même
-- évaluation produiraient deux décisions contradictoires sur le même fait.
CREATE UNIQUE INDEX IF NOT EXISTS uq_acr_open_per_assessment
    ON public.assessment_change_requests (self_assessment_id) WHERE status = 'pending';
-- La file du décideur, et la liste du demandeur.
CREATE INDEX IF NOT EXISTS idx_acr_employee_status
    ON public.assessment_change_requests (employee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acr_requester
    ON public.assessment_change_requests (requester_ref, created_at DESC);

COMMENT ON TABLE public.assessment_change_requests IS
    'Demande de modification d''une évaluation : demandeur, motif obligatoire, cible et son état, décision nommée et datée, motif obligatoire sur un refus. L''octroi est la seule chose qui rouvre le droit de modifier.';

-- 2) L''annulation : un état plus un motif, jamais une suppression --------------
ALTER TABLE public.self_assessment_rounds ADD COLUMN IF NOT EXISTS cancelled_at     timestamptz;
ALTER TABLE public.self_assessment_rounds ADD COLUMN IF NOT EXISTS cancel_reason    text;
ALTER TABLE public.self_assessment_rounds ADD COLUMN IF NOT EXISTS cancelled_by_ref text;

ALTER TABLE public.self_assessment_rounds DROP CONSTRAINT IF EXISTS chk_sa_cancel_reasoned;
ALTER TABLE public.self_assessment_rounds ADD CONSTRAINT chk_sa_cancel_reasoned CHECK (
    cancelled_at IS NULL
 OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> ''
     AND cancelled_by_ref IS NOT NULL AND btrim(cancelled_by_ref) <> '')
);

COMMENT ON COLUMN public.self_assessment_rounds.cancelled_at IS
    'Annulation par le superviseur/manager (règle B) : l''état physique reste ''rejected'' — cf. migration 100 — et ces trois colonnes disent que c''était une annulation, par qui et pourquoi.';

-- 3) La vue des tours COURANTS porte les nouvelles colonnes ---------------------
-- `self_assessments` est la vue auto-modifiable des tours courants (migration 113).
-- Les colonnes ajoutées ici doivent y figurer, sinon rien ne peut les écrire à
-- travers elle. CREATE OR REPLACE VIEW n''autorise que des ajouts EN FIN de liste :
-- les 18 colonnes d''origine restent dans leur ordre exact.
CREATE OR REPLACE VIEW public.self_assessments AS
    SELECT id, employee_id, skill_id, self_rated_level, status, submitted_at,
           reviewed_at, reviewed_by, notes, created_at, updated_at, cycle_id,
           justification, locked_state, workflow_state, approved_by, approved_at,
           current_reviewer_id,
           cancelled_at, cancel_reason, cancelled_by_ref
      FROM public.self_assessment_rounds
     WHERE superseded_at IS NULL;

INSERT INTO schema_meta(key, value) VALUES ('114_assessment_change_requests', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
