-- 64_idp_open_unique.sql — one OPEN Individual Development Plan per employee.
--
-- DevelopmentTriggerService._triggerBlue does a SELECT-then-INSERT with no DB-level
-- guard, so two concurrent 9-box "blue" approvals (or a double-clicked placement
-- override) could each insert a draft IDP + 5 objectives for the same person. This
-- mirrors uq_pip_open_per_employee (40_concurrency_unique.sql) for the IDP side.
--
-- Collapse any pre-existing duplicate open plans first (keep the most recent) so the
-- unique index can be built on historical data. 'archived' is a valid idp_status.
UPDATE public.idp_plans p
   SET status = 'archived', updated_at = now()
 WHERE p.status IN ('draft', 'active')
   AND p.id <> (
        SELECT q.id FROM public.idp_plans q
         WHERE q.employee_id = p.employee_id
           AND q.status IN ('draft', 'active')
         ORDER BY q.created_at DESC, q.id DESC
         LIMIT 1
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_idp_open_per_employee
    ON public.idp_plans (employee_id)
    WHERE status IN ('draft', 'active');
