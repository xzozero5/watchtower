-- Reverts 0096. It refuses (RAISE) while the system is in a state the old schema cannot hold:
--   * an intent is at stage 3, or
--   * an ai_auto delivery exists (a scheduled one would be sent by an old schema with no gate; a finished one
--     is a record of a message that reached a customer and is never rewritten).
-- Everything else is lossy on purpose: the promotion, gate report, evaluation and grade tables, the seed
-- batches and the seed_batch_id columns are dropped; history rows of kind promotion / auto_rollback /
-- autosend are deleted (the history table is append-only, so its guard is switched off for that one statement).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM intent WHERE autonomy_stage >= 3) THEN
    RAISE EXCEPTION 'migration 0096 down: an intent is at stage 3; roll it back to stage 2 first (rollback_intent_autonomy)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM outbound_delivery WHERE origin = 'ai_auto' AND state IN ('scheduled', 'sending')) THEN
    RAISE EXCEPTION 'migration 0096 down: an ai_auto delivery is still scheduled; cancel or wait for it first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM outbound_delivery WHERE origin = 'ai_auto') THEN
    RAISE EXCEPTION 'migration 0096 down: ai_auto deliveries exist; they are a record of what reached customers and cannot be converted'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- A draft the system approved but never sent goes back to waiting for a person.
UPDATE ai_draft SET status = 'draft', auto_approved_at = NULL WHERE status = 'auto_approved';

-- 10. T-301e.
ALTER TABLE ai_resolution_grade
  DROP CONSTRAINT ai_resolution_grade_version_check,
  DROP COLUMN regraded_at,
  DROP COLUMN version;

-- 9. ensure_monthly_partitions: the 0067 body.
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(
  parent regclass,
  months_ahead integer DEFAULT 3,
  append_only boolean DEFAULT false,
  updatable_columns text[] DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent_name text;
  month_start date;
  month_end date;
  part_name text;
  created integer := 0;
  i integer;
BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 36';
  END IF;
  SELECT c.relname INTO parent_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = parent AND c.relkind = 'p' AND n.nspname = 'public';
  IF parent_name IS NULL THEN
    RAISE EXCEPTION '% is not a partitioned table in schema public', parent;
  END IF;

  FOR i IN 0..months_ahead LOOP
    month_start := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i))::date;
    month_end := (month_start + make_interval(months => 1))::date;
    part_name := parent_name || '_p' || to_char(month_start, 'YYYYMM');
    IF to_regclass(format('public.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent_name,
        month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00'
      );
      IF append_only THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM watchtower_app, PUBLIC', part_name);
        IF updatable_columns IS NOT NULL THEN
          EXECUTE format(
            'GRANT UPDATE (%s) ON public.%I TO watchtower_app',
            (SELECT string_agg(quote_ident(c), ', ') FROM unnest(updatable_columns) AS c), part_name
          );
        END IF;
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()',
          part_name || '_reject_truncate', part_name
        );
      END IF;
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

-- 8. outbound_delivery.
DROP TRIGGER outbound_delivery_ai_auto_guard ON outbound_delivery;
DROP FUNCTION public.outbound_delivery_ai_auto_guard();
DROP INDEX outbound_delivery_grade_active_key;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_grade;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_hold_check;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_creator;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_draft;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_check;
ALTER TABLE outbound_delivery DROP COLUMN ai_grade_id;
ALTER TABLE outbound_delivery
  ADD CONSTRAINT outbound_delivery_origin_check CHECK (origin IN ('human', 'ai_approved', 'system_template')),
  ADD CONSTRAINT outbound_delivery_origin_draft CHECK ((origin = 'ai_approved') = (ai_draft_id IS NOT NULL)),
  ADD CONSTRAINT outbound_delivery_origin_creator CHECK ((origin = 'system_template') = (created_by IS NULL)),
  ADD CONSTRAINT outbound_delivery_hold_check CHECK (hold_seconds BETWEEN 0 AND 30);

