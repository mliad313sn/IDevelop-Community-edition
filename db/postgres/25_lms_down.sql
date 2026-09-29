-- Down for 25_lms.sql (manual/dev use only). Note: does NOT revert the two
-- fn_* functions (they are backward-compatible supersets).
DROP TABLE IF EXISTS public.lms_completions;
DROP TABLE IF EXISTS public.lms_enrollments;
DROP TABLE IF EXISTS public.course_skill_map;
DROP TABLE IF EXISTS public.lms_courses;
DROP TABLE IF EXISTS public.lms_integrations;
DROP TYPE  IF EXISTS public.lms_enroll_status;
