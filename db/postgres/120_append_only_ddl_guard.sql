-- LOT CONSOLE SQL. L'AJOUT SEUL DOIT AUSSI TENIR
-- FACE AU LANGAGE DE DEFINITION DE DONNEES (DDL).
--
-- CE QUI A ETE MESURE, LE 15/09/2026, SUR LA BASE D'ESSAI, EN TRANSACTION ANNULEE :
--
--   DROP TABLE self_assessment_events  -> REUSSIT ; to_regclass renvoie NULL.
--
-- Les gardes existantes sont des declencheurs de LIGNE (block_mutation, BEFORE
-- DELETE OR UPDATE) et d'INSTRUCTION (block_truncate, BEFORE TRUNCATE). Aucune
-- des deux ne voit le DDL : supprimer la table entiere efface la trace sans
-- qu'aucun declencheur ne s'execute. La garde applicative de la console refusait
-- `DROP TABLE system_logs` parce que le nom figurait dans une liste ecrite a la
-- main dans le code — liste qui, elle, avait derive : elle comptait 3 tables
-- quand la base en portait 4 (la migration 116 a ajoute self_assessment_events
-- sans que la liste du code suive).
--
-- CETTE MIGRATION APPORTE TROIS CHOSES :
--
-- 1) `public.append_only_tables` — LA reponse de la base a la question « quelles
--    tables sont en ajout seul ? ». Elle est calculee a partir des declencheurs
--    reellement installes, jamais d'une liste recopiee. Le code applicatif
--    l'interroge et l'unit avec sa propre liste declaree : une table qui recoit
--    les declencheurs est protegee par la console immediatement, sans qu'on ait a
--    se souvenir de mettre un tableau a jour.
--
-- 2) `audit_guard.append_only_registry` — le registre durable de ces memes tables.
--    Il existe parce qu'un declencheur d'evenement `sql_drop` s'execute APRES que
--    la table a quitte les catalogues : `pg_trigger` ne peut donc plus repondre au
--    moment ou il faudrait refuser. Le registre, lui, survit. Il ne fait que
--    GRANDIR : supprimer les declencheurs d'une table ne la fait pas sortir du
--    registre, donc ne la rend pas supprimable. Il vit dans un schema separe
--    (`audit_guard`) pour qu'un `DROP SCHEMA public CASCADE` ne l'emporte pas dans
--    le meme geste que les tables qu'il protege.
--
-- 3) `trg_block_append_only_drop` — le declencheur d'evenement qui refuse la
--    SUPPRESSION d'une table du registre, quelle que soit la voie empruntee :
--    DROP TABLE, DROP SCHEMA public CASCADE, ou une cascade depuis un parent. Le
--    refus se produit DANS la transaction du DDL : rien n'est supprime. Meme
--    vocabulaire d'erreur que les deux autres gardes (IMMUTABLE_TABLE /
--    check_violation), donc tous les gestionnaires existants le lisent deja. Il
--    protege aussi ses propres objets (le schema et le registre).
--
-- PORTEE VOLONTAIREMENT ETROITE. Le declencheur d'evenement ne refuse QUE la
-- suppression des tables. Il ne touche pas a `DROP TRIGGER` (les migrations 101 et
-- 116 sont idempotentes : elles font `DROP TRIGGER IF EXISTS` avant de recreer —
-- les bloquer casserait un simple rejeu) ni a `ALTER TABLE` (une migration future
-- doit pouvoir ajouter une colonne au journal). Ces deux voies restent couvertes
-- par la garde applicative de la console, qui les refuse par leur nom ET par la
-- relation reellement visee.
--
-- ECHAPPATOIRE DOCUMENTEE, ET ELLE EST BRUYANTE : le seul chemin legitime qui
-- supprime ces tables est `pg_restore --clean` lors d'un retour arriere vers un
-- point de restauration. SqlConsoleService desactive ce declencheur d'evenement
-- juste avant pg_restore et le reactive dans un `finally` — et les lignes en ajout
-- seul sont mises en quarantaine avant, puis rattachees apres. Un operateur peut
-- faire de meme a la main : `ALTER EVENT TRIGGER trg_block_append_only_drop
-- DISABLE;`. La console SQL, elle, refuse `ALTER EVENT TRIGGER`.
--
-- PRIVILEGES — ET POURQUOI CETTE MIGRATION NE PEUT PAS ECHOUER. `CREATE EVENT
-- TRIGGER` exige le SUPERUTILISATEUR, et l'installeur applique les migrations
-- SOUS LE ROLE APPLICATIF (Install-IDevelop.ps1 : « Migrations run as the app
-- role »), qui ne l'est pas. Une migration qui tombe sur un manque de privilege
-- ferait echouer toute l'installation. Toute la partie privilegiee est donc dans
-- un bloc a RATTRAPAGE D'EXCEPTION : si le role n'a pas le droit, la migration
-- pose un AVERTISSEMENT nomme (repris dans le journal d'installation) et
-- continue. La garde applicative de la console, elle, ne depend d'aucun
-- privilege et refuse le meme DDL dans tous les cas ; ce declencheur est une
-- defense en profondeur POUR LES CHEMINS HORS PRODUIT (psql, un outil tiers).
-- Pour l'installer apres coup, rejouer ce fichier connecte en superutilisateur.
--
-- Idempotente : sure a rejouer.

-- 1) La source de verite vivante ----------------------------------------------
-- Meme rattrapage qu'au bloc suivant : si la fonction existe deja et appartient a
-- un AUTRE role (installee une premiere fois en superutilisateur, rejouee ensuite
-- sous le role applicatif), `CREATE OR REPLACE` leve « must be owner » — un manque
-- de privilege, pas une erreur de schema. Il avertit, il ne casse pas la migration.
DO $truth$
BEGIN
    CREATE OR REPLACE FUNCTION public.append_only_tables()
        RETURNS TABLE (table_name text)
        LANGUAGE sql
        STABLE
        AS $fn$
        SELECT DISTINCT c.relname::text
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE n.nspname = 'public'
           AND NOT t.tgisinternal
           AND p.proname IN ('block_mutation', 'block_truncate')
         ORDER BY 1
    $fn$;

    COMMENT ON FUNCTION public.append_only_tables() IS
        'Les tables en AJOUT SEUL, calculees depuis les declencheurs reellement installes (block_mutation / block_truncate). Source de verite unique : le code applicatif l''interroge au lieu de recopier une liste.';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'public.append_only_tables() NON MISE A JOUR : le role % n''a pas le privilege requis. Detail : %', current_user, SQLERRM;
