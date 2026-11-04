-- T-306f (security review T-306a, docs/decisions/T-306a-review.md): the findings that live in the schema.
--
--   C-5   sessions.step_up_at / step_up_method: the result of a step-up through Google OIDC (prompt=login,
--         max_age=300, auth_time checked by the api) is stored on the session that asked for it. A session
--         that was only created recently is no longer a re-authentication of the owner.
--   C-6   REVOKE INSERT on autonomy_gate_report: the report is written through record_autonomy_gate_report(),
--         which refuses empty metrics, a green report whose criteria do not all pass, and a window that
--         starts before the intent existed. promotion_blocker() refuses such a window as well
--         ('window_before_intent').
--   C-9   REVOKE INSERT on ai_grade: record_ai_grade() reads provider and model of the grader and of the
--         drafter from their ai_run rows (the caller no longer says which model it was; mock = provider
--         'mock'). REVOKE INSERT on procedure_simulation: record_procedure_simulation() recomputes
--         `passed` from the metrics, ties seed_only to them and, for a pass, wants the drafter runs of
--         that very version in ai_run. publish_procedure_version() and apply_stage_promotion() check the
--         actor holds the permission (user_holds_permission needs a real, active user). The ai_auto
--         delivery guard also checks the message is the draft + the instance notice.
--   C-8   golden_answer.shareable: false by default; the drafter reads golden answers of the ticket's own
--         organization, and of other organizations only those a lead marked "no customer-specific data".
--
-- Reversible: 0108_review_hardening.down.sql (restores the 0096 / 0097 bodies and the INSERT grants; the
-- two columns of sessions and the one of golden_answer are dropped).

-- C-5.
ALTER TABLE sessions
  ADD COLUMN step_up_at timestamptz,
  ADD COLUMN step_up_method text,
  ADD CONSTRAINT sessions_step_up_check CHECK (
    (step_up_at IS NULL) = (step_up_method IS NULL) AND (step_up_method IS NULL OR step_up_method = 'google_oidc')
  );

-- C-8.
ALTER TABLE golden_answer ADD COLUMN shareable boolean NOT NULL DEFAULT false;
CREATE INDEX golden_answer_shareable_idx ON golden_answer (intent_id, created_at DESC)
  WHERE deleted_at IS NULL AND shareable;

-- C-6 / C-9: the application role no longer inserts these directly.
REVOKE INSERT ON autonomy_gate_report FROM watchtower_app, PUBLIC;
REVOKE INSERT ON ai_grade FROM watchtower_app, PUBLIC;
REVOKE INSERT ON procedure_simulation FROM watchtower_app, PUBLIC;

-- promotion_blocker (C-6)
CREATE OR REPLACE FUNCTION public.promotion_blocker(p_intent_id uuid, p_report_id uuid) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.intent%ROWTYPE;
  r public.autonomy_gate_report%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.intent WHERE id = p_intent_id;
  IF NOT FOUND THEN RETURN 'intent_not_found'; END IF;
  IF i.autonomy_stage <> 2 THEN RETURN 'not_at_stage_2'; END IF;
  IF i.autonomy_pinned THEN RETURN 'pinned'; END IF;
  IF COALESCE((SELECT s.is_on FROM public.ai_switch AS s WHERE s.key = 'ai_stage_cap_pinned'), true) THEN
    RETURN 'stage_cap_on';
  END IF;
  SELECT * INTO r FROM public.autonomy_gate_report WHERE id = p_report_id;
  IF NOT FOUND OR r.intent_id <> p_intent_id THEN RETURN 'report_not_found'; END IF;
  IF r.status <> 'green' THEN RETURN 'report_not_green'; END IF;
  IF NOT r.seed_excluded THEN RETURN 'report_counts_seed'; END IF;
  IF r.generated_at < pg_catalog.now() - interval '7 days' THEN RETURN 'report_too_old'; END IF;
  IF r.window_end - r.window_start < interval '28 days' THEN RETURN 'window_too_short'; END IF;
  -- C-6: a window cannot reach back before the intent existed (that is a window made up, not lived).
  IF r.window_start < pg_catalog.date_trunc('milliseconds', i.created_at) THEN RETURN 'window_before_intent'; END IF;
  -- The whole window was spent at stage 2: no stage change, promotion or rollback happened inside it.
  IF EXISTS (
    SELECT 1 FROM public.intent_autonomy_history AS h
     WHERE h.intent_id = p_intent_id AND h.change IN ('stage', 'promotion', 'auto_rollback')
       AND h.changed_at > r.window_start
  ) THEN
    RETURN 'window_not_at_stage_2';
  END IF;
  RETURN NULL;
