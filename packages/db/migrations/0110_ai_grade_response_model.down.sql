-- Restores the 0108 body of record_ai_grade() (reads ai_run.model only).
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
  SELECT r.agent, r.provider, r.model, r.ticket_id INTO g_agent, g_provider, g_model, g_ticket
    FROM public.ai_run AS r WHERE r.id = p_grader_ai_run_id LIMIT 1;
  IF NOT FOUND OR g_agent <> 'grader' OR (g_ticket IS NOT NULL AND g_ticket <> p_ticket_id) THEN
    RAISE EXCEPTION 'ai_grade: the grader run is not a grader run of this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT r.agent, r.provider, r.model, r.ticket_id INTO d_agent, d_provider, d_model, d_ticket
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