END
$truth$;

-- 2) et 3) Le registre durable et le refus du DDL destructeur -------------------
-- TOUT ce bloc est privilegie (les declencheurs d'evenement exigent le
-- superutilisateur). Un manque de privilege AVERTIT, il ne fait pas echouer
-- l'installation : voir la note « PRIVILEGES » en tete de fichier.
DO $guard$
BEGIN
    -- Hors du schema public, pour survivre a un DROP SCHEMA public CASCADE.
    CREATE SCHEMA IF NOT EXISTS audit_guard;

    CREATE TABLE IF NOT EXISTS audit_guard.append_only_registry (
        table_name    text PRIMARY KEY,
        registered_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON SCHEMA audit_guard IS
        'Objets qui protegent la piste d''audit. Separe de public pour survivre a un DROP SCHEMA public CASCADE.';
    COMMENT ON TABLE audit_guard.append_only_registry IS
        'Registre EN AJOUT SEUL des tables en ajout seul. Ne fait que grandir : retirer les declencheurs d''une table ne l''en sort pas, donc ne la rend pas supprimable.';

    -- SECURITY DEFINER : ces fonctions s'executent sur le dos de CELUI QUI
    -- declenche le DDL. En droits de l'appelant, elles lisaient le registre avec
    -- les privileges du role applicatif — qui n'en a aucun sur `audit_guard` —, si
    -- bien que tout DROP TABLE et tout CREATE TRIGGER de ce role echouait, y
    -- compris sur une table ordinaire (mesure : « permission denied for table
    -- append_only_registry » / « permission denied for schema audit_guard »).
    -- `search_path` est fige : aucun objet ne peut etre substitue par l'appelant.
    -- Voir db/postgres/122_append_only_guard_privileges.sql, qui pose la meme
    -- chose sur une base ou la 120 est deja appliquee.
    CREATE OR REPLACE FUNCTION audit_guard.sync_append_only_registry() RETURNS void
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog, audit_guard, public
        AS $sync$
        INSERT INTO audit_guard.append_only_registry (table_name)
        SELECT table_name FROM public.append_only_tables()
        ON CONFLICT (table_name) DO NOTHING
    $sync$;

    PERFORM audit_guard.sync_append_only_registry();

    -- Toute migration future qui pose les declencheurs d'ajout seul sur une
    -- nouvelle table l'inscrit automatiquement : plus de liste a tenir a la main.
    CREATE OR REPLACE FUNCTION audit_guard.on_create_trigger() RETURNS event_trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, audit_guard, public
        AS $evt$
    BEGIN
        PERFORM audit_guard.sync_append_only_registry();
    END;
    $evt$;

    CREATE OR REPLACE FUNCTION audit_guard.block_append_only_drop() RETURNS event_trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, audit_guard, public
        AS $drop$
    DECLARE
        obj record;
    BEGIN
        FOR obj IN SELECT object_type, schema_name, object_identity, object_name
                     FROM pg_event_trigger_dropped_objects()
        LOOP
            -- (a) Le garde se protege lui-meme. Ce test ne lit aucun catalogue :
            --     il doit tenir meme quand le registre vient d'etre supprime.
            IF (obj.object_type = 'schema' AND obj.object_identity = 'audit_guard')
               OR (obj.object_type = 'table' AND obj.object_identity = 'audit_guard.append_only_registry') THEN
                RAISE EXCEPTION 'IMMUTABLE_TABLE: % protects the append-only audit trail and cannot be dropped',
                    obj.object_identity USING ERRCODE = 'check_violation';
            END IF;

            -- (b) Une table du registre ne se supprime pas.
            IF obj.object_type = 'table' AND obj.schema_name = 'public'
               AND EXISTS (SELECT 1 FROM audit_guard.append_only_registry r
                            WHERE r.table_name = split_part(obj.object_identity, '.', 2)) THEN
                RAISE EXCEPTION 'IMMUTABLE_TABLE: % is append-only (DROP refused)',
                    obj.object_identity USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;
    END;
    $drop$;

    COMMENT ON FUNCTION audit_guard.block_append_only_drop() IS
        'Declencheur d''evenement : refuse la suppression d''une table en ajout seul (registre audit_guard.append_only_registry) et de ses propres objets. Echappatoire documentee : ALTER EVENT TRIGGER trg_block_append_only_drop DISABLE — ce que fait le retour arriere de la console SQL, autour de pg_restore uniquement.';

    DROP EVENT TRIGGER IF EXISTS trg_sync_append_only_registry;
    CREATE EVENT TRIGGER trg_sync_append_only_registry
        ON ddl_command_end
        WHEN TAG IN ('CREATE TRIGGER')
        EXECUTE FUNCTION audit_guard.on_create_trigger();

    DROP EVENT TRIGGER IF EXISTS trg_block_append_only_drop;
    CREATE EVENT TRIGGER trg_block_append_only_drop
        ON sql_drop
        EXECUTE FUNCTION audit_guard.block_append_only_drop();

    -- La synchronisation ECRIT dans le registre : elle n'est appelable que par son
    -- proprietaire et par le declencheur d'evenement, qui lui appartient.
    REVOKE ALL ON FUNCTION audit_guard.sync_append_only_registry() FROM PUBLIC;
    -- Lire le schema et le registre ne doit couter un privilege a personne. Le
    -- registre reste en AJOUT SEUL : aucun INSERT/UPDATE/DELETE n'est accorde.
    GRANT USAGE ON SCHEMA audit_guard TO PUBLIC;
    GRANT SELECT ON audit_guard.append_only_registry TO PUBLIC;

EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'GARDE DDL NON INSTALLEE : le role % n''a pas le privilege requis (CREATE EVENT TRIGGER exige le superutilisateur). La console SQL refuse toujours ce DDL cote application ; pour poser la garde cote base, rejouer db/postgres/120_append_only_ddl_guard.sql connecte en superutilisateur. Detail : %',
            current_user, SQLERRM;
END
$guard$;
