-- Reverts 0044. Lossy on purpose: incidents, their timeline (every monthly partition) and the deploy
-- feed go away; tickets and alerts lose their incident link but are otherwise untouched. incident_timeline
-- is append-only for the application; dropping the table is the one way to remove its rows.
ALTER TABLE alert DROP CONSTRAINT IF EXISTS alert_incident_fk;
DROP INDEX IF EXISTS alert_incident_idx;
UPDATE alert SET incident_id = NULL WHERE incident_id IS NOT NULL;
ALTER TABLE ticket DROP CONSTRAINT IF EXISTS ticket_incident_fk;
DROP INDEX IF EXISTS ticket_incident_idx;
UPDATE ticket SET incident_id = NULL WHERE incident_id IS NOT NULL;
DROP TABLE IF EXISTS deploy;
DROP TABLE IF EXISTS incident_timeline CASCADE;
DROP TABLE IF EXISTS incident_org;
DROP TABLE IF EXISTS incident_service;
DROP TABLE IF EXISTS incident;
