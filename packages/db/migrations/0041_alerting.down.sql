-- Reverts 0041. Lossy on purpose: every alert, its events, the service catalog and the escalation
-- policies go away. Nothing else references them yet (alert.incident_id has no foreign key).
DROP TABLE IF EXISTS alert_event;
DROP TABLE IF EXISTS alert;
DROP TABLE IF EXISTS service;
DROP TABLE IF EXISTS escalation_policy;
