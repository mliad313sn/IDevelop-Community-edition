-- 9-box disclosure (phase9i).
-- By default an employee may NOT see their own 9-box placement (it stays
-- confidential to the hierarchical superior). A manager can explicitly
-- "disclose" a specific approved evaluation so the employee can view ONLY
-- their own position. Default false preserves the prior confidentiality.
ALTER TABLE nine_box_evaluations
  ADD COLUMN IF NOT EXISTS disclosed_to_employee BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ninebox_disclosed
  ON nine_box_evaluations(employee_id, disclosed_to_employee)
  WHERE disclosed_to_employee = true;
