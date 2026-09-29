-- 42_skill_name_unique.sql — prevent duplicate skills within a sub-domain.
-- Root cause of the 13 duplicate groups merged by scripts/v3-merge-duplicate-skills.js:
-- nothing enforced name uniqueness, so repeated imports accumulated same-name skills
-- that double-counted in radars/benchmark/capability rollups. Partial (active-only,
-- case-insensitive) so soft-retired duplicates and history are unaffected.
-- NOTE: intentionally fails if active duplicates still exist — run the merge first.

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_subdomain_name
    ON skills (sub_domain_id, lower(name)) WHERE is_active;

INSERT INTO schema_meta(key, value) VALUES ('42_skill_name_unique', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
