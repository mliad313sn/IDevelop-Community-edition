-- Per-admin workspace visibility overrides.
-- A JSONB "deviation map" of explicit show/hide decisions for dashboard tabs and
-- sidebar sections, e.g. { "tab:training": false, "nav:tools": true }.
--   • key present = explicit override (true=show, false=hide)
--   • key absent  = fall back to the permission-aware default (computed in code)
--   • {}          = every component follows its permission-aware default (no change)
-- Set by a SuperAdmin from the admin edit page; consulted for THAT admin's own
-- workspace when they sign in. Employees/managers are unaffected (admin-only).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS workspace_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
