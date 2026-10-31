-- Reverts 0007. Lossy on purpose: the stage history, the pin flags and the switch state are
-- dropped, and the application role gets table-level UPDATE on intent back. The old CHECK
-- (0..4) is restored; stages stay as they are.
UPDATE permissions
   SET description = 'Change AI autonomy stage per intent, up to stage 3'
 WHERE key = 'ai.autonomy.set';
-- Back to the 0002 body and no fixed search_path on the older functions.
CREATE OR REPLACE FUNCTION ticket_reject_parent_cycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ancestor uuid := NEW.parent_ticket_id;
  depth integer := 0;
BEGIN
  WHILE ancestor IS NOT NULL LOOP
    IF ancestor = NEW.id THEN
      RAISE EXCEPTION 'ticket % would become its own ancestor', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    depth := depth + 1;
    IF depth > 50 THEN
      RAISE EXCEPTION 'ticket parent chain is too deep'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_ticket_id INTO ancestor FROM ticket WHERE id = ancestor;
  END LOOP;
  RETURN NEW;
END
$$;
ALTER FUNCTION enforce_unique_array_elements() RESET search_path;
ALTER FUNCTION reject_mutation() RESET search_path;
DROP FUNCTION IF EXISTS set_ai_switch(text, boolean, uuid, text);
DROP FUNCTION IF EXISTS set_intent_autonomy(uuid, smallint, boolean, uuid, text);
DROP TABLE IF EXISTS ai_switch;
DROP TABLE IF EXISTS intent_autonomy_history;
GRANT UPDATE ON intent TO watchtower_app;
ALTER TABLE intent DROP COLUMN IF EXISTS autonomy_pinned;
ALTER TABLE intent DROP CONSTRAINT IF EXISTS intent_autonomy_phase1_check;
ALTER TABLE intent ADD CONSTRAINT intent_autonomy_check CHECK (autonomy_stage BETWEEN 0 AND 4);
