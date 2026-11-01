-- Reverts 0010. Lossy on purpose: the AI audit trail (ai_run, with every monthly partition), the
-- latest-insight cache and the budget events go away. Tickets are not affected. Apply 0010 again
-- to start a fresh trail; dropping it for real is a retention decision, not a routine rollback.
DROP TABLE IF EXISTS ai_budget_event;
DROP TABLE IF EXISTS ai_ticket_insight;
DROP TABLE IF EXISTS ai_run;
