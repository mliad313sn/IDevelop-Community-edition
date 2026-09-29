-- 123_repair_113_carryover_and_views.sql
--
-- RENUMEROTEE PAR L'INTEGRATEUR le 16/09/2026 : livree sous le numero 122, elle
-- entrait en collision avec 122_append_only_guard_privileges.sql, ecrite par un
-- autre lot le meme jour, tandis que le numero 123 restait libre. Le lanceur
-- indexe schema_meta sur le nom COMPLET du fichier : il n'y avait donc pas de
-- collision de cle, mais une numerotation ambigue et un trou apparent. L'ordre
-- d'application est INCHANGE (122_append, puis celle-ci, puis 124). Une base qui
-- porte deja la cle '122_repair_113_carryover_and_views' rejouera ce fichier une
-- fois sous sa nouvelle cle : il est idempotent, c'est sans effet.
--
-- REPARATION DE LA MIGRATION 113. Deux defauts, une seule cause : 113 a change
-- la forme du stockage des auto-evaluations et a emmene avec elle des choses
-- qu'elle croyait ne pas toucher. 113 est deja appliquee partout : on ne la
-- reecrit pas, on repare ce qu'elle a laisse.
--
-- ===========================================================================
-- A) LA REPRISE DE 113 A DECLASSE DES TOURS QUI ATTENDAIENT UNE DECISION
-- ===========================================================================
-- Ce qui a ete MESURE, le 15/09/2026, sur une base de developpement clonee,
-- en rejouant VERBATIM le bloc de reprise de 113 (lignes 86-105) sur la forme
-- de donnees ANTERIEURE a 113 :
--
--   AVANT la reprise : tour 224063 SOUMIS le J-10, revue superviseur 'pending',
--                      visible dans la file du superviseur (1 ligne)
--                      + un brouillon date du J-1 sur la MEME paire
--                      (parfaitement legal avant 113 : l'unicite portait sur
--                       (employee_id, skill_id, STATUS), donc une paire pouvait
--                       porter en meme temps une ligne 'draft' et une 'submitted')
--   APRES la reprise : tour 224063 remplace=true, file du superviseur = 0 ligne
--
-- La reprise numerote par (created_at, id) et marque remplaces tous les tours
-- sauf le plus recent. Elle ne regarde NI workflow_state, NI status, NI
-- l'existence d'une revue superviseur en attente. Le brouillon rouvert etant le
-- plus recent, c'est LUI qui devient la mesure courante et le tour soumis qui
-- part en historique — le jour meme ou la migration s'applique, sans un mot.
--
-- CE QUE CETTE MIGRATION REPARE, ET RIEN D'AUTRE. Un tour est rendu a la file
-- si, et seulement si, les quatre conditions sont reunies :
--   1. il est marque remplace ET pointe vers son successeur ;
--   2. ce marquage vient de la REPRISE, pas d'une re-mesure reelle. Le seul
--      chemin applicatif qui remplace un tour (SelfAssessmentService, « asked
--      again by a different campaign ») ecrit TOUJOURS, dans la meme
--      transaction, un evenement 'reopen_new_cycle' sur le tour remplace.
--      L'absence de cet evenement est donc la signature de la reprise.
--      (Le second test, superseded_at = created_at du successeur, est la valeur
--      exacte qu'ecrit 113:99 — garde supplementaire, pas discriminante :
--      now etant constant dans une transaction, le chemin applicatif produit
--      la meme egalite.)
--   3. le tour attend reellement une decision : workflow_state parmi
--      submitted / under_review / reviewed / arbitration, OU il porte une
--      supervisor_reviews 'pending'. 'changes_requested' est VOLONTAIREMENT
--      exclu : dans cet etat la main est rendue a la personne, le brouillon
--      suivant est donc sa suite legitime ;
--   4. le tour qui a pris sa place est une COQUILLE : un brouillon encore
--      courant, jamais soumis, jamais revu, jamais approuve, sans aucune revue
--      superviseur. Il n'a donc jamais produit de mesure et ne peut pas etre
--      « la mesure plus recente » qui remplace legitimement du travail en cours.
--
-- Tout le reste est LAISSE EN L'ETAT et signale par un NOTICE : quand le tour
-- qui a pris la place porte deja du travail reel, arbitrer entre deux mesures
-- est une decision du proprietaire, pas d'une migration.
--
-- Rien n'est supprime : on ne deplace que le drapeau « mesure courante ».
-- Le brouillon vide n'est pas efface, il est mis de cote (superseded_at) et
-- reste lisible sur la page de progression, comme n'importe quel tour.
--
-- SANS EFFET SUR UNE BASE SAINE : sur une base ou aucun tour n'a ete declasse
-- a tort, la boucle ne trouve aucune ligne et n'ecrit rien. REJOUABLE : apres
-- reparation le tour rendu n'est plus marque remplace (condition 1 fausse) et
-- la coquille mise de cote ne pointe vers personne (condition 1 fausse) ;
-- une seconde execution touche 0 ligne.
--
-- ===========================================================================
-- B) LE RENAME DE 113 A SILENCIEUSEMENT RE-CABLE SIX VUES SUR LA TABLE
-- ===========================================================================
-- Ce qui a ete MESURE sur une base de developpement :
--   SELECT ... FROM pg_depend ... WHERE source.relname = 'self_assessment_rounds'
--   -> v_cycle_participant_status, v_employee_cycle_progress,
--      v_employee_skill_gaps, v_perf_actions, v_requirement_provenance,
--      v_resolved_assessments
-- alors qu'AUCUN fichier de migration ne nomme self_assessment_rounds dans une
-- vue : ces six vues sont toutes ecrites « FROM self_assessments » dans les
-- fichiers 55, 57, 71, 80 et 105 — tous ANTERIEURS a 113.
--
-- PostgreSQL lie les vues par OID, pas par nom : le ALTER TABLE ... RENAME TO
-- de 113:47 a emmene les six vues avec la table renommee, et le
-- CREATE OR REPLACE VIEW self_assessments de 113:122 a cree un objet NEUF que
-- personne ne reference. Les six vues comptent donc desormais TOUS les tours,
-- historique compris — exactement ce que l'en-tete de 113 promettait
-- d'empecher (« history simply cannot leak into a review queue, a campaign
-- counter or a dashboard tile »).
--
-- Effet mesure, paire (employe, competence) portant un tour APPROUVE devenu
-- historique et un tour courant SOUMIS :
--   verite (vue self_assessments)  : status = submitted (personne n'a approuve)
--   v_resolved_assessments         : niveau 4, source 'self_approved'
-- La vue affirme un niveau approuve pour une mesure qui attend son superviseur.
--
-- CE QUE CHAQUE VUE DOIT COMPTER — la mesure COURANTE, jamais l'historique :
--   v_cycle_participant_status : l'etat d'un participant dans une campagne.
--       Compter les tours remplaces gonfle approved_skills et bascule
--       participant_state en 'approved' alors que le tour courant attend
--       encore une decision — la personne sort de la file du superviseur.
--   v_employee_cycle_progress  : la progression d'une personne dans une
--       campagne (skills_in_cycle / approved / in_review / unsubmitted /
--       rejected et la moyenne auto-evaluee). L'historique fait depasser le
--       nombre de competences et melange plusieurs tours dans la moyenne.
--   v_employee_skill_gaps      : l'ecart entre le niveau requis et le niveau
--       reel. Doit retenir le dernier niveau APPROUVE COURANT ; un tour
--       approuve remplace y maintient un niveau perime et declare la
--       competence « evaluee ».
--   v_perf_actions             : le flux des actions (PIP / IDP / coaching /
--       auto-evaluation), une ligne par action. Sur la table, la meme
--       auto-evaluation apparait autant de fois qu'elle a eu de tours.
--   v_requirement_provenance   : d'ou vient le niveau retenu pour une exigence.
--       Doit citer le tour approuve COURANT, sinon la provenance designe un
--       tour qui n'est plus la mesure.
--   v_resolved_assessments     : le niveau retenu par (personne, competence) —
--       alimente le tableau de bord, la couverture et le risque de personne
--       cle. Doit se resoudre sur la mesure courante.
--
-- COMMENT : on relit la definition VIVANTE de chaque vue et on la recree a
-- l'identique en remplacant le nom de la table par celui de la vue. Aucun
-- texte n'est recopie depuis un fichier ancien : une correction apportee a une
-- de ces vues apres 113 ne peut donc pas etre annulee ici. Une vue qui ne
-- nomme deja plus la table est laissee telle quelle — d'ou l'absence d'effet
-- sur une base saine, et la rejouabilite.
--
-- Pas de BEGIN/COMMIT ici : db.migrate enveloppe deja chaque fichier dans
-- une transaction sur une seule connexion, et un COMMIT dans le fichier
-- terminerait CETTE transaction avant l'inscription dans schema_meta.

-- ---------------------------------------------------------------------------
-- A) Rendre a la file de revue les tours que la reprise de 113 a declasses.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_row      record;
    v_restored integer := 0;
    v_left     integer := 0;
