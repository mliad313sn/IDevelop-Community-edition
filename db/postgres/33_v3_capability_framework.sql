-- ============================================================================
-- V3 Capability Framework (standardization). Additive & idempotent.
--
-- Re-bases the skill model on the standardized capability taxonomy:
--   Domain (Pillar)  ->  Sub-Domain (Competency Element)  ->  Skill / Capability Item
-- and introduces ROLE FAMILIES (the Department/Section dimension) so that skills
-- map directly to a role family — easing role creation. Legacy "sections" (the
-- old 49 domains) become role families of origin='legacy'; the 7 standard
-- departments become role families of origin='standard'.
--
-- The dashboard radar moves from per-skill to per-(domain, sub-domain): a new
-- view v_subdomain_capability backs the sub-domain axis; v_domain_capability is
-- left intact (skills are repointed to the 6 pillar domains by the seed loader,
-- so it naturally renders the 6 pillars).
--
-- This migration only creates structure. db/postgres/seed-data + the loader
-- script (scripts/v3-load-framework.js) populate the data.
-- ============================================================================

-- ---- Sub-Domains (Competency Elements) -------------------------------------
CREATE TABLE IF NOT EXISTS public.sub_domains (
    id          bigserial PRIMARY KEY,
    domain_id   bigint NOT NULL REFERENCES public.domains(id) ON DELETE CASCADE,
    name        text   NOT NULL,
    definition  text,
    position    integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sub_domains_domain_name_key UNIQUE (domain_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sub_domains_domain ON public.sub_domains (domain_id);

-- ---- Role Families (the Department/Section dimension) ----------------------
CREATE TABLE IF NOT EXISTS public.role_families (
    id          bigserial PRIMARY KEY,
    name        text   NOT NULL UNIQUE,
    origin      text   NOT NULL DEFAULT 'standard',   -- 'standard' (department) | 'legacy' (old section)
    description text,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT role_families_origin_check CHECK (origin IN ('standard','legacy'))
);

-- ---- Extend skills with the V3 hierarchy + provenance ----------------------
-- The legacy model made a skill unique within a (pillar) domain. In V3 a skill
-- name may legitimately recur across sub-domains of the same pillar, AND a few
-- same-named legacy items survive under one sub-domain because they came from
-- different sections (now distinct role families) and carry separate assessment
-- history. So the old hard constraint is dropped; a plain lookup index backs
-- per-sub-domain queries (see 34_v3_skill_subdomain_index.sql).
ALTER TABLE public.skills DROP CONSTRAINT IF EXISTS skills_domain_id_name_key;
ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS sub_domain_id  bigint REFERENCES public.sub_domains(id);
ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS strategic_link text;
ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'legacy'; -- 'standard' | 'legacy'
ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS is_duplicate   boolean NOT NULL DEFAULT false; -- legacy item judged to overlap a standard item
CREATE INDEX IF NOT EXISTS idx_skills_sub_domain ON public.skills (sub_domain_id);

-- ---- Skill <-> Role Family (many-to-many): "match skills directly to a role family"
CREATE TABLE IF NOT EXISTS public.skill_role_families (
    skill_id       bigint NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
    role_family_id bigint NOT NULL REFERENCES public.role_families(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_id, role_family_id)
);
CREATE INDEX IF NOT EXISTS idx_srf_role_family ON public.skill_role_families (role_family_id);

-- ---- Roles are created FROM a role family (ease creation) -------------------
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS role_family_id bigint REFERENCES public.role_families(id);
CREATE INDEX IF NOT EXISTS idx_roles_role_family ON public.roles (role_family_id);

-- ---- Sub-domain capability view (backs the new radar axis) ------------------
-- One row per (employee, assessed skill) carrying both pillar (domain) and
-- sub-domain, plus org dimensions for filtering — mirrors v_domain_capability.
DROP VIEW IF EXISTS public.v_subdomain_capability;
CREATE VIEW public.v_subdomain_capability AS
SELECT
    ra.employee_id,
    s.id   AS skill_id,   s.name AS skill_name,
    sd.id  AS sub_domain_id, sd.name AS sub_domain_name,
    d.id   AS domain_id,  d.name AS domain_name,
    COALESCE(s.category, 'Technical') AS category,
    ra.level,
    ed.site_id, ed.site_name,
    ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    ed.role_id, ed.role_name
FROM public.v_resolved_assessments ra
JOIN public.skills s        ON s.id = ra.skill_id
JOIN public.sub_domains sd  ON sd.id = s.sub_domain_id
JOIN public.domains d       ON d.id = sd.domain_id
JOIN public.v_employee_details ed ON ed.employee_id = ra.employee_id;

INSERT INTO public.schema_meta(key, value) VALUES ('33_v3_capability_framework', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
