-- Reverts 0113. Lossy on purpose: the stored narrations of elements and the 'my_work' summaries go away (they are
-- caches; the facts are computed again on read, and the audit log and ai_run rows stay).
DELETE FROM ai_summary WHERE kind = 'my_work';
ALTER TABLE ai_summary DROP CONSTRAINT ai_summary_kind_check;
ALTER TABLE ai_summary ADD CONSTRAINT ai_summary_kind_check CHECK (kind IN ('brief', 'handoff'));
DROP TABLE IF EXISTS ai_element_insight;
