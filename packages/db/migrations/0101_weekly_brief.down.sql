-- Reverts 0101. Lossy on purpose: the weekly briefs (drafts and published) go away.
DROP TRIGGER IF EXISTS weekly_brief_final_update ON weekly_brief;
DROP FUNCTION IF EXISTS weekly_brief_final();
DROP TABLE IF EXISTS weekly_brief;
