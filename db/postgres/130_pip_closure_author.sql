-- LOT talent (Ztalent-4) — LA CLOTURE D'UN PLAN D'AMELIORATION PORTE SON AUTEUR.
--
-- CE QUI A ETE MESURE, LE 17/09/2026, SUR LA BASE D'ESSAI, EN TRANSACTION ANNULEE :
--   PipService.close(#120, true) -> true
--   pips : {state closed_success, initiated_by 1 (compte systeme), approved_by NULL}
--   system_logs pour entity_id 120 : []
-- La table ne connaissait que deux auteurs, `initiated_by` et `approved_by`
-- (tous deux FK admins, alors que le proprietaire du plan est un MANAGER, donc
-- un EMPLOYE) ; la cloture — un verdict sur une personne, « atteint » ou
-- « non atteint » — n'etait attribuee a personne, ni sur la ligne ni au journal.
--
-- LA REGLE. Une cloture est un acte : elle porte QUI (`closed_by_ref`, de la
-- forme `<type>:<id>` — `employee:137` ou `admin:666` — le meme vocabulaire que
-- system_logs.actor_ref, sans cle etrangere puisque les deux espaces
-- d'identifiants se recouvrent) et QUAND (`closed_at`). Le journal en ajout
-- seul recoit en plus une ligne PIP_CLOSED avec actor_ref (PipService.close).
--
-- Les lignes deja closes restent a NULL : une absence de mesure n'est pas
-- inventee. Chaque instruction est idempotente ; le fichier se degrade
-- proprement sous un role ordinaire (proprietaire de la table).

ALTER TABLE pips ADD COLUMN IF NOT EXISTS closed_by_ref text;

ALTER TABLE pips ADD COLUMN IF NOT EXISTS closed_at timestamptz;

COMMENT ON COLUMN pips.closed_by_ref IS 'Who closed the plan, as <type>:<id> (employee:137 / admin:666) — same vocabulary as system_logs.actor_ref. NULL = closed before migration 130 (unknown), never "nobody".';

COMMENT ON COLUMN pips.closed_at IS 'When the plan was closed (met / not met). NULL for rows closed before migration 130.';