-- 7. ai_draft: the 0034 guard and constraints.
CREATE OR REPLACE FUNCTION ai_draft_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('sent', 'rejected', 'superseded') AND (NEW.status <> OLD.status OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'ai_draft: a % draft does not change', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'sent', 'rejected', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sent'))
    ) THEN
    RAISE EXCEPTION 'ai_draft: % -> % is not a transition', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'ai_draft: the approval of an approved draft cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE ai_draft DROP CONSTRAINT ai_draft_approval_state;
ALTER TABLE ai_draft DROP CONSTRAINT ai_draft_status_check;
ALTER TABLE ai_draft DROP COLUMN auto_approved_at;
ALTER TABLE ai_draft ADD CONSTRAINT ai_draft_status_check
  CHECK (status IN ('draft', 'approved', 'sent', 'rejected', 'superseded'));
ALTER TABLE ai_draft ADD CONSTRAINT ai_draft_approval_state CHECK ((status IN ('approved', 'sent')) = (approved_by IS NOT NULL));

-- 6. The doors.
DROP FUNCTION public.set_intent_autosend(uuid, boolean, numeric, integer, jsonb, uuid, text);
DROP FUNCTION public.rollback_intent_autonomy(uuid, text, jsonb);
DROP FUNCTION public.apply_stage_promotion(uuid, uuid);
DROP FUNCTION public.decide_stage_promotion(uuid, boolean, uuid, text, timestamptz, text);
DROP FUNCTION public.request_stage_promotion(uuid, uuid, uuid, text);

