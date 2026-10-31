-- T-112a: autonomy stage history, pin, the two global AI switches, and the Phase 1 stage ceiling
-- (ADR-011, PRD section 6.4, N3, po decision 23).
--   1. intent: CHECK autonomy_stage BETWEEN 0 AND 2 (was 0..4) and a `autonomy_pinned` flag.
--      The application role may no longer UPDATE autonomy_stage / autonomy_pinned directly: the only
--      way is set_intent_autonomy() below, which writes the history row in the same statement.
--   2. intent_autonomy_history: append-only record of who / when / why / from / to.
--   3. ai_switch: the two global switches. Rows are seeded here; the application role can only
--      UPDATE is_on, reason, changed_by, changed_at (never insert, delete or rename a switch).
--
-- HOW PHASE 3 LIFTS THE CEILING (not done here, and not by an agent): the owner decides to open
-- stage 3, an ADR supersedes ADR-011 section 2, and a NEW migration drops
-- intent_autonomy_phase1_check and adds a wider check (for example BETWEEN 0 AND 4), changes
-- set_intent_autonomy() and the domain constant PHASE_MAX_AUTONOMY_STAGE together, and the policy
-- gate gets an `ai_auto` rule that needs the grader. Until then every one of those layers says no.
--
-- A column added to intent later needs its own GRANT UPDATE (column list below is explicit).
-- Reversible: see 0007_autonomy_gate.down.sql.

-- 1. Phase 1 ceiling and pin flag.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM intent WHERE autonomy_stage > 2) THEN
    RAISE EXCEPTION 'migration 0007: an intent has autonomy_stage above 2; fix it (with the owner) before the Phase 1 ceiling'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
ALTER TABLE intent DROP CONSTRAINT intent_autonomy_check;
ALTER TABLE intent ADD CONSTRAINT intent_autonomy_phase1_check CHECK (autonomy_stage BETWEEN 0 AND 2);
ALTER TABLE intent ADD COLUMN autonomy_pinned boolean NOT NULL DEFAULT false;

-- The application role updates every intent column except the two that carry the autonomy state.
-- (Column-level GRANT only works after the table-level UPDATE is revoked.)
REVOKE UPDATE ON intent FROM watchtower_app, PUBLIC;
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'intent'
     AND column_name NOT IN ('autonomy_stage', 'autonomy_pinned');
  EXECUTE format('GRANT UPDATE (%s) ON intent TO watchtower_app', cols);
END
$$;

-- 2. History. No foreign key on changed_by, like audit_log.actor_id: the row must outlive the user.
CREATE TABLE intent_autonomy_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  change text NOT NULL,
  from_stage smallint NOT NULL,
  to_stage smallint NOT NULL,
  -- The pin state after this change.
  pinned boolean NOT NULL,
  reason text NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intent_autonomy_history_change_check CHECK (change IN ('stage', 'pin', 'unpin')),
  -- The log itself is wider than the Phase 1 ceiling, so lifting the ceiling never rewrites history.
  CONSTRAINT intent_autonomy_history_stage_check CHECK (
    from_stage BETWEEN 0 AND 4 AND to_stage BETWEEN 0 AND 4
  ),
  CONSTRAINT intent_autonomy_history_shape_check CHECK (
    (change = 'stage' AND from_stage <> to_stage) OR (change <> 'stage' AND from_stage = to_stage)
  ),
  CONSTRAINT intent_autonomy_history_reason_check CHECK (length(btrim(reason)) > 0)
);
CREATE INDEX intent_autonomy_history_intent_idx ON intent_autonomy_history (intent_id, changed_at DESC);

CREATE TRIGGER intent_autonomy_history_reject_update_delete
  BEFORE UPDATE OR DELETE ON intent_autonomy_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER intent_autonomy_history_reject_truncate
  BEFORE TRUNCATE ON intent_autonomy_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
-- The application role may only read this table: rows arrive through set_intent_autonomy().
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON intent_autonomy_history FROM watchtower_app, PUBLIC;
GRANT SELECT ON intent_autonomy_history TO watchtower_app;

-- 3. Global switches.
CREATE TABLE ai_switch (
  key text PRIMARY KEY,
  is_on boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_switch_key_check CHECK (key IN ('ai_stage_cap_pinned', 'ai_kill_switch')),
  -- Every flip carries a reason, whichever direction it goes.
  CONSTRAINT ai_switch_reason_check CHECK (changed_by IS NULL OR length(btrim(reason)) > 0)
);
INSERT INTO ai_switch (key) VALUES ('ai_stage_cap_pinned'), ('ai_kill_switch');
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ai_switch FROM watchtower_app, PUBLIC;
GRANT UPDATE (is_on, reason, changed_by, changed_at) ON ai_switch TO watchtower_app;

-- 4. The one door to an intent's autonomy state. SECURITY DEFINER: it runs as the schema owner, so
--    the application role needs no UPDATE on the two columns and no INSERT on the history.
--    Raises: WT001 the intent is pinned, WT002 raising a stage while the cap switch is on,
--    P0002 no such intent, 23514 empty reason or a stage outside the CHECK. Returns the number of
--    history rows written (0 = nothing to change).
CREATE FUNCTION set_intent_autonomy(
  p_intent_id uuid,
  p_stage smallint,
  p_pinned boolean,
  p_actor uuid,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  cur intent%ROWTYPE;
  new_stage smallint;
  new_pinned boolean;
  written integer := 0;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO cur FROM intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such intent' USING ERRCODE = 'P0002';
  END IF;
  new_stage := COALESCE(p_stage, cur.autonomy_stage);
  new_pinned := COALESCE(p_pinned, cur.autonomy_pinned);

  IF new_stage <> cur.autonomy_stage THEN
    IF cur.autonomy_pinned AND new_pinned THEN
      RAISE EXCEPTION 'the stage of this intent is pinned' USING ERRCODE = 'WT001';
    END IF;
    IF new_stage > cur.autonomy_stage
       AND (SELECT is_on FROM ai_switch WHERE key = 'ai_stage_cap_pinned') THEN
      RAISE EXCEPTION 'stages cannot be raised while the stage cap switch is on' USING ERRCODE = 'WT002';
    END IF;
    INSERT INTO intent_autonomy_history (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at)
    VALUES (cur.id, 'stage', cur.autonomy_stage, new_stage, new_pinned, btrim(p_reason), p_actor, clock_timestamp());
    written := written + 1;
  END IF;

  IF new_pinned <> cur.autonomy_pinned THEN
    INSERT INTO intent_autonomy_history (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at)
    VALUES (cur.id, CASE WHEN new_pinned THEN 'pin' ELSE 'unpin' END, new_stage, new_stage, new_pinned, btrim(p_reason), p_actor, clock_timestamp());
    written := written + 1;
  END IF;

  IF written > 0 THEN
    UPDATE intent
       SET autonomy_stage = new_stage, autonomy_pinned = new_pinned, updated_at = now()
     WHERE id = cur.id;
  END IF;
  RETURN written;
END
$$;
REVOKE ALL ON FUNCTION set_intent_autonomy(uuid, smallint, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_intent_autonomy(uuid, smallint, boolean, uuid, text) TO watchtower_app;
