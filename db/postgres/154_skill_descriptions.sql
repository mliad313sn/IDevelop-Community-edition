-- 154 — Self-assessment: understand what you rate (release 3.23.21, D11)
--
--   * skills.description stays the FRENCH text; skills.description_en is added.
--     Both capped at 2000 characters (CHECK … NOT VALID: new writes are held to
--     the cap, existing rows are never rejected retroactively).
--   * proficiency_descriptors gains anchor_en; both anchors capped at 600
--     characters. Duplicate anchors (same skill+level, or same category+level
--     for a category row) are repaired BEFORE the unique indexes are ensured —
--     the oldest row of a duplicate group is kept.
--   * skill_description_proposals — draft descriptions (starter pack or HR).
--     Employees NEVER read this table; approving copies the text into
--     skills.description / description_en (application side, audited).
--     One OPEN proposal per skill at most.
--   * SEED: the 20 generic CATEGORY anchors (levels 0-4 × Technical, Behavioral,
--     Safety, Compliance — the values stored in skills.category), FR + EN,
--     inserted only where no category row exists for that (category, level).
--
-- Additive and idempotent. No skill is added or removed.

-- ---------------------------------------------------------------------------
-- skills: English description + length caps
-- ---------------------------------------------------------------------------
ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS description_en text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_skills_description_len') THEN
        ALTER TABLE public.skills ADD CONSTRAINT chk_skills_description_len
            CHECK (description IS NULL OR char_length(description) <= 2000) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_skills_description_en_len') THEN
        ALTER TABLE public.skills ADD CONSTRAINT chk_skills_description_en_len
            CHECK (description_en IS NULL OR char_length(description_en) <= 2000) NOT VALID;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- proficiency_descriptors: English anchor, caps, duplicates repaired
-- ---------------------------------------------------------------------------
ALTER TABLE public.proficiency_descriptors ADD COLUMN IF NOT EXISTS anchor_en text;

-- Duplicate repair (a no-op wherever migration 32's unique indexes already
-- hold): an anchor row that duplicates an older one for the same key is a
-- configuration copy, never a record — the oldest one is kept.
DELETE FROM public.proficiency_descriptors p
 USING public.proficiency_descriptors q
 WHERE p.skill_id IS NOT NULL AND q.skill_id = p.skill_id
   AND q.level = p.level AND q.id < p.id;