BEGIN
    IF to_regclass('public.self_assessment_rounds') IS NULL THEN
        RETURN;                     -- 113 n'est pas passee : rien a reparer.
    END IF;

    FOR v_row IN
        WITH carried AS (
            -- (1) marque remplace + (2) signature de la REPRISE, pas d'une re-mesure
            SELECT r.id, r.employee_id, r.skill_id, r.superseded_by,
                   r.created_at, r.workflow_state
              FROM public.self_assessment_rounds r
              JOIN public.self_assessment_rounds nxt ON nxt.id = r.superseded_by
             WHERE r.superseded_at IS NOT NULL
               AND r.superseded_at = nxt.created_at
               AND NOT EXISTS (
                     SELECT 1 FROM public.self_assessment_events e
                      WHERE e.self_assessment_id = r.id
                        AND e.action = 'reopen_new_cycle')
        ),
        awaiting AS (
            -- (3) le tour attend reellement une decision
            SELECT c.* FROM carried c
             WHERE c.workflow_state IN ('submitted', 'under_review', 'reviewed', 'arbitration')
                OR EXISTS (SELECT 1 FROM public.supervisor_reviews sr
                            WHERE sr.self_assessment_id = c.id AND sr.status = 'pending')
        ),
        ranked AS (
            -- une paire peut en porter plusieurs (une ligne par statut, avant 113) :
            -- seul le plus recent peut redevenir courant, uq_sa_current_round
            -- n'en autorise qu'un. Les plus anciens restent de l'historique et
            -- pointent deja, par la chaine de 113, vers celui qu'on restaure.
            SELECT a.*, row_number() OVER (PARTITION BY a.employee_id, a.skill_id
                                           ORDER BY a.created_at DESC, a.id DESC) AS rn
              FROM awaiting a
        )
        SELECT k.id AS round_id, k.employee_id, k.skill_id,
               k.superseded_by AS shell_id, nxt.workflow_state AS shell_state,
               -- (4) le tour qui a pris la place est-il une coquille vide ?
               (nxt.superseded_at IS NULL
                AND nxt.workflow_state = 'draft'
                AND nxt.submitted_at IS NULL
                AND nxt.reviewed_at IS NULL
                AND nxt.approved_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.supervisor_reviews sr2
                                 WHERE sr2.self_assessment_id = nxt.id)) AS shell_is_empty
          FROM ranked k
          JOIN public.self_assessment_rounds nxt ON nxt.id = k.superseded_by
         WHERE k.rn = 1
    LOOP
        IF NOT v_row.shell_is_empty THEN
            v_left := v_left + 1;
            RAISE NOTICE 'reparation 113 : tour % (employe %, competence %) laisse en historique — le tour qui l''a remplace porte deja du travail (%). Arbitrage a rendre par le proprietaire.',
                v_row.round_id, v_row.employee_id, v_row.skill_id, v_row.shell_state;
            CONTINUE;
        END IF;

        -- L'ordre est impose par uq_sa_current_round (un seul tour courant par
        -- paire) : on libere la place AVANT de rendre le tour a la file.
        UPDATE public.self_assessment_rounds
           SET superseded_at = now(), superseded_by = NULL
         WHERE id = v_row.shell_id;

        UPDATE public.self_assessment_rounds
           SET superseded_at = NULL, superseded_by = NULL
         WHERE id = v_row.round_id;

        v_restored := v_restored + 1;
        RAISE NOTICE 'reparation 113 : tour % (employe %, competence %) redevient la mesure courante ; le brouillon vide % est mis de cote, jamais supprime.',
            v_row.round_id, v_row.employee_id, v_row.skill_id, v_row.shell_id;
    END LOOP;

    IF v_restored > 0 OR v_left > 0 THEN
        RAISE NOTICE 'reparation 113 : % tour(s) rendu(s) a la file de revue, % laisse(s) a l''arbitrage du proprietaire.',
            v_restored, v_left;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B) Re-brancher sur la VUE `self_assessments` les six vues que le RENAME de