-- 0007 bodies of the two functions (reason: any non-empty text).
CREATE OR REPLACE FUNCTION public.set_ai_switch(
  p_key text,
  p_on boolean,
  p_actor uuid,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  previous boolean;
BEGIN
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR p_on IS NULL THEN
    RAISE EXCEPTION 'an actor and a value are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.is_on INTO previous FROM public.ai_switch AS s WHERE s.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such switch' USING ERRCODE = 'P0002';
  END IF;
  IF previous <> p_on THEN
    UPDATE public.ai_switch
       SET is_on = p_on, reason = pg_catalog.btrim(p_reason), changed_by = p_actor, changed_at = pg_catalog.now()
     WHERE key = p_key;
  END IF;
  RETURN previous;
END
$$;

CREATE OR REPLACE FUNCTION public.set_intent_autonomy(
  p_intent_id uuid,
  p_stage smallint,
  p_pinned boolean,
  p_actor uuid,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cur public.intent%ROWTYPE;
  new_stage smallint;
  new_pinned boolean;
  written integer := 0;
BEGIN
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO cur FROM public.intent WHERE id = p_intent_id FOR UPDATE;
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
       AND COALESCE((SELECT s.is_on FROM public.ai_switch AS s WHERE s.key = 'ai_stage_cap_pinned'), true) THEN
      RAISE EXCEPTION 'stages cannot be raised while the stage cap switch is on' USING ERRCODE = 'WT002';
    END IF;
    INSERT INTO public.intent_autonomy_history (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at)
    VALUES (cur.id, 'stage', cur.autonomy_stage, new_stage, new_pinned, pg_catalog.btrim(p_reason), p_actor, pg_catalog.clock_timestamp());
    written := written + 1;
  END IF;

  IF new_pinned <> cur.autonomy_pinned THEN
    INSERT INTO public.intent_autonomy_history (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at)
    VALUES (cur.id, CASE WHEN new_pinned THEN 'pin' ELSE 'unpin' END, new_stage, new_stage, new_pinned, pg_catalog.btrim(p_reason), p_actor, pg_catalog.clock_timestamp());
    written := written + 1;
  END IF;

  IF written > 0 THEN
    UPDATE public.intent
       SET autonomy_stage = new_stage, autonomy_pinned = new_pinned, updated_at = pg_catalog.now()
     WHERE id = cur.id;
  END IF;
  RETURN written;
END
$$;

-- 5 + 4. Triggers and columns of intent, the history table, the promotion machinery.
DROP TRIGGER intent_guard_autosend ON intent;
DROP FUNCTION public.intent_guard_autosend();
DROP TRIGGER intent_require_promotion ON intent;
DROP FUNCTION public.intent_require_promotion();
DROP FUNCTION public.promotion_blocker(uuid, uuid);

ALTER TABLE intent_autonomy_history DISABLE TRIGGER intent_autonomy_history_reject_update_delete;
DELETE FROM intent_autonomy_history WHERE change IN ('promotion', 'auto_rollback', 'autosend');
ALTER TABLE intent_autonomy_history ENABLE TRIGGER intent_autonomy_history_reject_update_delete;
ALTER TABLE intent_autonomy_history
  DROP CONSTRAINT intent_autonomy_history_evidence_check,
  DROP CONSTRAINT intent_autonomy_history_actor_check,
  DROP CONSTRAINT intent_autonomy_history_rollback_check,
  DROP CONSTRAINT intent_autonomy_history_promotion_check,
  DROP CONSTRAINT intent_autonomy_history_stage_ceiling_check,
  DROP CONSTRAINT intent_autonomy_history_shape_check,
  DROP CONSTRAINT intent_autonomy_history_change_check,
  DROP COLUMN evidence,
  DROP COLUMN promotion_id;
ALTER TABLE intent_autonomy_history ALTER COLUMN changed_by SET NOT NULL;
ALTER TABLE intent_autonomy_history
  ADD CONSTRAINT intent_autonomy_history_change_check CHECK (change IN ('stage', 'pin', 'unpin')),
  ADD CONSTRAINT intent_autonomy_history_shape_check CHECK (
    (change = 'stage' AND from_stage <> to_stage) OR (change <> 'stage' AND from_stage = to_stage)
  );

GRANT UPDATE (id, key) ON intent TO watchtower_app;
GRANT DELETE ON intent TO watchtower_app;
ALTER TABLE intent
  DROP CONSTRAINT intent_autosend_policy_check,
  DROP CONSTRAINT intent_autosend_cap_check,
  DROP CONSTRAINT intent_autosend_score_check,
  DROP COLUMN autosend_policy,
  DROP COLUMN autosend_daily_cap,
  DROP COLUMN autosend_min_score,
  DROP COLUMN autosend_shadow;
ALTER TABLE intent DROP CONSTRAINT intent_autonomy_check;
ALTER TABLE intent ADD CONSTRAINT intent_autonomy_phase1_check CHECK (autonomy_stage BETWEEN 0 AND 2);

-- 3 + 2. Tables.
DROP TABLE intent_autonomy_promotion;
DROP FUNCTION public.intent_autonomy_promotion_guard();
DROP TABLE ai_autosend_evaluation;
DROP TABLE ai_grade;
DROP FUNCTION public.ai_grade_guard();
DROP TABLE autonomy_gate_report;

-- 1. Seed batches.
DROP INDEX ticket_intent_resolved_real_idx;
DROP TRIGGER ticket_seed_batch_guard ON ticket;
DROP TRIGGER organization_seed_batch_guard ON organization;
DROP FUNCTION public.seed_batch_guard();
ALTER TABLE ticket DROP COLUMN seed_batch_id;
ALTER TABLE organization DROP COLUMN seed_batch_id;
DROP TABLE seed_batch;

-- 0. Permissions (their grants go with them: ON DELETE CASCADE) and the helper functions.
DROP TRIGGER users_guard_owner_approval ON users;
DROP FUNCTION public.users_guard_owner_approval();
DROP FUNCTION public.user_is_owner_approver(uuid);
DROP FUNCTION public.user_holds_permission(uuid, text);
DELETE FROM permissions WHERE key IN ('ai.autonomy.promote', 'ai.autonomy.owner_approve');
