-- Reverts 0102. Lossy on purpose: the drafts and the record of applied plans go away. The roster itself
-- (roster_entry) and the audit log keep what was applied.
DROP TABLE IF EXISTS roster_plan;
