-- cycle de vie des campagnes : arbitrages A5, A6, A8.
--
-- A5  Une campagne CLOSE peut être rouverte par le SuperAdmin, dans les 30 jours
--     suivant la clôture, avec un motif obligatoire, et la réouverture est tracée
--     comme une DÉROGATION. Au-delà de 30 jours : refus explicite.
--     Il fallait donc d'abord savoir QUAND une campagne a été close : la table ne
--     l'enregistrait nulle part (`updated_at` bouge à chaque écriture, il ne prouve
--     rien). `closed_at` est désormais posé par un TRIGGER à la transition vers
--     'closed', donc il ne peut plus être oublié par un chemin de code.
--
-- A6  La mesure hors campagne reste autorisée. Elle est datée et marquée « hors
--     campagne » — le marqueur durable est `self_assessments.cycle_id IS NULL` —
--     et elle n'entre JAMAIS dans un taux de complétion : v_cycle_participant_status
--     joint sur `sa.cycle_id = p.cycle_id`, et NULL ne joint jamais. Le commentaire
--     de colonne ci-dessous fixe la règle à l'endroit où elle s'applique.
--
-- A8  Une campagne dont l'échéance est dépassée est SIGNALÉE et PROPOSÉE à la
--     clôture après 21 jours — jamais fermée d'office. `cycle_closure_proposals`
--     porte la proposition (un enregistrement, jamais un effacement) : elle est
--     ouverte par le job, puis acceptée (clôture) ou déclinée (avec motif) par un
--     SuperAdmin. Le réglage `cycleAutoCloseGraceDays` ne ferme plus rien ; il
--     n'avance plus que la PROPOSITION, et le nouveau `cycleClosureProposalDays`
--     (21) le remplace.
--
-- Rien n'est supprimé ici : que des ajouts, tous idempotents.

-- ---------------------------------------------------------------------------
-- la date de clôture et la trace de dérogation
-- ---------------------------------------------------------------------------
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS closed_at                 timestamptz;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS reopen_override_at        timestamptz;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS reopen_override_by_admin_id bigint;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS reopen_override_reason    text;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS reopen_override_count     integer NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_cycles_reopen_override_admin_fkey') THEN
        ALTER TABLE assessment_cycles
            ADD CONSTRAINT assessment_cycles_reopen_override_admin_fkey
            FOREIGN KEY (reopen_override_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL;
    END IF;
END $$;

COMMENT ON COLUMN assessment_cycles.closed_at IS
    'A5 : horodatage de la transition vers « closed », posé par trigger. NULL sur une campagne close avant cette migration = date de clôture NON ENREGISTRÉE ; le délai de 30 jours ne peut alors pas être vérifié et la réouverture est refusée (on n''invente pas une date).';
COMMENT ON COLUMN assessment_cycles.reopen_override_reason IS
    'A5 : motif obligatoire de la réouverture d''une campagne CLOSE (dérogation). La réouverture ordinaire locked → open garde reopened_at / reopen_count.';

-- Le trigger : la date de clôture ne dépend plus du chemin de code qui ferme.
CREATE OR REPLACE FUNCTION set_cycle_closed_at() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
        NEW.closed_at := now();
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assessment_cycles_closed_at ON assessment_cycles;
CREATE TRIGGER trg_assessment_cycles_closed_at
    BEFORE UPDATE ON assessment_cycles
    FOR EACH ROW EXECUTE FUNCTION set_cycle_closed_at();

-- Reprise HONNÊTE des campagnes déjà closes : la seule source de vérité est le
-- journal d'audit. Une campagne close sans ligne d'audit garde closed_at = NULL
-- et sera refusée à la réouverture avec la phrase qui le dit.
UPDATE assessment_cycles c
   SET closed_at = l.at
  FROM (SELECT entity_id, MAX(created_at) AS at
          FROM system_logs
         WHERE entity_type = 'assessment_cycle'
           AND action IN ('cycle_closed_with_disposition', 'cycle_closed')
         GROUP BY entity_id) l
 WHERE l.entity_id = c.id AND c.status = 'closed' AND c.closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- la mesure hors campagne : marquée, datée, jamais dans un taux
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN self_assessments.cycle_id IS
    'Campagne de rattachement de la mesure. NULL = mesure HORS CAMPAGNE (A6) : autorisée, datée, marquée comme telle à l''affichage, et JAMAIS comptée dans un taux de complétion — v_cycle_participant_status joint sur sa.cycle_id = p.cycle_id, et un NULL ne joint jamais.';

-- ---------------------------------------------------------------------------
-- la proposition de clôture (jamais une clôture d'office)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cycle_closure_proposals (
    id              bigserial PRIMARY KEY,
    cycle_id        bigint      NOT NULL REFERENCES assessment_cycles(id) ON DELETE CASCADE,
    proposed_at     timestamptz NOT NULL DEFAULT now(),
    overdue_days    integer     NOT NULL,
    proposal_days   integer     NOT NULL,
    -- Instantané du reste à faire AU MOMENT de la proposition : une proposition
    -- que l'on relit dans un an doit dire sur quoi elle portait.
    snapshot        jsonb,
    state           text        NOT NULL DEFAULT 'open'
                                CHECK (state IN ('open', 'accepted', 'declined')),
    decided_at      timestamptz,
    decided_by_admin_id bigint  REFERENCES admins(id) ON DELETE SET NULL,
    decision_reason text,
    last_reminded_at timestamptz
);

-- Une seule proposition OUVERTE par campagne : le job en rafraîchit le rappel,
-- il n'en empile pas une par semaine. Les propositions décidées restent toutes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cycle_closure_proposal_open
    ON cycle_closure_proposals (cycle_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_cycle_closure_proposals_cycle
    ON cycle_closure_proposals (cycle_id, proposed_at DESC);

COMMENT ON TABLE cycle_closure_proposals IS
    'A8 : proposition de clôture d''une campagne en retard (après cycleClosureProposalDays jours, 21 par défaut). Le système PROPOSE, un SuperAdmin accepte (clôture) ou décline avec un motif. Aucune campagne n''est jamais fermée d''office. Rien n''est supprimé : une proposition déclinée reste.';

-- ---------------------------------------------------------------------------
-- Réglages
-- ---------------------------------------------------------------------------
INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('cycleClosureProposalDays', '21', 'number',
        'Jours après l''échéance avant qu''une clôture soit PROPOSÉE au super-administrateur (arbitrage A8 du 13/09/2026 : la clôture n''est jamais automatique). -1 = ne jamais proposer.',
        'jobs')
ON CONFLICT (setting_key) DO NOTHING;

-- L'ancien réglage ne ferme plus rien. Il n'est pas supprimé (règle maison) : il
-- reste lisible et sert de repli au délai de proposition quand il est positif.
UPDATE app_settings
   SET description = 'OBSOLÈTE depuis l''arbitrage A8 (13/09/2026) : une campagne n''est JAMAIS fermée d''office. La valeur ne sert plus que de repli au délai de PROPOSITION de clôture (voir cycleClosureProposalDays).'
 WHERE setting_key = 'cycleAutoCloseGraceDays';

INSERT INTO schema_meta(key, value) VALUES ('117_campaign_lifecycle_a5_a6_a8', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
