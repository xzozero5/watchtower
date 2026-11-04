-- T-306e (security review T-306a, C-4 and C-11, ADR-025 section 7).
--
-- 1. ai_run.response_model: the model id the provider answered with (the claude-cli bridge reports one when it can;
--    otherwise the adapter hands back the id it asked for). `model` stays the alias the settings named. The
--    independence of the grader is judged on the id that answered, not on the alias [UNVERIFIED 50%: what the
--    bridge reports for an alias].
-- 2. ai_replay_result: the outcome of a replay (the eval set, or a procedure simulation) of one set of drafter
--    model, grader model, prompt versions and procedure version of an intent. The gate reads the latest row of the
--    set in force; no row, or a failed one, suspends auto-send (`replay_missing`). It never rolls an intent back.
--    Append-only; the application role reads it and writes only through record_replay_result(), which wants a
--    person who holds ai.autonomy.promote. `passed` cannot be true for a mock run, an empty run, a run with a
--    violation or one whose redaction eval failed.
ALTER TABLE ai_run ADD COLUMN response_model text;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_response_model_check
  CHECK (response_model IS NULL OR char_length(response_model) BETWEEN 1 AND 200);

CREATE TABLE ai_replay_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  source text NOT NULL,
  -- The aliases the settings name (`ai_run.model`), so a replay and a later run line up.
  drafter_model text NOT NULL,
  grader_model text NOT NULL,
  drafter_prompt_version integer NOT NULL,
  grader_prompt_version integer NOT NULL,
  -- The published version of the intent's procedure the replay ran against; null: the intent has none.
  procedure_version_id uuid REFERENCES procedure_version (id) ON DELETE RESTRICT,
  case_count integer NOT NULL,
  violations integer NOT NULL,
  redaction_passed boolean NOT NULL,
  mock boolean NOT NULL DEFAULT false,
  passed boolean NOT NULL,
  -- No foreign key on people, like audit_log.actor_id: the record outlives the user.
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_replay_result_source_check CHECK (source IN ('eval', 'simulation')),
  CONSTRAINT ai_replay_result_models_check CHECK (
    char_length(drafter_model) BETWEEN 1 AND 200 AND char_length(grader_model) BETWEEN 1 AND 200
  ),
  CONSTRAINT ai_replay_result_versions_check CHECK (drafter_prompt_version >= 1 AND grader_prompt_version >= 1),
  CONSTRAINT ai_replay_result_counts_check CHECK (case_count >= 0 AND violations >= 0),
  CONSTRAINT ai_replay_result_passed_check CHECK (
    NOT passed OR (case_count >= 1 AND violations = 0 AND redaction_passed AND NOT mock)
  )
);
CREATE INDEX ai_replay_result_set_idx
  ON ai_replay_result (intent_id, drafter_model, grader_model, drafter_prompt_version, grader_prompt_version, created_at DESC);
CREATE TRIGGER ai_replay_result_reject_update_delete
  BEFORE UPDATE OR DELETE ON ai_replay_result
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ai_replay_result_reject_truncate
  BEFORE TRUNCATE ON ai_replay_result
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ai_replay_result FROM watchtower_app, PUBLIC;

CREATE FUNCTION public.record_replay_result(
  p_actor uuid,
  p_intent uuid,
  p_source text,
  p_drafter_model text,
  p_grader_model text,
  p_drafter_prompt_version integer,
  p_grader_prompt_version integer,
  p_procedure_version uuid,
  p_case_count integer,
  p_violations integer,
  p_redaction_passed boolean,
  p_mock boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF p_actor IS NULL OR NOT public.user_holds_permission(p_actor, 'ai.autonomy.promote') THEN
    RAISE EXCEPTION 'recording a replay result needs the permission ai.autonomy.promote'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.ai_replay_result (
    intent_id, source, drafter_model, grader_model, drafter_prompt_version, grader_prompt_version,
    procedure_version_id, case_count, violations, redaction_passed, mock, passed, recorded_by
  ) VALUES (
    p_intent, p_source, p_drafter_model, p_grader_model, p_drafter_prompt_version, p_grader_prompt_version,
    p_procedure_version, p_case_count, p_violations, p_redaction_passed, p_mock,
    (p_case_count >= 1 AND p_violations = 0 AND p_redaction_passed AND NOT p_mock), p_actor
  ) RETURNING id INTO new_id;
  RETURN new_id;
END
$$;
REVOKE ALL ON FUNCTION public.record_replay_result(uuid, uuid, text, text, text, integer, integer, uuid, integer, integer, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_replay_result(uuid, uuid, text, text, text, integer, integer, uuid, integer, integer, boolean, boolean) TO watchtower_app;

-- 3. instance_setting 'autosend.sampling': how many sent automatic replies are graded again (phase 'sampled'). The
--    first 20 after a promotion at 100%, then 20% [ASSUMED, owner]. A head edits it through the application, which
--    can only change `value`; the CHECK keeps it a sane object.
ALTER TABLE instance_setting ADD CONSTRAINT instance_setting_autosend_sampling_check CHECK (
  key <> 'autosend.sampling'
  OR (
    jsonb_typeof(value) = 'object'
    AND CASE WHEN jsonb_typeof(value -> 'initialCount') = 'number'
             THEN (value ->> 'initialCount')::numeric BETWEEN 0 AND 1000 AND (value ->> 'initialCount')::numeric = trunc((value ->> 'initialCount')::numeric)
             ELSE false END
    AND CASE WHEN jsonb_typeof(value -> 'initialPercent') = 'number'
             THEN (value ->> 'initialPercent')::numeric BETWEEN 0 AND 100 AND (value ->> 'initialPercent')::numeric = trunc((value ->> 'initialPercent')::numeric)
             ELSE false END
    AND CASE WHEN jsonb_typeof(value -> 'percent') = 'number'
             THEN (value ->> 'percent')::numeric BETWEEN 0 AND 100 AND (value ->> 'percent')::numeric = trunc((value ->> 'percent')::numeric)
             ELSE false END
  )
);
INSERT INTO instance_setting (key, value)
  VALUES ('autosend.sampling', jsonb_build_object('initialCount', 20, 'initialPercent', 100, 'percent', 20));
