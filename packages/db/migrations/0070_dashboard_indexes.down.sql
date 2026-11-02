-- Reverts 0070. Lossless: only indexes go away.
DROP INDEX IF EXISTS ai_draft_resolved_idx;
DROP INDEX IF EXISTS csat_survey_sent_idx;
DROP INDEX IF EXISTS incident_started_idx;
DROP INDEX IF EXISTS alert_first_seen_idx;
DROP INDEX IF EXISTS ticket_resolved_idx;
