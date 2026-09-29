-- ============================================================================
-- Phase 5 — LMS scheduled-sync cursors. Additive & idempotent.
-- ============================================================================
ALTER TABLE public.lms_integrations ADD COLUMN IF NOT EXISTS last_catalog_sync    timestamptz;
ALTER TABLE public.lms_integrations ADD COLUMN IF NOT EXISTS last_completion_sync timestamptz;
