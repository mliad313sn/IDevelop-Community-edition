-- ============================================================================
-- per-sub-domain skill lookup index. Non-unique by design — a handful of
-- legacy capability items share a name within a sub-domain because they came
-- from different sections (now different role families) and keep separate
-- assessment history. Hard uniqueness would destroy that provenance, so we
-- index (not constrain) the pair.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_skills_subdomain_name ON public.skills (sub_domain_id, lower(name));

INSERT INTO public.schema_meta(key, value) VALUES ('34_v3_skill_subdomain_index', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
