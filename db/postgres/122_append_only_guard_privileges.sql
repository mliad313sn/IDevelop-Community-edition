-- INTEGRATION LA GARDE DDL NE DOIT PAS DESARMER LE ROLE APPLICATIF.
--
-- CE QUI A ETE MESURE, le 15/09/2026, sur la base d'essai, en transaction ANNULEE,
-- avec un role cree pour l'essai (CREATE ROLE ... LOGIN NOSUPERUSER ;
-- GRANT CREATE, USAGE ON SCHEMA public) — c'est-a-dire la forme exacte du role que
-- l'installeur cree et sous lequel l'application se connecte :
--
--   DROP TABLE <une table ORDINAIRE de public>   -> ERREUR
--        « permission denied for table append_only_registry »
--   CREATE TRIGGER <sur une table ordinaire>     -> ERREUR
--        « permission denied for schema audit_guard »
--
-- Les deux memes ordres passent en superutilisateur. La cause n'est donc pas la
-- REGLE posee par la migration 120 — elle est juste : une table en ajout seul ne
-- se supprime pas — mais ses PRIVILEGES. Les deux fonctions de declencheur
-- d'evenement s'executent avec les droits de CELUI QUI DECLENCHE le DDL, et non
-- de celui qui les a creees ; elles lisent `audit_guard.append_only_registry`,
-- table posee par le superutilisateur dans un schema sans aucun GRANT. Resultat :
-- tout DROP TABLE et tout CREATE TRIGGER du role applicatif echoue — y compris sur
-- une table qui n'a jamais eu le moindre rapport avec la piste d'audit.
--
-- POURQUOI CELA ATTEINT LE CLIENT SANS QU'IL FASSE QUOI QUE CE SOIT. La garde
-- n'arrive pas chez lui par la migration (qui, sous un role non superutilisateur,
-- avertit et poursuit) : elle arrive par l'INSTANTANE. L'empaquetage fait un
-- pg_dump de la base ENTIERE, l'instantane porte donc `CREATE SCHEMA audit_guard`
-- et les deux `CREATE EVENT TRIGGER`, et l'installeur l'importe en
-- superutilisateur. La boucle de re-attribution qui suit ne traite que le schema
-- `public` : `audit_guard` et ses fonctions restent la propriete du
-- superutilisateur, sans GRANT, pendant que l'application tourne sous le role
-- applicatif. La consequence pratique : la PREMIERE migration future qui supprime
-- une table ou cree un declencheur fait echouer la mise a jour du client.
--
-- CE QUE CETTE MIGRATION FAIT, ET RIEN DE PLUS :
--   1) les deux fonctions de declencheur d'evenement passent en SECURITY DEFINER,
--      avec un `search_path` fige — elles lisent donc le registre avec les droits
--      de leur proprietaire, quel que soit le role qui declenche le DDL ;
--   2) USAGE sur le schema et SELECT sur le registre sont accordes, en defense en
--      profondeur, pour que meme une lecture directe ne bute pas sur un privilege.
--
-- CE QU'ELLE NE FAIT PAS, VOLONTAIREMENT : elle n'accorde a personne le droit de
-- LEVER la garde. `ALTER EVENT TRIGGER ... DISABLE` exige toujours d'en etre
-- proprietaire, donc le retour arriere de la console SQL reste REFUSE sur une
-- installation ou le declencheur appartient a un autre role — il echoue FERME,
-- avec un message qui le dit, plutot que de laisser une base a moitie restauree.
-- Ouvrir ce chemin demande une fonction SECURITY DEFINER dediee et son propre
-- refus cote console : c'est une decision de conception, pas un correctif
-- d'integration. Elle est portee au compte rendu.
--
-- SECURITE — pourquoi SECURITY DEFINER est sur ici : les deux fonctions ne
-- prennent aucun argument, ne construisent aucun SQL dynamique, ne font que LIRE
-- un catalogue et le registre, et leur `search_path` est fige a
-- `pg_catalog, audit_guard, public` — aucun objet ne peut donc etre substitue par
-- un schema pose par l'appelant. EXECUTE sur la fonction de synchronisation est
-- retire a PUBLIC : seule la fonction de declencheur, qui appartient au meme
-- proprietaire, l'appelle.
--
-- Idempotente : sure a rejouer. Si le role qui joue cette migration n'est pas
-- proprietaire des objets, elle AVERTIT et poursuit, comme la 120.

DO $priv$
BEGIN
    IF to_regnamespace('audit_guard') IS NULL THEN
        RAISE NOTICE 'GARDE DDL absente (schema audit_guard non installe) : rien a durcir.';
        RETURN;
    END IF;

    -- 1) Les fonctions lisent le registre avec les droits de leur PROPRIETAIRE.
    ALTER FUNCTION audit_guard.sync_append_only_registry()
        SECURITY DEFINER SET search_path = pg_catalog, audit_guard, public;
    ALTER FUNCTION audit_guard.on_create_trigger()
        SECURITY DEFINER SET search_path = pg_catalog, audit_guard, public;
    ALTER FUNCTION audit_guard.block_append_only_drop()
        SECURITY DEFINER SET search_path = pg_catalog, audit_guard, public;

    -- La synchronisation ecrit dans le registre : elle n'est appelable que par son
    -- proprietaire et par le declencheur d'evenement qui lui appartient.
    REVOKE ALL ON FUNCTION audit_guard.sync_append_only_registry() FROM PUBLIC;

    -- 2) Defense en profondeur : lire le schema et le registre ne doit jamais
    --    couter un privilege a qui que ce soit. Le registre reste en AJOUT SEUL —
    --    aucun INSERT, UPDATE ni DELETE n'est accorde.
    GRANT USAGE ON SCHEMA audit_guard TO PUBLIC;
    GRANT SELECT ON audit_guard.append_only_registry TO PUBLIC;

EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'PRIVILEGES DE LA GARDE DDL NON DURCIS : le role % n''est pas proprietaire des objets audit_guard. Tant que ce n''est pas fait, le role applicatif ne peut ni supprimer une table ni creer un declencheur. Rejouer db/postgres/122_append_only_guard_privileges.sql connecte en superutilisateur. Detail : %',
            current_user, SQLERRM;
END
$priv$;
