-- Maintenance: cancelling an assessment.
--
-- Adds ONLY the movement kind. It deliberately does NOT add a 'cancelled' state
-- to self_assessments, and that restraint is the whole design decision:
--
--   `workflow_state` is CHECK-constrained to draft|submitted|under_review|
--   changes_requested|reviewed|arbitration|approved|rejected, and `status` is the
--   enum `self_assessment_state`. Introducing a NEW terminal value would have to
--   be excluded again by every reader that filters NEGATIVELY — measured, there
--   are at least three:
--       IDPService                    ... AND sa.workflow_state <> 'rejected'
--       SelfAssessmentWorkflowService ... sa.workflow_state <> 'draft'
--       DeptAnalyticsController       ... NOT IN ('draft','changes_requested')
--   A new state would silently pass all three and reappear in IDP generation, the
--   review queue and the department completion percentage. Miss one reader and a
--   cancelled assessment goes on counting, which is precisely the "absence
--   presented as a result" class of defect this product keeps fixing.
--
--   So a maintenance cancellation reuses 'rejected', the terminal state every
--   reader ALREADY excludes, and the fact that it was a cancellation rather than
--   a reviewer's rejection is carried by the audit trail (system_logs
--   MAINT_CANCEL_ASSESSMENT + the movement row below), exactly as a cancelled
--   9-box position reuses 'archived'.
--
-- Idempotent: safe to re-run.

ALTER TABLE employee_movements DROP CONSTRAINT IF EXISTS employee_movements_kind_check;
ALTER TABLE employee_movements ADD CONSTRAINT employee_movements_kind_check
    CHECK (kind = ANY (ARRAY[
        'site', 'department', 'service', 'role', 'manager', 'supervisor', 'status',
        'plan_cancelled',        -- an IDP or PIP cancelled by maintenance
        'placement_cancelled',   -- a 9-box position cancelled by maintenance
        'assessment_cancelled'   -- a self-assessment cancelled by maintenance
    ]));