--    113 a emmenees sur la table physique.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_names CONSTANT text[] := ARRAY[
        'v_perf_actions',
        'v_employee_cycle_progress',
        'v_resolved_assessments',
        'v_employee_skill_gaps',
        'v_requirement_provenance',
        'v_cycle_participant_status'
    ];
    v_name  text;
    v_def   text;
    v_new   text;
    v_fixed integer := 0;
    v_still text;
    v_other text;
BEGIN
    IF to_regclass('public.self_assessments') IS NULL
       OR to_regclass('public.self_assessment_rounds') IS NULL THEN
        RETURN;                     -- 113 n'est pas passee : rien a re-brancher.
    END IF;

    FOREACH v_name IN ARRAY v_names LOOP
        IF to_regclass('public.' || quote_ident(v_name)) IS NULL THEN
            CONTINUE;               -- vue absente de cette installation
        END IF;
        v_def := pg_get_viewdef(('public.' || quote_ident(v_name))::regclass, true);
        IF v_def !~ '\mself_assessment_rounds\M' THEN
            CONTINUE;               -- deja branchee sur la vue : on n'y touche pas
        END IF;
        v_new := regexp_replace(
                     regexp_replace(v_def, '\s*;\s*$', ''),
                     '\mself_assessment_rounds\M', 'self_assessments', 'g');
        EXECUTE format('CREATE OR REPLACE VIEW public.%I AS %s', v_name, v_new);
        v_fixed := v_fixed + 1;
        RAISE NOTICE 'reparation 113 : vue % re-branchee sur self_assessments (la mesure courante).', v_name;
    END LOOP;

    -- Verification : aucune des six ne doit plus dependre de la table des tours.
    SELECT string_agg(DISTINCT dep.relname, ', ')
      INTO v_still
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class dep ON dep.oid = rw.ev_class
      JOIN pg_class src ON src.oid = d.refobjid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
     WHERE ns.nspname = 'public'
       AND src.relname = 'self_assessment_rounds'
       AND dep.relname = ANY (v_names);
    IF v_still IS NOT NULL THEN
        RAISE EXCEPTION 'reparation 113 : vue(s) encore branchee(s) sur la table des tours apres re-creation : %', v_still;
    END IF;

    -- Toute AUTRE vue branchee sur la table est signalee, jamais reecrite :
    -- lire l'historique peut etre voulu (la progression), cela doit alors etre
    -- un choix ecrit, pas un heritage du renommage.
    SELECT string_agg(DISTINCT dep.relname, ', ')
      INTO v_other
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class dep ON dep.oid = rw.ev_class
      JOIN pg_class src ON src.oid = d.refobjid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
     WHERE ns.nspname = 'public'
       AND src.relname = 'self_assessment_rounds'
       AND dep.relname <> 'self_assessment_rounds'
       AND dep.relname <> 'self_assessments';
    IF v_other IS NOT NULL THEN
        RAISE NOTICE 'reparation 113 : vue(s) lisant la table des tours (historique compris) : % — verifier que c''est VOULU.', v_other;
    END IF;

    IF v_fixed > 0 THEN
        RAISE NOTICE 'reparation 113 : % vue(s) re-branchee(s) sur la mesure courante.', v_fixed;
    END IF;
END $$;

INSERT INTO schema_meta(key, value) VALUES ('123_repair_113_carryover_and_views', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
