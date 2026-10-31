-- Reverts 0007. Lossy on purpose: the stage history, the pin flags and the switch state are
-- dropped, and the application role gets table-level UPDATE on intent back. The old CHECK
-- (0..4) is restored; stages stay as they are.
DROP FUNCTION IF EXISTS set_intent_autonomy(uuid, smallint, boolean, uuid, text);
DROP TABLE IF EXISTS ai_switch;
DROP TABLE IF EXISTS intent_autonomy_history;
GRANT UPDATE ON intent TO watchtower_app;
ALTER TABLE intent DROP COLUMN IF EXISTS autonomy_pinned;
ALTER TABLE intent DROP CONSTRAINT IF EXISTS intent_autonomy_phase1_check;
ALTER TABLE intent ADD CONSTRAINT intent_autonomy_check CHECK (autonomy_stage BETWEEN 0 AND 4);
