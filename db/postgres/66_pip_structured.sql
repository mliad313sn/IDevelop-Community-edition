-- 66_pip_structured.sql
-- Field right-sizing for PIPs: a defensible plan needs more than one free-text
-- line. Add the structured elements (objectives, measurable success criteria,
-- review checkpoints, support offered) as optional TEXT columns. Idempotent.

ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS objectives         text;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS success_criteria   text;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS review_checkpoints text;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS support_offered    text;
