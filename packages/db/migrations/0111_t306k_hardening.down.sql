-- Reverts 0111: restores the 0110 body of record_ai_grade() and the 0108 body of record_autonomy_gate_report().
DROP TABLE ai_grade_sample_attempt;
DROP INDEX ai_grade_sampled_once_idx;
CREATE OR REPLACE FUNCTION public.record_ai_grade(
  p_ai_draft_id uuid,
  p_ticket_id uuid,
  p_phase text,
  p_graded_text text,
  p_grader_ai_run_id uuid,
  p_score numeric,
  p_passed boolean,
  p_violations jsonb,
  p_prompt_version integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  draft_ticket uuid;
  draft_run uuid;
  g_agent text;
  g_provider text;
  g_model text;
  g_ticket uuid;
  d_agent text;
  d_provider text;
  d_model text;
  d_ticket uuid;
  new_id uuid;
BEGIN
  SELECT d.ticket_id, d.ai_run_id INTO draft_ticket, draft_run FROM public.ai_draft AS d WHERE d.id = p_ai_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such draft' USING ERRCODE = 'P0002';
  END IF;
  IF draft_ticket IS DISTINCT FROM p_ticket_id THEN
    RAISE EXCEPTION 'ai_grade: the draft does not belong to this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p_grader_ai_run_id IS NULL OR draft_run IS NULL THEN
    RAISE EXCEPTION 'ai_grade: the grader run and the drafter run must both exist' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT r.agent, r.provider, coalesce(r.response_model, r.model), r.ticket_id INTO g_agent, g_provider, g_model, g_ticket
    FROM public.ai_run AS r WHERE r.id = p_grader_ai_run_id LIMIT 1;
  IF NOT FOUND OR g_agent <> 'grader' OR (g_ticket IS NOT NULL AND g_ticket <> p_ticket_id) THEN
    RAISE EXCEPTION 'ai_grade: the grader run is not a grader run of this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT r.agent, r.provider, coalesce(r.response_model, r.model), r.ticket_id INTO d_agent, d_provider, d_model, d_ticket
    FROM public.ai_run AS r WHERE r.id = draft_run LIMIT 1;
  IF NOT FOUND OR d_agent <> 'drafter' OR (d_ticket IS NOT NULL AND d_ticket <> p_ticket_id) THEN
    RAISE EXCEPTION 'ai_grade: the draft was not written by a drafter run of this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p_violations IS NULL OR pg_catalog.jsonb_typeof(p_violations) <> 'array' THEN
    RAISE EXCEPTION 'ai_grade: violations must be an array' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.ai_grade
    (ai_draft_id, ticket_id, phase, graded_text, grader_ai_run_id, grader_provider, grader_model,
     drafter_provider, drafter_model, score, passed, violations, violation_count, prompt_version, mock)
  VALUES
    (p_ai_draft_id, p_ticket_id, p_phase, p_graded_text, p_grader_ai_run_id, g_provider, g_model,
     d_provider, d_model, p_score, p_passed, p_violations, pg_catalog.jsonb_array_length(p_violations),
     p_prompt_version, g_provider = 'mock')
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;

CREATE OR REPLACE FUNCTION public.record_autonomy_gate_report(
  p_intent_id uuid,
  p_status text,
  p_trigger text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_metrics jsonb,
  p_criteria jsonb,
  p_seed_excluded boolean,
  p_generated_by uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  intent_created timestamptz;
  new_id uuid;
BEGIN
  SELECT i.created_at INTO intent_created FROM public.intent AS i WHERE i.id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such intent' USING ERRCODE = 'P0002';
  END IF;
  IF p_metrics IS NULL OR pg_catalog.jsonb_typeof(p_metrics) <> 'object' OR p_metrics = '{}'::jsonb THEN
    RAISE EXCEPTION 'a gate report carries its numbers: metrics cannot be empty' USING ERRCODE = 'check_violation';
  END IF;
  IF p_criteria IS NULL OR pg_catalog.jsonb_typeof(p_criteria) <> 'array' THEN
    RAISE EXCEPTION 'a gate report carries its criteria as an array' USING ERRCODE = 'check_violation';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_start < pg_catalog.date_trunc('milliseconds', intent_created) THEN
    RAISE EXCEPTION 'the window of a gate report cannot start before the intent existed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_window_end > pg_catalog.clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'the window of a gate report cannot end in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF p_status = 'green' AND (
       pg_catalog.jsonb_array_length(p_criteria) = 0
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(p_criteria) AS e
          WHERE pg_catalog.jsonb_typeof(e) <> 'object' OR COALESCE(e ->> 'pass', '') <> 'true'
       )
     ) THEN
    RAISE EXCEPTION 'a green gate report needs criteria that all pass' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.autonomy_gate_report
    (intent_id, status, trigger_kind, window_start, window_end, metrics, criteria, seed_excluded, generated_by)
  VALUES
    (p_intent_id, p_status, p_trigger, p_window_start, p_window_end, p_metrics, p_criteria, COALESCE(p_seed_excluded, false), p_generated_by)
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;
