-- Reverts 0063. Lossy on purpose: the stored snapshots go away; organization.health_score (a column of
-- migration 0002) keeps the last value it was given and is recomputed by the next run after a re-apply.
DROP TABLE IF EXISTS org_health_snapshot;