END
$$;

-- apply_stage_promotion (C-9)
CREATE OR REPLACE FUNCTION public.apply_stage_promotion(
  p_promotion_id uuid,
  p_actor uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  promo public.intent_autonomy_promotion%ROWTYPE;
  blocker text;
  history_row uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = 'check_violation';
  END IF;
  -- C-9: the actor is a real, active person who holds the owner permission (not just any uuid).
  IF NOT public.user_holds_permission(p_actor, 'ai.autonomy.owner_approve') THEN
    RAISE EXCEPTION 'only the holder of ai.autonomy.owner_approve may apply a promotion' USING ERRCODE = 'WT004';
  END IF;
  SELECT * INTO promo FROM public.intent_autonomy_promotion WHERE id = p_promotion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such promotion' USING ERRCODE = 'P0002';
  END IF;
  IF promo.status <> 'approved' THEN
    RAISE EXCEPTION 'the promotion is %, not approved', promo.status USING ERRCODE = 'WT014';
  END IF;
  IF promo.decided_at < pg_catalog.now() - interval '72 hours' THEN
    UPDATE public.intent_autonomy_promotion SET status = 'expired' WHERE id = promo.id;
    RETURN 'expired';
  END IF;
  PERFORM 1 FROM public.intent WHERE id = promo.intent_id FOR UPDATE;
  blocker := public.promotion_blocker(promo.intent_id, promo.gate_report_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'promotion not eligible: %', blocker USING ERRCODE = 'WT011';
  END IF;
  -- The trigger intent_require_promotion finds the approved row (still not applied) and lets this through.
  UPDATE public.intent SET autonomy_stage = 3, updated_at = pg_catalog.now() WHERE id = promo.intent_id;
  -- Written after the stage change: promotion_blocker() looks for history inside the report window.
  INSERT INTO public.intent_autonomy_history
    (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at, promotion_id, evidence)
  VALUES
    (promo.intent_id, 'promotion', 2, 3, false, promo.decision_reason, promo.decided_by, pg_catalog.clock_timestamp(), promo.id,
     pg_catalog.jsonb_build_object('gate_report_id', promo.gate_report_id, 'requested_by', promo.requested_by,
                                   'self_approved', promo.self_approved, 'applied_by', p_actor))
  RETURNING id INTO history_row;
  UPDATE public.intent_autonomy_promotion
     SET status = 'applied', applied_at = pg_catalog.clock_timestamp(), history_id = history_row
   WHERE id = promo.id;
  RETURN 'applied';
END
$$;

-- publish_procedure_version (C-9)
CREATE OR REPLACE FUNCTION public.publish_procedure_version(p_version_id uuid, p_actor uuid) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v public.procedure_version%ROWTYPE;
  proc public.procedure%ROWTYPE;
  it public.intent%ROWTYPE;
  sim public.procedure_simulation%ROWTYPE;
  previous uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = 'check_violation';
  END IF;
  -- C-9: a real, active person who may publish (the api checks it too; the database does not trust the caller).
  IF NOT public.user_holds_permission(p_actor, 'procedure.publish') THEN
    RAISE EXCEPTION 'the actor may not publish a procedure' USING ERRCODE = 'WT004';
  END IF;
  -- Lock order: procedure, intent, version (the insert trigger locks the procedure first too).
  SELECT x.procedure_id INTO proc.id FROM public.procedure_version AS x WHERE x.id = p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such procedure version' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO proc FROM public.procedure AS p WHERE p.id = proc.id FOR UPDATE;
  SELECT * INTO it FROM public.intent AS i WHERE i.id = proc.intent_id FOR UPDATE;
  SELECT * INTO v FROM public.procedure_version AS x WHERE x.id = p_version_id FOR UPDATE;
  IF proc.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'the procedure is archived' USING ERRCODE = 'WT115';
  END IF;
  IF NOT (v.status = 'simulated' OR (v.status = 'retired' AND v.published_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'a version in status % cannot be published', v.status USING ERRCODE = 'WT110';
  END IF;

  SELECT * INTO sim FROM public.procedure_simulation AS s
   WHERE s.procedure_version_id = v.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
  IF NOT FOUND OR NOT sim.passed OR sim.steps_hash <> v.steps_hash THEN
    RAISE EXCEPTION 'no passing simulation for these steps' USING ERRCODE = 'WT111';
  END IF;
  IF sim.created_at < pg_catalog.clock_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION 'the simulation is older than 30 days: run it again' USING ERRCODE = 'WT112';
  END IF;
  IF it.autonomy_stage >= 3 THEN
    IF v.confirmed_by = p_actor THEN
      RAISE EXCEPTION 'at stage 3 the person who publishes must not be the person who confirmed' USING ERRCODE = 'WT113';
    END IF;
    IF sim.seed_only THEN
      RAISE EXCEPTION 'at stage 3 a simulation on seeded tickets does not count' USING ERRCODE = 'WT114';
    END IF;
  END IF;

  SELECT x.id INTO previous FROM public.procedure_version AS x
   WHERE x.procedure_id = v.procedure_id AND x.status = 'published' AND x.id <> v.id FOR UPDATE;
  IF previous IS NOT NULL THEN
    UPDATE public.procedure_version
       SET status = 'retired', retired_at = pg_catalog.clock_timestamp(), retired_by = p_actor
     WHERE id = previous;
  END IF;
  UPDATE public.procedure_version
     SET status = 'published', published_by = p_actor, published_at = pg_catalog.clock_timestamp(),
         retired_at = NULL, retired_by = NULL, simulation_id = sim.id
   WHERE id = v.id;
  UPDATE public.intent SET procedure_version_id = v.id, updated_at = pg_catalog.now() WHERE id = it.id;
  RETURN previous;
END
$$;

-- the ai_auto delivery guard (C-9)
CREATE OR REPLACE FUNCTION public.outbound_delivery_ai_auto_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  msg public.message%ROWTYPE;
  draft public.ai_draft%ROWTYPE;
  grade public.ai_grade%ROWTYPE;
  tkt public.ticket%ROWTYPE;
  itn public.intent%ROWTYPE;
  v_hash text;
  disclosure jsonb;
  base text;
  allowed boolean;
BEGIN
  IF NEW.origin <> 'ai_auto' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO msg FROM public.message WHERE id = NEW.message_id;
  IF NOT FOUND OR msg.ticket_id <> NEW.ticket_id THEN
    RAISE EXCEPTION 'outbound_delivery: ai_auto needs a message of this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- No author, no HTML, no attachment, and only the channels of the first round (Gmail, portal).
  IF msg.sender_user_id IS NOT NULL OR msg.sender_contact_id IS NOT NULL OR msg.body_html IS NOT NULL
     OR pg_catalog.jsonb_array_length(msg.attachments) <> 0 OR NEW.channel NOT IN ('gmail', 'portal') THEN
    RAISE EXCEPTION 'outbound_delivery: an automatic message has no author, no HTML and no attachment, and goes by Gmail or the portal'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(msg.body_text, 'UTF8')), 'hex');

  SELECT * INTO draft FROM public.ai_draft WHERE id = NEW.ai_draft_id;
  IF NOT FOUND OR draft.ticket_id <> NEW.ticket_id OR draft.status <> 'auto_approved' THEN
    RAISE EXCEPTION 'outbound_delivery: the AI draft is not auto-approved for this ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- C-9: the message is the draft, and only the draft, plus the notice the instance set (or nothing when it is
  -- off). A hash of the text that was graded is not enough: the grade is stored from what the caller said it
  -- read, so the message itself is held against the draft here.
  SELECT s.value INTO disclosure FROM public.instance_setting AS s WHERE s.key = 'autosend.disclosure';
  IF disclosure IS NULL THEN
    RAISE EXCEPTION 'outbound_delivery: the auto-send notice setting is missing' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  base := pg_catalog.regexp_replace(draft.body_text, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  IF COALESCE((disclosure ->> 'enabled')::boolean, true) THEN
    allowed := msg.body_text IN (base || E'\n\n' || (disclosure #>> '{text,th}'), base || E'\n\n' || (disclosure #>> '{text,en}'));
  ELSE
    allowed := msg.body_text = base;
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'outbound_delivery: an automatic message is the draft plus the instance notice and nothing else'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO tkt FROM public.ticket WHERE id = NEW.ticket_id;
  SELECT * INTO itn FROM public.intent WHERE id = tkt.intent_id;
  IF NOT FOUND OR itn.autonomy_stage <> 3 OR tkt.priority IN ('P1', 'P2') THEN
    RAISE EXCEPTION 'outbound_delivery: the intent is not at stage 3, or the ticket is P1/P2' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A missing switch row counts as on.
  IF (SELECT pg_catalog.count(*) FROM public.ai_switch) <> 2 OR EXISTS (SELECT 1 FROM public.ai_switch WHERE is_on) THEN
    RAISE EXCEPTION 'outbound_delivery: an AI switch is on' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO grade FROM public.ai_grade WHERE id = NEW.ai_grade_id;
  IF NOT FOUND OR grade.ai_draft_id <> draft.id OR grade.ticket_id <> NEW.ticket_id OR grade.phase <> 'pre_send'
     OR NOT grade.passed OR grade.violation_count <> 0 OR NOT grade.independent OR grade.mock
     OR grade.content_hash <> v_hash OR grade.score < itn.autosend_min_score
     OR grade.graded_at < pg_catalog.now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'outbound_delivery: no fresh passing independent pre-send grade of exactly this text'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

-- C-6: the door of the gate report. SECURITY DEFINER, search_path pinned (A-1).
CREATE FUNCTION public.record_autonomy_gate_report(
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
REVOKE ALL ON FUNCTION public.record_autonomy_gate_report(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_autonomy_gate_report(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, boolean, uuid) TO watchtower_app;

-- C-9: the door of a grade. The model of the grader and of the drafter come from their ai_run rows.
CREATE FUNCTION public.record_ai_grade(
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
REVOKE ALL ON FUNCTION public.record_ai_grade(uuid, uuid, text, text, uuid, numeric, boolean, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_ai_grade(uuid, uuid, text, text, uuid, numeric, boolean, jsonb, integer) TO watchtower_app;

-- C-9: the door of a simulation result. `passed` is what the metrics say; a pass needs the drafter runs of
-- this very version in ai_run, from the last 6 hours; seed_only is what the metrics say.
CREATE FUNCTION public.record_procedure_simulation(
  p_version_id uuid,
  p_passed boolean,
  p_seed_only boolean,
  p_case_count integer,
  p_metrics jsonb,
  p_ran_by uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  reasons jsonb;
  expected_pass boolean;
  drafted integer;
  seeded integer;
  runs integer;
  new_id uuid;
BEGIN
  IF p_metrics IS NULL OR pg_catalog.jsonb_typeof(p_metrics) <> 'object'
     OR pg_catalog.jsonb_typeof(p_metrics -> 'failReasons') <> 'array'
     OR pg_catalog.jsonb_typeof(p_metrics -> 'caseCount') <> 'number'
     OR pg_catalog.jsonb_typeof(p_metrics -> 'mode') <> 'string' THEN
    RAISE EXCEPTION 'a simulation result carries its metrics (mode, caseCount, failReasons)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_case_count IS NULL OR p_case_count < 0 OR (p_metrics ->> 'caseCount')::integer <> p_case_count THEN
    RAISE EXCEPTION 'the case count does not match the metrics' USING ERRCODE = 'check_violation';
  END IF;
  reasons := p_metrics -> 'failReasons';
  expected_pass := pg_catalog.jsonb_array_length(reasons) = 0 AND p_case_count > 0;
  IF p_passed IS DISTINCT FROM expected_pass THEN
    RAISE EXCEPTION 'passed does not follow from the metrics' USING ERRCODE = 'check_violation';
  END IF;
  seeded := COALESCE((p_metrics ->> 'seededCases')::integer, 0);
  IF p_seed_only IS DISTINCT FROM (seeded > 0) THEN
    RAISE EXCEPTION 'seed_only does not follow from the metrics' USING ERRCODE = 'check_violation';
  END IF;
  IF p_ran_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users AS u WHERE u.id = p_ran_by) THEN
    RAISE EXCEPTION 'no such user' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_passed THEN
    drafted := COALESCE((p_metrics #>> '{candidate,drafted}')::integer, 0);
    IF p_metrics ->> 'mode' <> 'instance' OR drafted < 1 THEN
      RAISE EXCEPTION 'only a run on this instance, with drafts, can pass' USING ERRCODE = 'check_violation';
    END IF;
    SELECT pg_catalog.count(*)::integer INTO runs FROM public.ai_run AS r
     WHERE r.procedure_version_id = p_version_id AND r.agent = 'drafter'
       AND r.created_at >= pg_catalog.clock_timestamp() - interval '6 hours';
    IF runs < drafted THEN
      RAISE EXCEPTION 'a pass needs the drafter runs of this version in ai_run' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO public.procedure_simulation (procedure_version_id, passed, seed_only, case_count, metrics, ran_by)
  VALUES (p_version_id, p_passed, p_seed_only, p_case_count, p_metrics, p_ran_by)
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;
REVOKE ALL ON FUNCTION public.record_procedure_simulation(uuid, boolean, boolean, integer, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_procedure_simulation(uuid, boolean, boolean, integer, jsonb, uuid) TO watchtower_app;
