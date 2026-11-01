-- Reverts 0051. Lossy on purpose: the saved templates and the evidence cards pinned to tickets and
-- incidents go away (the tool_execution audit rows stay). Apply 0051 again to start fresh.
DROP TABLE IF EXISTS evidence_card;
DROP TABLE IF EXISTS tool_template;
