-- Rollback for 12_ninebox.sql. Idempotent.
BEGIN;
DROP TABLE IF EXISTS nine_box_events;
DROP TABLE IF EXISTS nine_box_evaluations;
DELETE FROM schema_meta WHERE key='12_ninebox';
COMMIT;
