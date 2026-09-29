-- LOT CONSOLE SQL, FINITION : LA GARDE DOIT SE
-- GARDER ELLE-MEME.
--
-- La migration 120 a pose la garde qui refuse `DROP TABLE <journal en ajout seul>`.
-- Elle la garde dans un schema separe, `audit_guard`, pour qu'un
-- `DROP SCHEMA public CASCADE` ne l'emporte pas. Personne n'avait essaye de viser
-- la garde elle-meme.
--
-- CE QUI A ETE MESURE LE 15/09/2026, SUR UNE BASE DE DEVELOPPEMENT, CHAQUE CAS
-- DANS SA PROPRE TRANSACTION, TOUTES ANNULEES :
--
--   1) DROP SCHEMA audit_guard;                      -> refuse (dependances)
--   2) DROP SCHEMA audit_guard CASCADE;              -> REUSSIT
--        « drop cascades to 6 other objects … event trigger
--          trg_block_append_only_drop », puis to_regclass(registre) = NULL et
--        pg_event_trigger = 0 ligne.
--      La CASCADE supprime le declencheur d'evenement AVANT qu'il ait a se
--      declencher : PostgreSQL etablit la liste des declencheurs a executer au
--      moment de l'execution, et a ce moment-la il n'y en a plus.
--   3) enchaine dans la MEME transaction :
--        DROP SCHEMA audit_guard CASCADE; DROP TABLE self_assessment_events;
--        -> to_regclass('self_assessment_events') = NULL. Le journal est parti.
--   4) la route courte, sans rien supprimer de la garde :
--        DELETE FROM audit_guard.append_only_registry WHERE table_name='…';
--        DROP TABLE self_assessment_events;   -> to_regclass = NULL.
--      Le registre est decrit par la 120 comme « EN AJOUT SEUL … Ne fait que
--      GRANDIR » ; rien ne le tenait. Une ligne s'en retirait comme d'une table
--      ordinaire.
--
-- CE QUE CETTE MIGRATION APPORTE, ET CE QU'ELLE N'APPORTE PAS.
--
-- A) LE REGISTRE DEVIENT REELLEMENT EN AJOUT SEUL (ferme le cas 4 sur TOUS les
--    chemins). Un declencheur BEFORE DELETE OR UPDATE et un BEFORE TRUNCATE, de
--    la meme forme et du meme vocabulaire d'erreur que ceux des journaux
--    (IMMUTABLE_TABLE / check_violation). INSERT reste libre : le registre doit
--    pouvoir grandir quand une migration future pose les gardes sur une nouvelle
--    table.
--
-- B) UNE SECONDE GARDE, DANS UN AUTRE SCHEMA (ferme le cas 2, donc le cas 3).
--    `public.block_audit_guard_drop` refuse la suppression du schema
--    `audit_guard`, de son registre, de ses fonctions et de ses declencheurs
--    d'evenement. Elle vit dans `public`, donc un `DROP SCHEMA audit_guard
--    CASCADE` ne l'emporte pas : elle survit au geste qu'elle doit refuser, et
--    elle se declenche. Symetriquement, la garde de `audit_guard` refuse
--    desormais la suppression de CETTE fonction-ci et du `DROP SCHEMA public` :
--    les deux schemas se gardent mutuellement, et aucun des deux ne peut tomber
--    seul.
--
-- CE QUI RESTE OUVERT, ET C'EST DIT : `DROP SCHEMA public, audit_guard CASCADE`
-- en UNE seule instruction emporte les deux declencheurs avant qu'aucun ne
-- s'execute. Ce geste detruit la base applicative entiere, exige d'etre
-- proprietaire des deux schemas, et c'est le meme niveau de privilege que
-- l'echappatoire deja documentee par la 120 (`ALTER EVENT TRIGGER … DISABLE`,
-- reservee au superutilisateur). La console SQL, elle, refuse les deux :
-- SqlConsoleService refuse DROP SCHEMA public, DROP SCHEMA audit_guard, toute
-- ecriture sur le registre, et la redefinition des fonctions nommees ici.
--
-- POINT DE RESTAURATION : le retour arriere de la console leve les DEUX
-- declencheurs d'evenement autour de `pg_restore --clean` (SqlConsoleService
-- ._setDropGuard) et les repose dans un `finally`. Sans cela, la seconde garde
-- ferait echouer la restauration a mi-chemin.
--
-- PRIVILEGES : identique a la 120. `CREATE EVENT TRIGGER` exige le
-- superutilisateur et l'installeur applique les migrations sous le role
-- applicatif ; tout le bloc privilegie est donc a rattrapage d'exception et pose
-- un AVERTISSEMENT nomme plutot que de faire echouer l'installation.
--
-- Idempotente : sure a rejouer.

-- A) Le registre en ajout seul ------------------------------------------------
DO $registry$
BEGIN
    IF to_regclass('audit_guard.append_only_registry') IS NULL THEN
        RAISE WARNING 'audit_guard.append_only_registry absent : la migration 120 n''a pas pu s''appliquer sous ce role. Rien a faire ici.';
        RETURN;
    END IF;

    CREATE OR REPLACE FUNCTION audit_guard.block_registry_mutation() RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
    BEGIN
        RAISE EXCEPTION 'IMMUTABLE_TABLE: audit_guard.append_only_registry is append-only (% refused) — it is the list that refuses a DROP on the audit trail', TG_OP
            USING ERRCODE = 'check_violation';
    END;
    $fn$;

    COMMENT ON FUNCTION audit_guard.block_registry_mutation() IS
        'Refuse DELETE / UPDATE / TRUNCATE sur le registre des tables en ajout seul. INSERT reste permis : le registre ne fait que grandir.';

    DROP TRIGGER IF EXISTS trg_registry_immutable ON audit_guard.append_only_registry;
    CREATE TRIGGER trg_registry_immutable
        BEFORE DELETE OR UPDATE ON audit_guard.append_only_registry
        FOR EACH ROW EXECUTE FUNCTION audit_guard.block_registry_mutation();

    DROP TRIGGER IF EXISTS trg_registry_no_truncate ON audit_guard.append_only_registry;
    CREATE TRIGGER trg_registry_no_truncate
        BEFORE TRUNCATE ON audit_guard.append_only_registry
        FOR EACH STATEMENT EXECUTE FUNCTION audit_guard.block_registry_mutation();

EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'REGISTRE NON VERROUILLE : le role % n''a pas le privilege requis sur audit_guard. Rejouer db/postgres/124_audit_guard_self_protection.sql connecte en superutilisateur. Detail : %',
            current_user, SQLERRM;
END
$registry$;

-- B) La garde croisee, dans public --------------------------------------------
DO $cross$
BEGIN
    CREATE OR REPLACE FUNCTION public.block_audit_guard_drop() RETURNS event_trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $evt$
    DECLARE
        obj record;
    BEGIN
        FOR obj IN SELECT object_type, object_identity FROM pg_event_trigger_dropped_objects()
        LOOP
            -- Aucun catalogue n'est lu : ce test doit tenir alors meme que le
            -- schema vise vient de disparaitre.
            IF (obj.object_type = 'schema' AND obj.object_identity = 'audit_guard')
               OR (obj.object_type = 'table' AND obj.object_identity = 'audit_guard.append_only_registry')
               OR (obj.object_type = 'function' AND obj.object_identity LIKE 'audit_guard.%')
               OR (obj.object_type = 'event trigger'
                   AND obj.object_identity IN ('trg_block_append_only_drop', 'trg_sync_append_only_registry')) THEN
                RAISE EXCEPTION 'IMMUTABLE_TABLE: % is part of the append-only guard and cannot be dropped', obj.object_identity
                    USING ERRCODE = 'check_violation',
                          HINT = 'Le retour arriere de la console SQL leve cette garde le temps de pg_restore et la repose. A la main : ALTER EVENT TRIGGER trg_block_audit_guard_drop DISABLE;';
            END IF;
        END LOOP;
    END;
    $evt$;

    COMMENT ON FUNCTION public.block_audit_guard_drop() IS
        'Declencheur d''evenement croise : vit dans public pour survivre a DROP SCHEMA audit_guard CASCADE — mesure, la garde de audit_guard tombait avec le schema et ne se declenchait jamais.';

    DROP EVENT TRIGGER IF EXISTS trg_block_audit_guard_drop;
    CREATE EVENT TRIGGER trg_block_audit_guard_drop
        ON sql_drop
        EXECUTE FUNCTION public.block_audit_guard_drop();

EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'GARDE CROISEE NON INSTALLEE : le role % n''a pas le privilege requis (CREATE EVENT TRIGGER exige le superutilisateur). La console SQL refuse toujours ce DDL cote application. Rejouer db/postgres/124_audit_guard_self_protection.sql en superutilisateur. Detail : %',
            current_user, SQLERRM;
END
$cross$;

-- C) …et la garde de audit_guard rend la pareille -------------------------------
-- Elle refusait deja la suppression de son schema et de son registre. Elle refuse
-- desormais aussi celle de la fonction croisee et du schema public, pour qu'aucun
-- des deux schemas ne puisse tomber seul.
DO $mutual$
BEGIN
    -- MESURE DE L'INTEGRATEUR, 16/09/2026 : sans ce test, cette section levait
    -- `ERROR: schema "audit_guard" does not exist` (SQLSTATE 3F000) sur toute base
    -- ou la 120 s'est enregistree SANS avoir pu creer son schema — c'est-a-dire
    -- toute base migree sous un role NON superutilisateur, ce que fait
    -- l'installeur. 3F000 n'est pas dans la liste des codes tolerees par le
    -- lanceur, et le gestionnaire ci-dessous ne rattrapait qu'insufficient_privilege :
    -- la migration entiere echouait, `db:migrate:all` sortait en 1 et l'installeur
    -- reculait le code par-dessus une base deja avancee. Les sections A et B (et la
    -- migration 122) portaient deja ce test ; celle-ci l'avait perdu.
    IF to_regnamespace('audit_guard') IS NULL THEN
        RAISE WARNING 'GARDE MUTUELLE : le schema audit_guard est absent (la migration 120 n''a pas pu s''appliquer sous ce role). Rien a faire ici ; rejouer 120 puis 124 connecte en superutilisateur.';
        RETURN;
    END IF;

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
            IF (obj.object_type = 'schema' AND obj.object_identity IN ('audit_guard', 'public'))
               OR (obj.object_type = 'table' AND obj.object_identity = 'audit_guard.append_only_registry')
               OR (obj.object_type = 'function' AND obj.object_identity LIKE 'public.block_audit_guard_drop%')
               OR (obj.object_type = 'event trigger' AND obj.object_identity = 'trg_block_audit_guard_drop') THEN
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
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'GARDE MUTUELLE NON POSEE : le role % n''a pas le privilege requis. Detail : %', current_user, SQLERRM;
    WHEN invalid_schema_name THEN
        -- Ceinture : le schema a disparu entre le test ci-dessus et cette instruction.
        RAISE WARNING 'GARDE MUTUELLE NON POSEE : le schema audit_guard est introuvable. Detail : %', SQLERRM;
END
$mutual$;
