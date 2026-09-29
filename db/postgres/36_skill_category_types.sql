-- ============================================================================
-- V3 skill category redesign — orthogonal "capability type" instead of a tag that
-- merely echoed the pillar. New types: Technical / Behavioral / Safety / Compliance
-- (the type describes the NATURE of the skill, independent of its pillar/sub-domain).
--
-- This migration relaxes the CHECK to a TRANSITIONAL union of old + new values so the
-- app boots cleanly whether the data has been re-categorized yet or not. The data
-- itself is migrated by scripts/v3-recategorize.js (idempotent). The legacy values
-- (HardSkills/SoftSkills/Cybersecurity) remain permitted but are no longer offered in
-- the UI; a later migration can tighten to the 4 new values once all data is confirmed.
-- ============================================================================
ALTER TABLE public.skills DROP CONSTRAINT IF EXISTS skills_category_check;
ALTER TABLE public.skills
    ADD CONSTRAINT skills_category_check
    CHECK (category IN ('Technical', 'Behavioral', 'Safety', 'Compliance',
                        'HardSkills', 'SoftSkills', 'Cybersecurity'));

-- New skills default to Technical (the broad execution type) rather than 'HardSkills'.
ALTER TABLE public.skills ALTER COLUMN category SET DEFAULT 'Technical';

INSERT INTO public.schema_meta(key, value) VALUES ('36_skill_category_types', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
