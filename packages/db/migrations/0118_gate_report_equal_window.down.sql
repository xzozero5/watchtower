-- Revert 0118: restore strict window_end > window_start and 0111 body of record_autonomy_gate_report().
-- Refuse rollback if equal-window rows exist (append-only evidence is never rewritten).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.autonomy_gate_report WHERE window_end = window_start) THEN
    RAISE EXCEPTION 'cannot rollback migration 0118: autonomy_gate_report contains equal-window rows';
  END IF;
END
$$;

ALTER TABLE public.autonomy_gate_report DROP CONSTRAINT autonomy_gate_report_window_check;
ALTER TABLE public.autonomy_gate_report ADD CONSTRAINT autonomy_gate_report_window_check
  CHECK (window_end > window_start);

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
