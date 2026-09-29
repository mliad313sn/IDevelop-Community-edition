-- Reviewers / coaches / signers may be either employees (`employees.id`) or
-- admins (`admins.id`). The original V2 schema FK'd these columns to employees,
-- which prevented admins from acting as reviewer or coach. We relax the FKs
-- to plain BIGINT — application code enforces validity at the route layer.

BEGIN;

ALTER TABLE talent_ratings DROP CONSTRAINT IF EXISTS talent_ratings_reviewer_id_fkey;
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS coaching_sessions_coach_id_fkey;
ALTER TABLE coaching_signoffs DROP CONSTRAINT IF EXISTS coaching_signoffs_user_id_fkey;
ALTER TABLE idp_signoffs      DROP CONSTRAINT IF EXISTS idp_signoffs_user_id_fkey;
ALTER TABLE review_signatures DROP CONSTRAINT IF EXISTS review_signatures_user_id_fkey;
ALTER TABLE supervisor_reviews DROP CONSTRAINT IF EXISTS supervisor_reviews_reviewed_by_fkey;

INSERT INTO schema_meta(key, value) VALUES ('08_relax_reviewer_fks', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
