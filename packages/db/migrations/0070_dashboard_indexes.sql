-- T-206b: indexes for the ops dashboard read model (PRD section 9.1). Reversible: 0070_dashboard_indexes.down.sql.
--
-- The dashboard aggregates over a window of days. The columns it filters a window by had no index
-- (ticket.resolved_at, alert.first_seen_at, incident.started_at, csat_survey.sent_at, ai_draft.resolved_at);
-- without these each figure scans its whole table. Indexes only: no data, no constraint, no behaviour change.

CREATE INDEX IF NOT EXISTS ticket_resolved_idx ON ticket (resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_first_seen_idx ON alert (first_seen_at);
CREATE INDEX IF NOT EXISTS incident_started_idx ON incident (started_at DESC);
CREATE INDEX IF NOT EXISTS csat_survey_sent_idx ON csat_survey (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_draft_resolved_idx ON ai_draft (resolved_at) WHERE disposition IS NOT NULL;
