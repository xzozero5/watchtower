-- Reverts 0090. Lossy on purpose: conversations, proposals and cached summaries go away (the audit
-- log of what was confirmed stays, and so do the ai_run rows of the model calls).
DROP TABLE IF EXISTS ai_summary;
DROP TABLE IF EXISTS assistant_usage;
DROP TABLE IF EXISTS assistant_proposal;
DROP TABLE IF EXISTS assistant_message;
DROP TABLE IF EXISTS assistant_conversation;
