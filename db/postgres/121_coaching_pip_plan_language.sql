-- =====================================================================
-- le plan de coaching que le produit écrit lui-même
-- doit être lisible par la personne à qui il s'adresse.
--
-- Le plan créé à côté du PIP était rédigé en ANGLAIS SEUL, quelle que soit la
-- langue de la session : titre « Coaching to support PIP », objectif « Improve
-- performance and close the skill gaps identified in the PIP. » et les cinq
-- actions que le collaborateur coche (« Develop "…" from level 1 to 4 »).
-- Mesuré avant correction sur la base d'essai : GET /api/coaching/mine en
-- français puis en anglais rendait des octets IDENTIQUES ; GET
-- /employee/my-coaching servait 46 573 octets sous <html lang="fr"> avec la
-- phrase anglaise dedans. Aucune de ces phrases n'existait dans locales/ :
-- c'étaient des littéraux figés en base par le code, pas un repli sur clé
-- manquante.
--
-- Le code est corrigé (src/services/DevelopmentTriggerService.js écrit désormais
-- dans la langue de la personne). Un correctif de code ne répare PAS les lignes
-- déjà écrites : cette migration s'en charge.
--
-- CE QUI EST RÉÉCRIT, ET RIEN D'AUTRE
-- -----------------------------------
-- Uniquement les littéraux PRODUITS PAR LA MACHINE, reconnus par une
-- correspondance ANCRÉE (^…$) sur la forme exacte que le code émettait, et
-- uniquement sur les plans de contexte « pip » portant le titre machine. Une
-- ligne retouchée par un humain ne correspond pas et n'est pas touchée.
-- Rien n'est supprimé : c'est une réécriture de texte, sur place.
-- La migration est idempotente : rejouée, elle ne trouve plus rien à réécrire.
--
-- NOTE D'HONNÊTETÉ, conservée dans la traduction : certaines lignes anciennes
-- disent « from level null ». Elles ne
-- deviennent PAS « du niveau null » : elles prennent la forme « niveau actuel
-- non évalué », qui est ce que la donnée dit réellement. Une absence de mesure
-- ne se rend jamais comme une valeur.
-- =====================================================================

BEGIN;

-- 1) Les ACTIONS d'abord : elles se reconnaissent par le titre ANGLAIS encore
--    en place sur le plan parent, donc avant l'étape 2.

-- 1a) « Develop "X" from level null to N »  -> niveau de départ non mesuré.
UPDATE coaching_plan_actions a
   SET description = 'Atteindre le niveau '
                     || substring(a.description from '^Develop ".+" from level null to (\d+)$')
                     || ' en « '
                     || substring(a.description from '^Develop "(.+)" from level null to \d+$')
                     || ' » (niveau actuel non évalué)'
  FROM coaching_plans p
 WHERE p.id = a.plan_id
   AND p.context_type = 'pip'
   AND p.title = 'Coaching to support PIP'
   AND a.description ~ '^Develop ".+" from level null to \d+$';

-- 1b) « Develop "X" from level C to R »  -> niveau de départ mesuré.
UPDATE coaching_plan_actions a
   SET description = 'Développer « '
                     || substring(a.description from '^Develop "(.+)" from level \d+ to \d+$')
                     || ' » du niveau '
                     || substring(a.description from '^Develop ".+" from level (\d+) to \d+$')
                     || ' au niveau '
                     || substring(a.description from '^Develop ".+" from level \d+ to (\d+)$')
  FROM coaching_plans p
 WHERE p.id = a.plan_id
   AND p.context_type = 'pip'
   AND p.title = 'Coaching to support PIP'
   AND a.description ~ '^Develop ".+" from level \d+ to \d+$';

-- 1c) « Reach level N in "X" (current level not assessed) » (forme déjà honnête).
UPDATE coaching_plan_actions a
   SET description = 'Atteindre le niveau '
                     || substring(a.description from '^Reach level (\d+) in ".+" \(current level not assessed\)$')
                     || ' en « '
                     || substring(a.description from '^Reach level \d+ in "(.+)" \(current level not assessed\)$')
                     || ' » (niveau actuel non évalué)'
  FROM coaching_plans p
 WHERE p.id = a.plan_id
   AND p.context_type = 'pip'
   AND p.title = 'Coaching to support PIP'
   AND a.description ~ '^Reach level \d+ in ".+" \(current level not assessed\)$';

-- 2) L'OBJECTIF, puis le TITRE (le titre sert de discriminant ci-dessus).
UPDATE coaching_plans
   SET objective = 'Améliorer la performance et combler les écarts de compétences identifiés dans le plan de performance.'
 WHERE context_type = 'pip'
   AND title = 'Coaching to support PIP'
   AND objective = 'Improve performance and close the skill gaps identified in the PIP.';

UPDATE coaching_plans
   SET title = 'Coaching d’accompagnement du plan de performance'
 WHERE context_type = 'pip'
   AND title = 'Coaching to support PIP';

COMMIT;
