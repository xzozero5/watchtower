-- Reverts 0097. Lossy on purpose: procedures, versions and simulations go away, and every intent falls back
-- to the default runbook (the pointer is cleared first). ai_run keeps its rows; the column is dropped.
DELETE FROM role_permissions WHERE permission IN ('procedure.read', 'procedure.author', 'procedure.publish');
DELETE FROM permissions WHERE key IN ('procedure.read', 'procedure.author', 'procedure.publish');
DROP FUNCTION IF EXISTS public.retire_procedure_version(uuid, uuid);
DROP FUNCTION IF EXISTS public.publish_procedure_version(uuid, uuid);
DROP INDEX IF EXISTS ai_run_procedure_version_idx;
ALTER TABLE ai_run DROP COLUMN IF EXISTS procedure_version_id;
-- The pointer was written only by the functions; the application role gets its column back (as in 0007).
GRANT UPDATE (procedure_version_id) ON intent TO watchtower_app;
UPDATE intent SET procedure_version_id = NULL WHERE procedure_version_id IS NOT NULL;
DROP INDEX IF EXISTS intent_procedure_version_idx;
ALTER TABLE intent DROP CONSTRAINT IF EXISTS intent_procedure_version_fk;
-- Dropping the tables drops their triggers; the simulation table is append-only, so its truncate trigger
-- does not stand in the way of DROP.
ALTER TABLE procedure_version DROP CONSTRAINT IF EXISTS procedure_version_simulation_fk;
DROP TABLE IF EXISTS procedure_simulation;
DROP TABLE IF EXISTS procedure_version;
DROP TABLE IF EXISTS procedure;
DROP FUNCTION IF EXISTS public.procedure_simulation_apply();
DROP FUNCTION IF EXISTS public.procedure_simulation_bind();
DROP FUNCTION IF EXISTS public.procedure_version_reject_delete();
DROP FUNCTION IF EXISTS public.procedure_version_guard();
