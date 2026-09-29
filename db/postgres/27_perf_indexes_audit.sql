-- ============================================================================
-- Audit follow-up: indexes for hot lookup/filter columns that were doing
-- sequential scans. Additive & idempotent.
-- ============================================================================

-- NineBoxService queries events by employee; only evaluation_id was indexed.
CREATE INDEX IF NOT EXISTS idx_nine_box_events_employee
    ON public.nine_box_events (employee_id);

-- PipService / v2-pip filter by state across all employees (only employee_id
-- was indexed).
CREATE INDEX IF NOT EXISTS idx_pips_state
    ON public.pips (state);

-- The notification batch-send pass scans for queued rows; the only index was
-- on (user_type, user_id, read_at). Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_notifications_queued
    ON public.notifications (state) WHERE state = 'queued';
