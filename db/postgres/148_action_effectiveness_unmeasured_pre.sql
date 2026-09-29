-- 3.23.17 — an IDP action closed on a skill that was NEVER assessed has no
-- "before" level. It used to be stored as 0, so the uplift was the whole
-- post-rating: absence of measurement recorded as a measured gain. The pre
-- rating and the uplift may now be NULL ("not measured"); AVG ignores them
-- and the dashboard counts such actions as unmeasured. Additive, idempotent.
ALTER TABLE action_effectiveness ALTER COLUMN rating_pre DROP NOT NULL;
ALTER TABLE action_effectiveness ALTER COLUMN uplift DROP NOT NULL;
