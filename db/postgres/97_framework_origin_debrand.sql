-- ============================================================================
-- Normalize the capability-framework provenance values and seeded descriptions.
--
-- WHY. 33_v3_capability_framework.sql originally created role_families.origin /
-- skills.source with a customer-specific provenance token, plus customer-specific
-- description text on domains and role_families. Those values are not internal:
-- the Role Families sheet of the exported capability workbook prints `origin`
-- verbatim, the domain browser returns skill `source` to the client, and every
-- one of them is carried into the PostgreSQL snapshot bundled with the
-- installer. The neutral provenance token is 'standard'.
--
-- 33_* has been updated in place, so a FRESH install never creates the old
-- value and this migration is a no-op there. This is what carries an EXISTING
-- database across. Both paths converge on the same state.
--
-- REQUIRED, not cosmetic: the old CHECK constraint permits only the old token,
-- while scripts/v3-load-framework.js now writes 'standard'. Without this
-- migration the framework loader fails with a constraint violation on any
-- database created before it.
--
-- Matching is by VALUE COMPLEMENT rather than by the old literal: `origin` and
-- `source` are closed two-value sets (the framework token and 'legacy'), so
-- "everything that is not legacy" identifies the rows precisely without this
-- file having to restate the old token.
--
-- Idempotent: re-running is a no-op (the UPDATEs converge, the constraint is
-- dropped and recreated). No structural change: no table, column or index is
-- added, dropped or retyped.
-- ============================================================================

-- ---- role_families.origin --------------------------------------------------
-- Dropped FIRST: the pre-existing constraint does not permit 'standard', so the
-- UPDATE below would violate it while that constraint is still in force.
ALTER TABLE public.role_families DROP CONSTRAINT IF EXISTS role_families_origin_check;

UPDATE public.role_families SET origin = 'standard' WHERE origin <> 'legacy';

ALTER TABLE public.role_families ALTER COLUMN origin SET DEFAULT 'standard';

ALTER TABLE public.role_families
    ADD CONSTRAINT role_families_origin_check CHECK (origin IN ('standard','legacy'));

-- ---- skills.source ---------------------------------------------------------
-- No CHECK constraint on this column; same closed-set reasoning as above.
UPDATE public.skills SET source = 'standard' WHERE source <> 'legacy';

-- ---- Seeded description / definition text -----------------------------------
-- These strings are written by scripts/v3-load-framework.js and by the framework
-- seed data, both of which now emit the neutral wording. Each predicate is
-- narrow enough to leave anything a customer has edited untouched:
--   - only the 6 pillar rows carry a description ending in 'Pillar'
--     (the 49 legacy section rows have description IS NULL);
--   - only the seeded role-family rows end in 'department / section';
--   - only the seeded sub-domain definition opens 'Demonstrate <word> values'.
UPDATE public.domains
   SET description = 'Capability Pillar'
 WHERE description LIKE '%Pillar'
   AND description <> 'Capability Pillar';

UPDATE public.role_families
   SET description = 'Department / section'
 WHERE description LIKE '%department / section'
   AND description <> 'Department / section';

UPDATE public.sub_domains
   SET definition = regexp_replace(definition, '^Demonstrate [A-Za-z]+ values',
                                   'Demonstrate organizational values')
 WHERE definition ~ '^Demonstrate [A-Za-z]+ values'
   AND definition !~ '^Demonstrate organizational values';

INSERT INTO public.schema_meta(key, value) VALUES ('97_framework_origin_debrand', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
