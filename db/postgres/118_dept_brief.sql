-- 118 — Bilan de performance de département (dept-brief), lot B1.
--
-- 1) ARCHIVE + LEDGER. Cette table est le ledger exactement-une-fois ET le
--    livrable. Elle N'EST JAMAIS PURGÉE : reminder_log l'est à 180 jours
--    (telemetry-prune.js:58-64), ce qui ferait repartir un bilan ANNUEL six mois
--    après son envoi — indétectable en recette, il faut attendre 180 jours.
--    Le payload est GELÉ : la page le rend tel quel, elle ne recalcule pas (les
--    vues descendent de v_employee_details WHERE is_active, et
--    skill_assessments.assessed_at est muté sur place par trois chemins).
--    Le payload ne contient AUCUN nom : les noms sont ré-résolus à la lecture.
--    Le claim est l'INSERT ... ON CONFLICT DO NOTHING ... RETURNING id sur la
--    contrainte UNIQUE ci-dessous : atomique, donc immunisé au double leader.
CREATE TABLE IF NOT EXISTS public.dept_briefs (
    id              bigserial PRIMARY KEY,
    cadence         text NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly','yearly')),
    period          text NOT NULL,                -- 'YYYY-Www' | 'YYYY-MM' | 'YYYY-Qn' | 'YYYY'
    recipient_type  text NOT NULL CHECK (recipient_type IN ('admin','employee')),
    recipient_id    bigint NOT NULL,
    period_start    timestamptz NOT NULL,
    period_end      timestamptz NOT NULL,         -- borne EXCLUE
    scope_signature text NOT NULL,                -- sha256 des ids, ou 'unrestricted'
    scope_size      integer NOT NULL DEFAULT 0,
    is_empty        boolean NOT NULL DEFAULT false,
    computed_at     timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (cadence, period, recipient_type, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_dept_briefs_recipient
    ON public.dept_briefs (recipient_type, recipient_id, cadence, period_start DESC);

COMMENT ON TABLE public.dept_briefs IS
    'Bilan de département : ledger exactement-une-fois ET archive figée. JAMAIS purgée (un claim annuel doit survivre 12 mois ; reminder_log est purgé à 180 jours).';
COMMENT ON COLUMN public.dept_briefs.period_end IS
    'Borne HAUTE EXCLUE. L''affichage montre period_end - 1 jour avec la mention « inclus ».';
COMMENT ON COLUMN public.dept_briefs.scope_signature IS
    'SHA-256 hex de la liste TRIÉE des ids du périmètre, ou le littéral ''unrestricted''. Un Δ n''est publié que si deux bilans consécutifs portent la MÊME signature.';

-- 2) PRÉFÉRENCES DE CADENCE, par personne et par cadence.
--    Table DÉDIÉE, et surtout PAS une re-clé de digest_subscriptions : son
--    UNIQUE (subscriber_type, subscriber_id) est consommé par le ON CONFLICT de
--    POST /api/digest-subscriptions (routes/index.js) et par le db.get
--    mono-ligne de GET /api/digest-subscriptions/mine.
CREATE TABLE IF NOT EXISTS public.dept_brief_prefs (
    id             bigserial PRIMARY KEY,
    recipient_type text NOT NULL CHECK (recipient_type IN ('admin','employee')),
    recipient_id   bigint NOT NULL,
    cadence        text NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly','yearly')),
    enabled        boolean NOT NULL DEFAULT true,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recipient_type, recipient_id, cadence)
);

COMMENT ON TABLE public.dept_brief_prefs IS
    'Cadences choisies par destinataire. Absence de ligne = défaut du catalogue App Settings, jamais « refusé ».';

-- 3) CORRECTIF DE VUE — met_pct divisait par TOUTES les exigences requises au
--    lieu des exigences ÉVALUÉES. Mesuré sur la base de développement AVANT correctif :
--    Riverside/Internal Audit — 794 cellules requises, 0 ÉVALUÉE — était publié à
--    completion_pct = 0,0 ET met_pct = 0,0, c'est-à-dire un département JAMAIS
--    MESURÉ présenté comme « 0 % d'exigences atteintes ». Après correctif,
--    met_pct y vaut NULL (« — »), et les neuf autres départements passent de
--    « atteintes / requises » à « atteintes / ÉVALUÉES » (Riverside/IT : 72,4 →
--    76,7). Même calcul que DeptAnalyticsController.js:61.
--    `unmeasured_cells` est ajouté parce que c'est le chiffre qui rend le zéro
--    lisible : 794 requises, 0 évaluée, 794 non mesurées.
--    La liste de colonnes CHANGE (ajout + réordonnancement) : CREATE OR REPLACE
--    VIEW l'interdit, donc DROP + CREATE. `site_id` (première colonne de la vue
--    d'origine, db/postgres/55_*.sql:141) est CONSERVÉ — aucun consommateur
--    applicatif ne lit cette vue aujourd'hui (grep : docs et migrations
--    seulement), mais retirer une colonne publiée serait une régression
--    gratuite. Pas de CASCADE : si un objet en dépend un jour, le DROP doit
--    échouer bruyamment plutôt que l'emporter.
DROP VIEW IF EXISTS public.v_department_matrix_completion;
CREATE VIEW public.v_department_matrix_completion AS
SELECT g.site_id, g.site_name, g.department_name, g.department_id,
       COUNT(DISTINCT g.employee_id)::int                                   AS headcount,
       COUNT(*)::int                                                        AS required_cells,
       SUM(g.is_assessed)::int                                              AS assessed_cells,
       (COUNT(*) - SUM(g.is_assessed))::int                                 AS unmeasured_cells,
       ROUND(100.0 * SUM(g.is_assessed) / NULLIF(COUNT(*), 0), 1)           AS completion_pct,
       ROUND(100.0 * SUM(g.is_met)      / NULLIF(SUM(g.is_assessed), 0), 1) AS met_pct
  FROM public.v_employee_skill_gaps g
 GROUP BY g.site_id, g.site_name, g.department_name, g.department_id;

COMMENT ON VIEW public.v_department_matrix_completion IS
    'Complétion de matrice par département. met_pct = atteintes / ÉVALUÉES (jamais / requises) : un département sans aucune évaluation rend NULL, pas 0.';

INSERT INTO schema_meta(key, value) VALUES ('118_dept_brief', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