DELETE FROM public.proficiency_descriptors p
 USING public.proficiency_descriptors q
 WHERE p.skill_id IS NULL AND q.skill_id IS NULL
   AND q.category = p.category AND q.level = p.level AND q.id < p.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_prof_desc_skill_level
    ON public.proficiency_descriptors (skill_id, level) WHERE skill_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prof_desc_cat_level
    ON public.proficiency_descriptors (category, level) WHERE skill_id IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prof_anchor_len') THEN
        ALTER TABLE public.proficiency_descriptors ADD CONSTRAINT chk_prof_anchor_len
            CHECK (char_length(anchor) <= 600) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prof_anchor_en_len') THEN
        ALTER TABLE public.proficiency_descriptors ADD CONSTRAINT chk_prof_anchor_en_len
            CHECK (anchor_en IS NULL OR char_length(anchor_en) <= 600) NOT VALID;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- skill_description_proposals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.skill_description_proposals (
    id          bigserial PRIMARY KEY,
    skill_id    bigint NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
    text_fr     text,
    text_en     text,
    source      text NOT NULL DEFAULT 'hr',
    status      text NOT NULL DEFAULT 'proposed',
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    decided_at  timestamptz,
    decided_by  bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    reason      text,
    CONSTRAINT chk_sdp_source CHECK (source IN ('starter', 'hr')),
    CONSTRAINT chk_sdp_status CHECK (status IN ('proposed', 'approved', 'rejected')),
    CONSTRAINT chk_sdp_text CHECK (coalesce(btrim(text_fr), '') <> '' OR coalesce(btrim(text_en), '') <> ''),
    CONSTRAINT chk_sdp_len CHECK (char_length(coalesce(text_fr, '')) <= 2000
                              AND char_length(coalesce(text_en, '')) <= 2000),
    CONSTRAINT chk_sdp_decided CHECK ((status = 'proposed') = (decided_at IS NULL)),
    CONSTRAINT chk_sdp_reject_reason CHECK (status <> 'rejected' OR coalesce(btrim(reason), '') <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sdp_open_per_skill
    ON public.skill_description_proposals (skill_id) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_sdp_status ON public.skill_description_proposals (status);

-- ---------------------------------------------------------------------------
-- SEED — the 20 generic category anchors (shown at once; PO decision)
-- ---------------------------------------------------------------------------
INSERT INTO public.proficiency_descriptors (skill_id, category, level, anchor, anchor_en)
SELECT NULL, v.category, v.level, v.fr, v.en
  FROM (VALUES
    ('Technical', 0, 'N''a pas encore pratiqué cette compétence et ne connaît pas encore ses règles de base.',
                     'Has not yet practised this skill and does not yet know its basic rules.'),
    ('Technical', 1, 'Connaît les notions de base et réalise des tâches simples sous supervision directe.',
                     'Knows the basics and carries out simple tasks under direct supervision.'),
    ('Technical', 2, 'Réalise les tâches courantes avec l''appui d''un collègue expérimenté ; demande conseil pour les cas inhabituels.',
                     'Carries out routine tasks with support from an experienced colleague; asks for advice on unusual cases.'),
    ('Technical', 3, 'Réalise sans aide les tâches courantes et inhabituelles, selon les règles, et résout les problèmes habituels.',
                     'Carries out routine and unusual tasks alone, to standard, and solves the usual problems.'),
    ('Technical', 4, 'Maîtrise la compétence, forme les autres et améliore les méthodes de travail.',
                     'Masters the skill, trains others and improves the working methods.'),

    ('Behavioral', 0, 'N''a pas encore montré ce comportement au travail.',
                      'Has not yet shown this behaviour at work.'),
    ('Behavioral', 1, 'Montre ce comportement de temps en temps, quand on le rappelle.',
                      'Shows this behaviour now and then, when reminded.'),
    ('Behavioral', 2, 'Montre ce comportement dans les situations habituelles, avec l''appui de son responsable.',
                      'Shows this behaviour in usual situations, with support from the manager.'),
    ('Behavioral', 3, 'Montre ce comportement spontanément, chaque jour, y compris sous pression.',
                      'Shows this behaviour unprompted, every day, including under pressure.'),
    ('Behavioral', 4, 'Sert d''exemple, aide les autres à progresser et fait évoluer les pratiques de l''équipe.',
                      'Is a role model, helps others improve and moves the team''s practices forward.'),

    ('Safety', 0, 'Ne connaît pas encore les règles de sécurité liées à cette compétence.',
                  'Does not yet know the safety rules for this skill.'),
    ('Safety', 1, 'Connaît les règles et les dangers principaux ; applique les consignes sous surveillance.',
                  'Knows the rules and the main hazards; follows instructions under supervision.'),
    ('Safety', 2, 'Applique les règles dans les situations habituelles ; demande de l''aide face à un risque inhabituel.',
                  'Applies the rules in usual situations; asks for help when facing an unusual risk.'),
    ('Safety', 3, 'Applique sans aide les règles en toute situation, repère les dangers et arrête le travail si nécessaire.',
                  'Applies the rules alone in every situation, spots hazards and stops work when needed.'),
    ('Safety', 4, 'Forme les autres, corrige les pratiques dangereuses sur le terrain et améliore les règles de sécurité.',
                  'Trains others, corrects unsafe practice on site and improves the safety rules.'),

    ('Compliance', 0, 'Ne connaît pas encore les exigences liées à cette compétence.',
                      'Does not yet know the requirements for this skill.'),
    ('Compliance', 1, 'Connaît les exigences principales ; les applique avec une vérification systématique.',
                      'Knows the main requirements; applies them with systematic checking.'),
    ('Compliance', 2, 'Applique les exigences dans les cas habituels ; vérifie auprès d''un référent en cas de doute.',
                      'Applies the requirements in usual cases; checks with a referent when in doubt.'),
    ('Compliance', 3, 'Applique sans aide les exigences, tient les preuves à jour et signale les écarts.',
                      'Applies the requirements alone, keeps the records up to date and reports deviations.'),
    ('Compliance', 4, 'Forme les autres, prépare les contrôles et fait évoluer les procédures.',
                      'Trains others, prepares for audits and improves the procedures.')
  ) AS v(category, level, fr, en)
ON CONFLICT (category, level) WHERE skill_id IS NULL DO NOTHING;
