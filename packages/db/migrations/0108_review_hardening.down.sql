-- Reverts 0108: the three INSERT grants come back, the new doors go, and the 0096 / 0097 bodies of the
-- functions it replaced are restored. Lossy: sessions.step_up_* and golden_answer.shareable are dropped.
DROP FUNCTION public.record_procedure_simulation(uuid, boolean, boolean, integer, jsonb, uuid);
DROP FUNCTION public.record_ai_grade(uuid, uuid, text, text, uuid, numeric, boolean, jsonb, integer);
DROP FUNCTION public.record_autonomy_gate_report(uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, boolean, uuid);
GRANT INSERT ON autonomy_gate_report, ai_grade, procedure_simulation TO watchtower_app;

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

DROP INDEX golden_answer_shareable_idx;
ALTER TABLE golden_answer DROP COLUMN shareable;
ALTER TABLE sessions
  DROP CONSTRAINT sessions_step_up_check,
  DROP COLUMN step_up_method,
  DROP COLUMN step_up_at;
