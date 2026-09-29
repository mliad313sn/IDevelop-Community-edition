-- 155 — Safety-competency gate: rollout mode and rule options (3.23.21 F5/F6)
--
--   safety_gate_rules.mode              'observe' | 'enforce'. An observe rule is
--                                       computed and shown but does not close the
--                                       gate (the API answers cleared:true with
--                                       observe:true). Rules that EXIST when this
--                                       runs keep 'enforce' — their behaviour does
--                                       not change on upgrade; the column default
--                                       then becomes 'observe' for NEW rules.
--   safety_gate_rules.require_validated only a supervisor-validated level counts.
--   safety_gate_rules.max_age_months    a measurement older than this no longer
--                                       proves the level (NULL = no limit).
--   safety_gate_status.enforced_status  the answer over the ENFORCE rules alone:
--   safety_gate_status_history.enforced_status  drives cleared, webhook and
--                                       notifications. NULL on rows written before
--                                       this migration (every rule enforced then:
--                                       the plain status is the enforced one).
--
-- Additive and idempotent. Nothing is deleted.

ALTER TABLE safety_gate_rules ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'enforce';
ALTER TABLE safety_gate_rules ALTER COLUMN mode SET DEFAULT 'observe';
ALTER TABLE safety_gate_rules ADD COLUMN IF NOT EXISTS require_validated boolean NOT NULL DEFAULT false;
ALTER TABLE safety_gate_rules ADD COLUMN IF NOT EXISTS max_age_months smallint;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_safety_gate_rule_mode') THEN
        ALTER TABLE safety_gate_rules
            ADD CONSTRAINT chk_safety_gate_rule_mode CHECK (mode IN ('observe', 'enforce'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_safety_gate_rule_max_age') THEN
        ALTER TABLE safety_gate_rules
            ADD CONSTRAINT chk_safety_gate_rule_max_age
            CHECK (max_age_months IS NULL OR max_age_months BETWEEN 1 AND 120);
    END IF;
END $$;

ALTER TABLE safety_gate_status ADD COLUMN IF NOT EXISTS enforced_status text;
ALTER TABLE safety_gate_status_history ADD COLUMN IF NOT EXISTS enforced_status text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_safety_gate_status_enforced') THEN
        ALTER TABLE safety_gate_status
            ADD CONSTRAINT chk_safety_gate_status_enforced
            CHECK (enforced_status IS NULL
                   OR enforced_status IN ('CLEARED', 'BLOCKED', 'EXPIRING', 'NOT_CONFIGURED'));
    END IF;
END $$;
