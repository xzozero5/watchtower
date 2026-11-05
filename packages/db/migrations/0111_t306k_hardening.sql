-- T-306k (security re-review T-306j): C-11, C-18, C-19.
--
-- C-11  record_ai_grade(): the grader and the drafter are compared by the id the provider answered with only when
--       BOTH runs report one. When either side lacks it, all names of both sides (alias and id) are compared, and one
--       shared name is `independent = false` (`sonnet` with no id against `sonnet` + a dated id was true).
-- C-18  One `sampled` grade per draft at most (two workers could grade the same sent reply), and
--       ai_grade_sample_attempt: how often a sampled grade was tried and failed, so a failing one backs off and stops
--       instead of being retried on every event.
-- C-19  record_autonomy_gate_report(): a criterion passes only when `pass` is the JSON boolean true (the string
--       "true" passed before).
-- Reversible: 0111_t306k_hardening.down.sql restores the 0108/0110 bodies and drops the index and the table.
-- CREATE OR REPLACE keeps the grants.

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
  g_alias text;
  g_real text;
  g_ticket uuid;
  d_agent text;
  d_provider text;
  d_model text;
  d_alias text;
  d_real text;
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
  SELECT r.agent, r.provider, r.model, r.response_model, r.ticket_id INTO g_agent, g_provider, g_alias, g_real, g_ticket
    FROM public.ai_run AS r WHERE r.id = p_grader_ai_run_id LIMIT 1;
  IF NOT FOUND OR g_agent <> 'grader' OR (g_ticket IS NOT NULL AND g_ticket <> p_ticket_id) THEN
    RAISE EXCEPTION 'ai_grade: the grader run is not a grader run of this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT r.agent, r.provider, r.model, r.response_model, r.ticket_id INTO d_agent, d_provider, d_alias, d_real, d_ticket
    FROM public.ai_run AS r WHERE r.id = draft_run LIMIT 1;
  IF NOT FOUND OR d_agent <> 'drafter' OR (d_ticket IS NOT NULL AND d_ticket <> p_ticket_id) THEN
    RAISE EXCEPTION 'ai_grade: the draft was not written by a drafter run of this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- T-306k C-11: the models are compared by the id that answered only when BOTH runs report one. When either side
  -- lacks it, every name each side has (alias of the settings, reported id) is compared with every name of the other:
  -- one shared name means the same model under two names, so both are stored as that one name and `independent`
  -- is false (before, `sonnet` with no id against `sonnet` + a dated id came out true).
  IF g_real IS NOT NULL AND d_real IS NOT NULL THEN
    g_model := g_real;
    d_model := d_real;
  ELSIF g_alias = d_alias
     OR (g_real IS NOT NULL AND (g_real = d_alias OR g_real = d_real))
     OR (d_real IS NOT NULL AND d_real = g_alias) THEN
    g_model := d_alias;
    d_model := d_alias;
  ELSE
    g_model := coalesce(g_real, g_alias);
    d_model := coalesce(d_real, d_alias);
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
          WHERE pg_catalog.jsonb_typeof(e) <> 'object' OR pg_catalog.jsonb_typeof(e -> 'pass') IS DISTINCT FROM 'boolean' OR (e -> 'pass') <> 'true'::jsonb
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

CREATE UNIQUE INDEX ai_grade_sampled_once_idx ON ai_grade (ai_draft_id) WHERE phase = 'sampled';

CREATE TABLE ai_grade_sample_attempt (
  ai_draft_id uuid PRIMARY KEY REFERENCES ai_draft (id) ON DELETE RESTRICT,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_grade_sample_attempt_attempts_check CHECK (attempts >= 0)
);
