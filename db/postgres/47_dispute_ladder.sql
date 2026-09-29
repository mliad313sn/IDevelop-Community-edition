-- 47: dispute ladder L0 → L1 → L2 (HR arbitration) with configurable SLAs.
--
-- L1 previously had no timeout, so an escalated dispute could sit forever if a
-- manager never resolved it (deadlocking cycle close). We add a THIRD level:
-- when L1 is overdue it escalates to L2 (HR arbitration); when L2 is overdue it
-- auto-finalizes with the supervisor's rating (opt-out via setting). HR is not a
-- separate user type — it is a local admin holding the new `arbitrate_disputes`
-- permission (catalog lives in src/config/permissions.js).

-- New enum members (PG 12+ allows ADD VALUE inside a tx; not used until commit).
ALTER TYPE public.dispute_level ADD VALUE IF NOT EXISTS 'L2';
ALTER TYPE public.dispute_state ADD VALUE IF NOT EXISTS 'auto_finalized';

-- HR arbiter is an admin, whose id lives in a different table than the
-- employee-scoped decided_by. Keep decided_by for employee (supervisor/manager)
-- decisions; add decided_by_admin_id for L2/HR decisions.
ALTER TABLE public.assessment_disputes
    ADD COLUMN IF NOT EXISTS decided_by_admin_id integer REFERENCES public.admins(id) ON DELETE SET NULL;

-- Configurable SLAs + auto-finalize toggle (category 'disputes').
INSERT INTO app_settings (setting_key, setting_value, setting_type, category, description) VALUES
    ('dispute.l0SlaDays', '5', 'number', 'disputes', 'Days an L0 dispute (employee ↔ supervisor) waits before auto-escalating to the manager (L1).'),
    ('dispute.l1SlaDays', '7', 'number', 'disputes', 'Days an L1 dispute (manager) waits before auto-escalating to HR arbitration (L2).'),
    ('dispute.l2SlaDays', '7', 'number', 'disputes', 'Days an L2 dispute (HR arbitration) waits before auto-finalizing with the supervisor''s rating (if enabled below).'),
    ('dispute.autoFinalizeOnExpiry', 'true', 'boolean', 'disputes', 'When an L2 dispute exceeds its SLA and no HR arbiter has decided, finalize it automatically with the supervisor''s rating so the assessment cycle can close. Turn off to leave overdue L2 disputes waiting for HR indefinitely.')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO schema_meta(key, value) VALUES ('47_dispute_ladder', 'applied')
ON CONFLICT (key) DO NOTHING;
