-- Down for 24_continuity.sql (manual/dev use only).
DROP VIEW  IF EXISTS public.v_continuity_coverage;
DROP TABLE IF EXISTS public.handover_items;
DROP TABLE IF EXISTS public.handover_plans;
DROP TABLE IF EXISTS public.retention_risk;
DROP TABLE IF EXISTS public.emergency_cover;
DROP TABLE IF EXISTS public.successors;
DROP TABLE IF EXISTS public.succession_plans;
DROP TABLE IF EXISTS public.role_criticality;
DROP TYPE  IF EXISTS public.handover_status;
DROP TYPE  IF EXISTS public.confidentiality_tier;
DROP TYPE  IF EXISTS public.risk_level;
DROP TYPE  IF EXISTS public.successor_source;
DROP TYPE  IF EXISTS public.readiness_band;
DROP TYPE  IF EXISTS public.continuity_plan_status;
