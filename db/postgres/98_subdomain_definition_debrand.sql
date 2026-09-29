-- ============================================================================
-- Remove the customer's company name from the seeded sub-domain definition.
--
-- WHY 97 DID NOT CATCH THIS. Migration 97 de-branded the framework provenance
-- and description text, but it was written against the build guard's view of
-- the problem, and that guard matched only the customer's three-letter
-- ABBREVIATION (the literal is not repeated here, for the reason given below).
-- The customer's name spelled out in full appears nowhere in that pattern, so
-- one seeded sub_domains.definition survived every scan: the 'Contractor
-- compliance' definition named the customer where it should have said
-- 'company'. (The old value is deliberately NOT quoted here -- a de-branding
-- migration that restates the token would reintroduce it into every database
-- dump and fail the guard it exists to satisfy.)
--
-- It was present in the live and dev databases AND in the blank (community
-- edition that is supposed to carry framework content only) -- i.e. it would
-- ship to another company inside the bundled snapshot, describing that
-- company's contractor obligations in terms of a competitor's name. Build-
-- Package.ps1 has been extended to match the full name so this class cannot
-- recur silently.
--
-- Matching is by the SURROUNDING WORDING rather than by the customer name, so
-- this file does not itself reintroduce the token it exists to remove. The
-- predicate is narrow: only the seeded row uses this phrasing, and the
-- second clause makes re-running a no-op.
--
-- Idempotent. No structural change: no table, column, index or constraint is
-- added, dropped or retyped. A row a customer has since edited is left alone
-- unless it still carries the seeded phrasing.
-- ============================================================================

UPDATE public.sub_domains
   SET definition = 'Ensure contractor work meets legal, site and company requirements'
 WHERE definition LIKE 'Ensure contractor work meets legal, site and %requirements'
   AND definition <> 'Ensure contractor work meets legal, site and company requirements';

INSERT INTO public.schema_meta(key, value) VALUES ('98_subdomain_definition_debrand', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
