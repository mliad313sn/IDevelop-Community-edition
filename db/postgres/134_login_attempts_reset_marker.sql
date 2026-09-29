-- LOT donnees-base (ZDB-5) — login_attempts EN AJOUT SEUL : un succes n'efface
-- plus les echecs qui le precedent.
--
-- CE QUI A ETE MESURE, LE 17/09/2026, SUR LA BASE D'ESSAI, EN TRANSACTION ANNULEE :
--   3 x recordFailedAttempt(u)            -> 3 lignes successful=false
--   recordSuccessfulLogin(u) + clearFailedAttempts(u)  (rateLimiter.js, a CHAQUE
--   connexion reussie)                     -> 0 ligne successful=false
-- La trace d'une force brute ABOUTIE disparaissait au moment meme ou elle
-- devenait la plus precieuse : le panneau « comptes les plus attaques » et la
-- revue des acces lisaient une table dont les echecs anterieurs a tout succes
-- avaient ete supprimes.
--
-- LA REGLE. Le verrou se calcule sur une fenetre glissante DEPUIS LE DERNIER
-- SUCCES (ou le dernier deverrouillage administratif) ; rien n'a besoin d'etre
-- supprime pour lever le verrou. Le deverrouillage administratif, qui n'est pas
-- une connexion, s'inscrit comme une ligne de type 'reset' :
--   * kind = 'reset', successful = NULL, ip_address = NULL — invisible a tout
--     predicat `successful = true` (dernier login) comme `successful = false`
--     (echecs), donc aucun compteur existant ne le voit comme une connexion.
--   * 'login' reste la valeur par defaut : les lignes existantes sont inchangees.
--
-- Chaque instruction est idempotente ; le fichier se degrade proprement sous
-- un role ordinaire (proprietaire de la table, comme les migrations voisines).

ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'login';

ALTER TABLE login_attempts DROP CONSTRAINT IF EXISTS login_attempts_kind_check;

ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'reset'));

ALTER TABLE login_attempts ALTER COLUMN ip_address DROP NOT NULL;

ALTER TABLE login_attempts ALTER COLUMN successful DROP NOT NULL;

COMMENT ON COLUMN login_attempts.kind IS
    'login = tentative reelle (successful true/false) ; reset = deverrouillage administratif (successful NULL, ip NULL) — borne de la fenetre de verrou, jamais une connexion.';
