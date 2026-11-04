-- T-304b (ADR-025, PRD 6.4 / 6.6, N3): the database side of stage 3 (auto-send). Everything here is a
-- door that stays shut until a head asks, the owner approves and the instance has the env flag; the flag
-- itself lives in the environment and is not in this file (ADR-025 section 2).
--
--   1. intent:            CHECK 0..3 (was 0..2). Stage 3 can be reached only through the promotion door:
--                         INSERT at 3 is refused, UPDATE 2 -> 3 needs an approved, unapplied promotion
--                         (<= 72 h) tied to a green gate report (<= 7 d, window >= 28 d at stage 2).
--                         New columns autosend_shadow / autosend_min_score / autosend_daily_cap /
--                         autosend_policy; at stage 3 loosening them goes through set_intent_autosend().
--   2. set_intent_autonomy(): raising to 3 or more is WT003. Reason 3..500 chars (A-10), also on
--                         set_ai_switch(). A-9: no UPDATE of intent.id / key and no DELETE for the app role.
--   3. promotion:         intent_autonomy_promotion + request_/decide_/apply_stage_promotion() and
--                         rollback_intent_autonomy(), all SECURITY DEFINER with search_path pinned (A-1).
--                         The owner (permission ai.autonomy.owner_approve, per user, granted only by the
--                         schema owner, see users_guard_owner_approval) may approve a request of their own
--                         with a re-auth inside 5 minutes and the intent key typed back (owner decision 1).
--   4. evidence:          autonomy_gate_report, ai_autosend_evaluation (append-only), ai_grade (pre_send /
--                         sampled grades of one exact text; post_resolution grades stay in
--                         ai_resolution_grade, 0094: that table is one row per resolution and is aggregated
--                         as such, while a pre-send grade is many per ticket, keyed by the hash of the text
--                         that would be sent, so the two do not share a table).
--   5. outbound:          origin 'ai_auto' + ai_grade_id, an extra insert trigger that re-reads everything
--                         from the tables, ai_draft.status 'auto_approved'.
--   6. seed data:         seed_batch + seed_batch_id on ticket and organization, written only by the schema
--                         owner (trigger, not a column GRANT: a column grant on ticket would break every later
--                         migration that adds a ticket column and every drizzle INSERT, which names all columns).
--   7. A-11:              ensure_monthly_partitions() makes a new partition append-only when its parent is.
--
-- Raises (custom SQLSTATE): WT002 stage cap switch on (0007), WT003 stage 3 only by promotion, WT004 the
-- caller lacks the permission, WT011 the promotion is not eligible (the message carries the reason code),
-- WT012 re-auth too old / typed key wrong, WT014 the promotion is not in the right state.
-- Reversible: 0096_stage3_autosend.down.sql. It RAISES while an intent is at stage 3 or an ai_auto delivery
-- exists, and is lossy for the promotion / evidence tables (they are dropped).

-- 0. Permissions. `ai.autonomy.owner_approve` is bound to no role: the schema owner puts it in
--    users.permissions of one person (pnpm db:grant-owner-approval).
INSERT INTO permissions (key, description) VALUES
  ('ai.autonomy.promote', 'Ask the owner to promote one intent to stage 3 (auto-send) with a green gate report'),
  ('ai.autonomy.owner_approve', 'Owner only: approve a stage 3 promotion (granted per user from the command line, never to a role)');
INSERT INTO role_permissions (role, permission) VALUES ('head', 'ai.autonomy.promote');

-- Does a person hold a permission, through the role or the per-user extras? Read-only; used by the doors below.
CREATE FUNCTION public.user_holds_permission(p_user uuid, p_permission text) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users AS u
     WHERE u.id = p_user AND u.status = 'active'
       AND (p_permission = ANY (u.permissions)
            OR EXISTS (SELECT 1 FROM public.role_permissions AS rp WHERE rp.role = u.role AND rp.permission = p_permission))
  )
$$;
REVOKE ALL ON FUNCTION public.user_holds_permission(uuid, text) FROM PUBLIC;

-- The owner permission is never read from a role, only from the user's own list.
CREATE FUNCTION public.user_is_owner_approver(p_user uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users AS u
     WHERE u.id = p_user AND u.status = 'active' AND 'ai.autonomy.owner_approve' = ANY (u.permissions)
  )
$$;
REVOKE ALL ON FUNCTION public.user_is_owner_approver(uuid) FROM PUBLIC;

-- Only the schema owner may put the owner permission in a user's list (the application role can UPDATE
-- users.permissions in general, which is how service identities get extras).
CREATE FUNCTION public.users_guard_owner_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  table_owner name;
BEGIN
  IF 'ai.autonomy.owner_approve' = ANY (NEW.permissions)
     AND (TG_OP = 'INSERT' OR NOT ('ai.autonomy.owner_approve' = ANY (OLD.permissions))) THEN
    SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO table_owner FROM pg_catalog.pg_class AS c WHERE c.oid = TG_RELID;
    IF current_user::name IS DISTINCT FROM table_owner THEN
      RAISE EXCEPTION 'users: ai.autonomy.owner_approve can be granted only by the schema owner'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_guard_owner_approval
  BEFORE INSERT OR UPDATE OF permissions ON users
  FOR EACH ROW EXECUTE FUNCTION public.users_guard_owner_approval();

-- 1. Seed batches (section 6 of the header) come first: organization / ticket point at them.
CREATE TABLE seed_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  loaded_by text NOT NULL DEFAULT current_user,
  note text NOT NULL DEFAULT '',
  CONSTRAINT seed_batch_kind_check CHECK (kind IN ('demo', 'year', 'e2e'))
);
CREATE TRIGGER seed_batch_reject_update_delete
  BEFORE UPDATE OR DELETE ON seed_batch
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER seed_batch_reject_truncate
  BEFORE TRUNCATE ON seed_batch
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON seed_batch FROM watchtower_app, PUBLIC;
GRANT SELECT ON seed_batch TO watchtower_app;

ALTER TABLE organization ADD COLUMN seed_batch_id uuid REFERENCES seed_batch (id) ON DELETE RESTRICT;
ALTER TABLE ticket ADD COLUMN seed_batch_id uuid REFERENCES seed_batch (id) ON DELETE RESTRICT;

-- The batch of a row is written by the schema owner (the seed and `db:mark-seed` run with the migrator's
-- role) and by nobody else; a ticket in a batch lives in an organization of the same batch.
CREATE FUNCTION public.seed_batch_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  table_owner name;
  org_batch uuid;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.seed_batch_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.seed_batch_id IS DISTINCT FROM OLD.seed_batch_id) THEN
    SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO table_owner FROM pg_catalog.pg_class AS c WHERE c.oid = TG_RELID;
    IF current_user::name IS DISTINCT FROM table_owner THEN
      RAISE EXCEPTION '%: seed_batch_id can be written only by the schema owner', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'ticket' AND NEW.seed_batch_id IS NOT NULL THEN
    SELECT o.seed_batch_id INTO org_batch FROM public.organization AS o WHERE o.id = NEW.org_id;
    IF org_batch IS DISTINCT FROM NEW.seed_batch_id THEN
      RAISE EXCEPTION 'ticket: a seed ticket must belong to an organization of the same seed batch'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER organization_seed_batch_guard
  BEFORE INSERT OR UPDATE OF seed_batch_id ON organization
  FOR EACH ROW EXECUTE FUNCTION public.seed_batch_guard();
CREATE TRIGGER ticket_seed_batch_guard
  BEFORE INSERT OR UPDATE OF seed_batch_id, org_id ON ticket
  FOR EACH ROW EXECUTE FUNCTION public.seed_batch_guard();
-- What the promotion report counts (ADR-025 section 6): resolved tickets that are not seed data.
CREATE INDEX ticket_intent_resolved_real_idx ON ticket (intent_id, resolved_at) WHERE seed_batch_id IS NULL;

-- 2. Evidence tables.
CREATE TABLE autonomy_gate_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  status text NOT NULL,
  trigger_kind text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  -- The numbers and one entry per criterion: [{ key, pass, value, threshold }]. The worker writes both.
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when seed_batch_id IS NULL was applied to every count; a report that did not do so is never green.
  seed_excluded boolean NOT NULL DEFAULT true,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  generated_by uuid,
  CONSTRAINT autonomy_gate_report_status_check CHECK (status IN ('green', 'red', 'insufficient_data')),
  CONSTRAINT autonomy_gate_report_trigger_check CHECK (trigger_kind IN ('weekly', 'on_demand')),
  CONSTRAINT autonomy_gate_report_window_check CHECK (window_end > window_start),
  CONSTRAINT autonomy_gate_report_json_check CHECK (jsonb_typeof(metrics) = 'object' AND jsonb_typeof(criteria) = 'array'),
  CONSTRAINT autonomy_gate_report_green_check CHECK (
    status <> 'green' OR (seed_excluded AND window_end - window_start >= interval '28 days')
  )
);
CREATE INDEX autonomy_gate_report_intent_idx ON autonomy_gate_report (intent_id, generated_at DESC);
CREATE TRIGGER autonomy_gate_report_reject_update_delete
  BEFORE UPDATE OR DELETE ON autonomy_gate_report
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER autonomy_gate_report_reject_truncate
  BEFORE TRUNCATE ON autonomy_gate_report
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON autonomy_gate_report FROM watchtower_app, PUBLIC;

-- Grades of one exact text, made before it is sent (pre_send) or on a sample (sampled). `graded_text` is
-- what the grader read (for pre_send: the draft plus the disclosure footer, as it would be sent); the
-- trigger hashes it, so the hash is never the caller's word. `independent` is the owner's rule (decision 2):
-- the grader's model id differs from the drafter's. A grade that is not independent can still be stored
-- (shadow mode records it); it can never allow a send.
CREATE TABLE ai_grade (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_draft_id uuid NOT NULL REFERENCES ai_draft (id) ON DELETE RESTRICT,
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  phase text NOT NULL,
  graded_text text NOT NULL,
  content_hash text NOT NULL DEFAULT '',
  -- The grader's ai_run row (partitioned table: no foreign key, like ai_draft.ai_run_id).
  grader_ai_run_id uuid,
  grader_provider text NOT NULL,
  grader_model text NOT NULL,
  drafter_provider text NOT NULL,
  drafter_model text NOT NULL,
  independent boolean GENERATED ALWAYS AS (grader_model <> drafter_model) STORED,
  -- numeric, not real: the comparison with intent.autosend_min_score must be exact (0.9 is 0.9).
  score numeric(4, 3) NOT NULL,
  passed boolean NOT NULL,
  violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  violation_count integer NOT NULL DEFAULT 0,
  prompt_version integer NOT NULL,
  mock boolean NOT NULL DEFAULT false,
  graded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_grade_phase_check CHECK (phase IN ('pre_send', 'sampled')),
  CONSTRAINT ai_grade_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_grade_score_check CHECK (score BETWEEN 0 AND 1),
  CONSTRAINT ai_grade_text_check CHECK (graded_text <> ''),
  CONSTRAINT ai_grade_violations_check CHECK (
    jsonb_typeof(violations) = 'array' AND violation_count = jsonb_array_length(violations)
  ),
  CONSTRAINT ai_grade_passed_check CHECK (NOT passed OR violation_count = 0)
);
CREATE FUNCTION public.ai_grade_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  draft_ticket uuid;
BEGIN
  NEW.content_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.graded_text, 'UTF8')), 'hex');
  SELECT d.ticket_id INTO draft_ticket FROM public.ai_draft AS d WHERE d.id = NEW.ai_draft_id;
  IF draft_ticket IS DISTINCT FROM NEW.ticket_id THEN
    RAISE EXCEPTION 'ai_grade: the draft does not belong to this ticket'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ai_grade_guard
  BEFORE INSERT ON ai_grade
  FOR EACH ROW EXECUTE FUNCTION public.ai_grade_guard();
CREATE INDEX ai_grade_draft_idx ON ai_grade (ai_draft_id, graded_at DESC);
CREATE INDEX ai_grade_ticket_idx ON ai_grade (ticket_id, graded_at DESC);
CREATE INDEX ai_grade_phase_idx ON ai_grade (phase, graded_at DESC);
CREATE TRIGGER ai_grade_reject_update_delete
  BEFORE UPDATE OR DELETE ON ai_grade
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ai_grade_reject_truncate
  BEFORE TRUNCATE ON ai_grade
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON ai_grade FROM watchtower_app, PUBLIC;

-- One row each time the auto-send decision is evaluated: 'shadow' (the draft still waits for a person) or
-- 'live' (a delivery was or was not scheduled). The precision that promotion needs is computed from it.
CREATE TABLE ai_autosend_evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_draft_id uuid NOT NULL REFERENCES ai_draft (id) ON DELETE RESTRICT,
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  mode text NOT NULL,
  would_auto_send boolean NOT NULL,
  failed_conditions text[] NOT NULL DEFAULT '{}',
  effective_stage smallint NOT NULL,
  ai_grade_id uuid REFERENCES ai_grade (id) ON DELETE RESTRICT,
  -- Counts and flags the decision used; never customer text.
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_autosend_evaluation_mode_check CHECK (mode IN ('shadow', 'live')),
  CONSTRAINT ai_autosend_evaluation_result_check CHECK (would_auto_send = (cardinality(failed_conditions) = 0)),
  CONSTRAINT ai_autosend_evaluation_stage_check CHECK (effective_stage BETWEEN 0 AND 3),
  CONSTRAINT ai_autosend_evaluation_facts_check CHECK (jsonb_typeof(facts) = 'object')
);
CREATE INDEX ai_autosend_evaluation_intent_idx ON ai_autosend_evaluation (intent_id, evaluated_at DESC);
CREATE INDEX ai_autosend_evaluation_draft_idx ON ai_autosend_evaluation (ai_draft_id);
CREATE TRIGGER ai_autosend_evaluation_reject_update_delete
  BEFORE UPDATE OR DELETE ON ai_autosend_evaluation
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ai_autosend_evaluation_reject_truncate
  BEFORE TRUNCATE ON ai_autosend_evaluation
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON ai_autosend_evaluation FROM watchtower_app, PUBLIC;

-- 3. Promotions. The application role can read them and nothing else: every row and every change comes
--    from the three functions below.
CREATE TABLE intent_autonomy_promotion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  gate_report_id uuid NOT NULL REFERENCES autonomy_gate_report (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'requested',
  -- No foreign key on people, like audit_log.actor_id: the record outlives the user.
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_reason text NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  -- True when the approver is the person who asked (allowed only for the holder of the owner permission).
  self_approved boolean NOT NULL DEFAULT false,
  reauth_at timestamptz,
  confirmed_key text,
  applied_at timestamptz,
  history_id uuid,
  CONSTRAINT intent_autonomy_promotion_status_check CHECK (
    status IN ('requested', 'approved', 'rejected', 'applied', 'expired', 'cancelled')
  ),
  CONSTRAINT intent_autonomy_promotion_reason_check CHECK (length(btrim(request_reason)) BETWEEN 3 AND 500),
  CONSTRAINT intent_autonomy_promotion_decision_reason_check CHECK (
    decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 500
  ),
  CONSTRAINT intent_autonomy_promotion_decided_pair CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT intent_autonomy_promotion_decided_state CHECK (
    (status IN ('approved', 'applied', 'rejected') AND decided_by IS NOT NULL)
    OR status IN ('requested', 'expired', 'cancelled')
  ),
  CONSTRAINT intent_autonomy_promotion_approval_proof CHECK (
    status NOT IN ('approved', 'applied')
    OR (reauth_at IS NOT NULL AND confirmed_key IS NOT NULL AND decision_reason IS NOT NULL)
  ),
  CONSTRAINT intent_autonomy_promotion_applied_state CHECK (
    (status = 'applied') = (applied_at IS NOT NULL AND history_id IS NOT NULL)
  ),
  -- requested_by <> decided_by, unless the approver holds the owner permission and says so (decision 1).
  CONSTRAINT intent_autonomy_promotion_self_check CHECK (
    status NOT IN ('approved', 'applied') OR decided_by <> requested_by OR self_approved
  ),
  CONSTRAINT intent_autonomy_promotion_self_flag_check CHECK (NOT self_approved OR decided_by = requested_by)
);
-- One open request per intent.
CREATE UNIQUE INDEX intent_autonomy_promotion_open_key ON intent_autonomy_promotion (intent_id)
  WHERE status IN ('requested', 'approved');
CREATE INDEX intent_autonomy_promotion_intent_idx ON intent_autonomy_promotion (intent_id, requested_at DESC);
CREATE FUNCTION public.intent_autonomy_promotion_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'intent_autonomy_promotion: rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.intent_id <> OLD.intent_id OR NEW.gate_report_id <> OLD.gate_report_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at
     OR NEW.request_reason <> OLD.request_reason THEN
    RAISE EXCEPTION 'intent_autonomy_promotion: the request itself does not change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('applied', 'expired', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'intent_autonomy_promotion: % -> % is not a transition', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('rejected', 'applied', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'intent_autonomy_promotion: a % promotion does not change', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER intent_autonomy_promotion_guard
  BEFORE UPDATE OR DELETE ON intent_autonomy_promotion
  FOR EACH ROW EXECUTE FUNCTION public.intent_autonomy_promotion_guard();
CREATE TRIGGER intent_autonomy_promotion_reject_truncate
  BEFORE TRUNCATE ON intent_autonomy_promotion
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON intent_autonomy_promotion FROM watchtower_app, PUBLIC;
GRANT SELECT ON intent_autonomy_promotion TO watchtower_app;

-- 4. intent: ceiling 3, the autosend settings, A-9.
ALTER TABLE intent DROP CONSTRAINT intent_autonomy_phase1_check;
ALTER TABLE intent ADD CONSTRAINT intent_autonomy_check CHECK (autonomy_stage BETWEEN 0 AND 3);
ALTER TABLE intent
  ADD COLUMN autosend_shadow boolean NOT NULL DEFAULT false,
  ADD COLUMN autosend_min_score numeric(4, 3) NOT NULL DEFAULT 0.850,
  ADD COLUMN autosend_daily_cap integer NOT NULL DEFAULT 20,
  ADD COLUMN autosend_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT intent_autosend_score_check CHECK (autosend_min_score BETWEEN 0.700 AND 1.000),
  ADD CONSTRAINT intent_autosend_cap_check CHECK (autosend_daily_cap BETWEEN 0 AND 1000),
  ADD CONSTRAINT intent_autosend_policy_check CHECK (jsonb_typeof(autosend_policy) = 'object');
GRANT UPDATE (autosend_shadow, autosend_min_score, autosend_daily_cap, autosend_policy) ON intent TO watchtower_app;
-- A-9: an intent is referenced by key everywhere; it is never renamed in place or deleted (soft-delete).
REVOKE UPDATE (id, key) ON intent FROM watchtower_app;
REVOKE DELETE ON intent FROM watchtower_app;

-- History: promotion / auto_rollback / autosend rows, and the evidence behind them.
ALTER TABLE intent_autonomy_history
  ADD COLUMN promotion_id uuid REFERENCES intent_autonomy_promotion (id) ON DELETE RESTRICT,
  ADD COLUMN evidence jsonb;
ALTER TABLE intent_autonomy_history ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE intent_autonomy_history DROP CONSTRAINT intent_autonomy_history_change_check;
ALTER TABLE intent_autonomy_history DROP CONSTRAINT intent_autonomy_history_shape_check;
ALTER TABLE intent_autonomy_history
  ADD CONSTRAINT intent_autonomy_history_change_check CHECK (
    change IN ('stage', 'pin', 'unpin', 'promotion', 'auto_rollback', 'autosend')
  ),
  ADD CONSTRAINT intent_autonomy_history_shape_check CHECK (
    (change IN ('stage', 'promotion', 'auto_rollback') AND from_stage <> to_stage)
    OR (change NOT IN ('stage', 'promotion', 'auto_rollback') AND from_stage = to_stage)
  ),
  -- A plain stage change never lands on 3: only a promotion does.
  ADD CONSTRAINT intent_autonomy_history_stage_ceiling_check CHECK (change <> 'stage' OR to_stage <= 2),
  ADD CONSTRAINT intent_autonomy_history_promotion_check CHECK (
    change <> 'promotion' OR (from_stage = 2 AND to_stage = 3 AND promotion_id IS NOT NULL AND changed_by IS NOT NULL)
  ),
  ADD CONSTRAINT intent_autonomy_history_rollback_check CHECK (change <> 'auto_rollback' OR (from_stage = 3 AND to_stage <= 2)),
  -- Only the automatic rollback has no person behind it.
  ADD CONSTRAINT intent_autonomy_history_actor_check CHECK (changed_by IS NOT NULL OR change = 'auto_rollback'),
  ADD CONSTRAINT intent_autonomy_history_evidence_check CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object');

-- 5. Why a promotion can or cannot go ahead. NULL = nothing in the way. Read by request, approval, apply and the
--    trigger below, so the four never disagree.
CREATE FUNCTION public.promotion_blocker(p_intent_id uuid, p_report_id uuid) RETURNS text
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

CREATE FUNCTION public.intent_require_promotion() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.autonomy_stage >= 3 THEN
      RAISE EXCEPTION 'intent: an intent cannot be created at stage 3' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.autonomy_stage >= 3 AND OLD.autonomy_stage < 3 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.intent_autonomy_promotion AS p
       WHERE p.intent_id = NEW.id AND p.status = 'approved' AND p.applied_at IS NULL
         AND p.decided_at >= pg_catalog.now() - interval '72 hours'
         AND public.promotion_blocker(NEW.id, p.gate_report_id) IS NULL
    ) THEN
      RAISE EXCEPTION 'intent: stage 3 needs an approved promotion with a green gate report'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER intent_require_promotion
  BEFORE INSERT OR UPDATE OF autonomy_stage ON intent
  FOR EACH ROW EXECUTE FUNCTION public.intent_require_promotion();

-- At stage 3, making the rules looser (lower score, bigger cap, any change of the policy) is the head's
-- decision with a reason in the history: only set_intent_autosend() (owner rights) may do it.
CREATE FUNCTION public.intent_guard_autosend() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  table_owner name;
BEGIN
  IF OLD.autonomy_stage = 3 AND (
       NEW.autosend_min_score < OLD.autosend_min_score
    OR NEW.autosend_daily_cap > OLD.autosend_daily_cap
    OR NEW.autosend_policy IS DISTINCT FROM OLD.autosend_policy
  ) THEN
    SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO table_owner FROM pg_catalog.pg_class AS c WHERE c.oid = TG_RELID;
    IF current_user::name IS DISTINCT FROM table_owner THEN
      RAISE EXCEPTION 'intent: the auto-send rules of a stage 3 intent change only through set_intent_autosend()'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER intent_guard_autosend
  BEFORE UPDATE OF autosend_min_score, autosend_daily_cap, autosend_policy ON intent
  FOR EACH ROW EXECUTE FUNCTION public.intent_guard_autosend();

-- 6. The doors. All SECURITY DEFINER, search_path pinned, every name schema-qualified (A-1).
--    set_intent_autonomy(): 0007's body plus WT003 and the 3..500 reason (A-10).
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
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
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

  IF new_stage > cur.autonomy_stage AND new_stage >= 3 THEN
    RAISE EXCEPTION 'stage 3 is reached only through a promotion (request_stage_promotion)' USING ERRCODE = 'WT003';
  END IF;
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
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
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

-- request: a head (ai.autonomy.promote) names the intent and a green report.
CREATE FUNCTION public.request_stage_promotion(
  p_intent_id uuid,
  p_gate_report_id uuid,
  p_actor uuid,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  blocker text;
  new_id uuid;
BEGIN
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR NOT public.user_holds_permission(p_actor, 'ai.autonomy.promote') THEN
    RAISE EXCEPTION 'the actor may not ask for a promotion' USING ERRCODE = 'WT004';
  END IF;
  PERFORM 1 FROM public.intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such intent' USING ERRCODE = 'P0002';
  END IF;
  blocker := public.promotion_blocker(p_intent_id, p_gate_report_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'promotion not eligible: %', blocker USING ERRCODE = 'WT011';
  END IF;
  -- A request that nobody answered for 7 days no longer blocks a new one.
  UPDATE public.intent_autonomy_promotion
     SET status = 'expired'
   WHERE intent_id = p_intent_id AND status = 'requested' AND requested_at < pg_catalog.now() - interval '7 days';
  UPDATE public.intent_autonomy_promotion
     SET status = 'expired'
   WHERE intent_id = p_intent_id AND status = 'approved' AND decided_at < pg_catalog.now() - interval '72 hours';
  INSERT INTO public.intent_autonomy_promotion (intent_id, gate_report_id, requested_by, request_reason)
  VALUES (p_intent_id, p_gate_report_id, p_actor, pg_catalog.btrim(p_reason))
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;

-- decide: the owner approves (with re-auth and the typed key) or somebody rejects. Returns the new status.
CREATE FUNCTION public.decide_stage_promotion(
  p_promotion_id uuid,
  p_approve boolean,
  p_actor uuid,
  p_reason text,
  p_reauth_at timestamptz,
  p_confirm_key text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  promo public.intent_autonomy_promotion%ROWTYPE;
  intent_key text;
  blocker text;
  is_owner boolean;
BEGIN
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'an actor and a decision are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO promo FROM public.intent_autonomy_promotion WHERE id = p_promotion_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such promotion' USING ERRCODE = 'P0002';
  END IF;
  IF promo.status <> 'requested' THEN
    RAISE EXCEPTION 'the promotion is %, not requested', promo.status USING ERRCODE = 'WT014';
  END IF;
  is_owner := public.user_is_owner_approver(p_actor);

  IF NOT p_approve THEN
    -- Whoever asked can withdraw; the owner and any holder of the promote permission can say no.
    IF p_actor <> promo.requested_by AND NOT is_owner AND NOT public.user_holds_permission(p_actor, 'ai.autonomy.promote') THEN
      RAISE EXCEPTION 'the actor may not decide a promotion' USING ERRCODE = 'WT004';
    END IF;
    UPDATE public.intent_autonomy_promotion
       SET status = CASE WHEN p_actor = promo.requested_by THEN 'cancelled' ELSE 'rejected' END,
           decided_by = p_actor, decided_at = pg_catalog.clock_timestamp(), decision_reason = pg_catalog.btrim(p_reason)
     WHERE id = promo.id;
    RETURN CASE WHEN p_actor = promo.requested_by THEN 'cancelled' ELSE 'rejected' END;
  END IF;

  IF NOT is_owner THEN
    RAISE EXCEPTION 'only the holder of ai.autonomy.owner_approve may approve a promotion' USING ERRCODE = 'WT004';
  END IF;
  IF promo.requested_at < pg_catalog.now() - interval '7 days' THEN
    UPDATE public.intent_autonomy_promotion SET status = 'expired' WHERE id = promo.id;
    RETURN 'expired';
  END IF;
  SELECT i.key INTO intent_key FROM public.intent AS i WHERE i.id = promo.intent_id;
  -- Re-auth inside 5 minutes (the api checks the person really re-authenticated; the database checks the
  -- claim is fresh and not from the future) and the key of the intent typed back exactly.
  IF p_reauth_at IS NULL OR p_reauth_at < pg_catalog.clock_timestamp() - interval '5 minutes'
     OR p_reauth_at > pg_catalog.clock_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'a re-authentication within the last 5 minutes is required' USING ERRCODE = 'WT012';
  END IF;
  IF p_confirm_key IS NULL OR p_confirm_key IS DISTINCT FROM intent_key THEN
    RAISE EXCEPTION 'the key of the intent must be typed to confirm' USING ERRCODE = 'WT012';
  END IF;
  blocker := public.promotion_blocker(promo.intent_id, promo.gate_report_id);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'promotion not eligible: %', blocker USING ERRCODE = 'WT011';
  END IF;
  UPDATE public.intent_autonomy_promotion
     SET status = 'approved', decided_by = p_actor, decided_at = pg_catalog.clock_timestamp(),
         decision_reason = pg_catalog.btrim(p_reason), reauth_at = p_reauth_at, confirmed_key = p_confirm_key,
         self_approved = (p_actor = promo.requested_by)
   WHERE id = promo.id;
  RETURN 'approved';
END
$$;

-- apply: moves the intent to stage 3 and writes the history, in one statement. 'expired' when 72 h passed.
CREATE FUNCTION public.apply_stage_promotion(
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

-- rollback: stage 3 -> 2 (ADR-025 section 7). Idempotent (0 when the intent is not at 3), works through a pin
-- (it is the safe direction), cancels a promotion still open. Returns the number of history rows written.
CREATE FUNCTION public.rollback_intent_autonomy(
  p_intent_id uuid,
  p_reason text,
  p_evidence jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cur public.intent%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO cur FROM public.intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such intent' USING ERRCODE = 'P0002';
  END IF;
  IF cur.autonomy_stage < 3 THEN
    RETURN 0;
  END IF;
  INSERT INTO public.intent_autonomy_history
    (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at, evidence)
  VALUES
    (cur.id, 'auto_rollback', 3, 2, cur.autonomy_pinned, pg_catalog.btrim(p_reason), NULL, pg_catalog.clock_timestamp(),
     COALESCE(p_evidence, '{}'::jsonb));
  UPDATE public.intent SET autonomy_stage = 2, updated_at = pg_catalog.now() WHERE id = cur.id;
  UPDATE public.intent_autonomy_promotion
     SET status = 'cancelled'
   WHERE intent_id = cur.id AND status IN ('requested', 'approved');
  RETURN 1;
END
$$;

-- set_intent_autosend: the head changes the auto-send rules of an intent. Needed to loosen them at stage 3
-- (trigger above); any other change may also pass through it to get a history row.
CREATE FUNCTION public.set_intent_autosend(
  p_intent_id uuid,
  p_shadow boolean,
  p_min_score numeric,
  p_daily_cap integer,
  p_policy jsonb,
  p_actor uuid,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cur public.intent%ROWTYPE;
  nxt public.intent%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a reason of 3 to 500 characters is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR NOT public.user_holds_permission(p_actor, 'ai.autonomy.set.any') THEN
    RAISE EXCEPTION 'only the head may change the auto-send rules' USING ERRCODE = 'WT004';
  END IF;
  SELECT * INTO cur FROM public.intent WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such intent' USING ERRCODE = 'P0002';
  END IF;
  nxt := cur;
  nxt.autosend_shadow := COALESCE(p_shadow, cur.autosend_shadow);
  nxt.autosend_min_score := COALESCE(p_min_score, cur.autosend_min_score);
  nxt.autosend_daily_cap := COALESCE(p_daily_cap, cur.autosend_daily_cap);
  nxt.autosend_policy := COALESCE(p_policy, cur.autosend_policy);
  IF nxt.autosend_shadow = cur.autosend_shadow AND nxt.autosend_min_score = cur.autosend_min_score
     AND nxt.autosend_daily_cap = cur.autosend_daily_cap AND nxt.autosend_policy = cur.autosend_policy THEN
    RETURN 0;
  END IF;
  UPDATE public.intent
     SET autosend_shadow = nxt.autosend_shadow, autosend_min_score = nxt.autosend_min_score,
         autosend_daily_cap = nxt.autosend_daily_cap, autosend_policy = nxt.autosend_policy,
         updated_at = pg_catalog.now()
   WHERE id = cur.id;
  INSERT INTO public.intent_autonomy_history
    (intent_id, change, from_stage, to_stage, pinned, reason, changed_by, changed_at, evidence)
  VALUES
    (cur.id, 'autosend', cur.autonomy_stage, cur.autonomy_stage, cur.autonomy_pinned, pg_catalog.btrim(p_reason), p_actor,
     pg_catalog.clock_timestamp(),
     pg_catalog.jsonb_build_object(
       'before', pg_catalog.jsonb_build_object('shadow', cur.autosend_shadow, 'min_score', cur.autosend_min_score,
                                               'daily_cap', cur.autosend_daily_cap, 'policy', cur.autosend_policy),
       'after', pg_catalog.jsonb_build_object('shadow', nxt.autosend_shadow, 'min_score', nxt.autosend_min_score,
                                              'daily_cap', nxt.autosend_daily_cap, 'policy', nxt.autosend_policy)));
  RETURN 1;
END
$$;

REVOKE ALL ON FUNCTION public.request_stage_promotion(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_stage_promotion(uuid, boolean, uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_stage_promotion(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rollback_intent_autonomy(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_intent_autosend(uuid, boolean, numeric, integer, jsonb, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_stage_promotion(uuid, uuid, uuid, text) TO watchtower_app;
GRANT EXECUTE ON FUNCTION public.decide_stage_promotion(uuid, boolean, uuid, text, timestamptz, text) TO watchtower_app;
GRANT EXECUTE ON FUNCTION public.apply_stage_promotion(uuid, uuid) TO watchtower_app;
GRANT EXECUTE ON FUNCTION public.rollback_intent_autonomy(uuid, text, jsonb) TO watchtower_app;
GRANT EXECUTE ON FUNCTION public.set_intent_autosend(uuid, boolean, numeric, integer, jsonb, uuid, text) TO watchtower_app;

-- 7. ai_draft: a draft the system approved itself. approved_by stays null; auto_approved_at carries the moment.
ALTER TABLE ai_draft ADD COLUMN auto_approved_at timestamptz;
ALTER TABLE ai_draft DROP CONSTRAINT ai_draft_status_check;
ALTER TABLE ai_draft ADD CONSTRAINT ai_draft_status_check
  CHECK (status IN ('draft', 'approved', 'auto_approved', 'sent', 'rejected', 'superseded'));
ALTER TABLE ai_draft DROP CONSTRAINT ai_draft_approval_state;
ALTER TABLE ai_draft ADD CONSTRAINT ai_draft_approval_state CHECK (
  CASE status
    WHEN 'approved' THEN approved_by IS NOT NULL AND auto_approved_at IS NULL
    WHEN 'auto_approved' THEN approved_by IS NULL AND auto_approved_at IS NOT NULL
    WHEN 'sent' THEN (approved_by IS NOT NULL) <> (auto_approved_at IS NOT NULL)
    ELSE approved_by IS NULL AND auto_approved_at IS NULL
  END
);
GRANT UPDATE (auto_approved_at) ON ai_draft TO watchtower_app;
-- 0034's rules plus the new status. A draft becomes auto_approved only with a passing, independent, fresh
-- pre_send grade and an intent at stage 3 with both switches off (the delivery trigger asks again).
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
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'auto_approved', 'sent', 'rejected', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sent'))
    OR (OLD.status = 'auto_approved' AND NEW.status IN ('draft', 'sent'))
    ) THEN
    RAISE EXCEPTION 'ai_draft: % -> % is not a transition', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'ai_draft: the approval of an approved draft cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'auto_approved' AND NEW.status = 'auto_approved' AND NEW.auto_approved_at IS DISTINCT FROM OLD.auto_approved_at THEN
    RAISE EXCEPTION 'ai_draft: the automatic approval cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'auto_approved' AND OLD.status <> 'auto_approved' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.ai_grade AS g
        JOIN public.ticket AS t ON t.id = NEW.ticket_id
        JOIN public.intent AS i ON i.id = t.intent_id
       WHERE g.ai_draft_id = NEW.id AND g.phase = 'pre_send' AND g.passed AND g.violation_count = 0
         AND g.independent AND NOT g.mock AND g.score >= i.autosend_min_score
         AND g.graded_at >= pg_catalog.now() - interval '10 minutes'
         AND i.autonomy_stage = 3
         AND (SELECT pg_catalog.count(*) FROM public.ai_switch AS s) = 2
         AND NOT EXISTS (SELECT 1 FROM public.ai_switch AS s WHERE s.is_on)
    ) THEN
      RAISE EXCEPTION 'ai_draft: an automatic approval needs a fresh passing independent pre-send grade, a stage 3 intent and both switches off'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 8. outbound_delivery: origin 'ai_auto'.
ALTER TABLE outbound_delivery ADD COLUMN ai_grade_id uuid REFERENCES ai_grade (id) ON DELETE RESTRICT;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_check;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_draft;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_origin_creator;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_hold_check;
ALTER TABLE outbound_delivery
  ADD CONSTRAINT outbound_delivery_origin_check CHECK (origin IN ('human', 'ai_approved', 'ai_auto', 'system_template')),
  -- Both AI origins point at the draft. ai_auto has no approver and no creator (nobody pressed send), and
  -- exactly one grade; no other origin has a grade.
  ADD CONSTRAINT outbound_delivery_origin_draft CHECK ((origin IN ('ai_approved', 'ai_auto')) = (ai_draft_id IS NOT NULL)),
  ADD CONSTRAINT outbound_delivery_origin_creator CHECK ((origin IN ('system_template', 'ai_auto')) = (created_by IS NULL)),
  ADD CONSTRAINT outbound_delivery_origin_grade CHECK ((origin = 'ai_auto') = (ai_grade_id IS NOT NULL)),
  -- A person's undo window is 0-30 s; an automatic send waits longer so a person can step in (ADR-025 section 4).
  ADD CONSTRAINT outbound_delivery_hold_check CHECK (
    (origin <> 'ai_auto' AND hold_seconds BETWEEN 0 AND 30) OR (origin = 'ai_auto' AND hold_seconds BETWEEN 30 AND 300)
  );
-- A grade clears one send.
CREATE UNIQUE INDEX outbound_delivery_grade_active_key ON outbound_delivery (ai_grade_id)
  WHERE ai_grade_id IS NOT NULL AND state NOT IN ('failed', 'cancelled');

-- Re-reads everything from the tables: the grade, the draft, the intent, the switches and the message.
-- (A separate trigger, so 0035's guard stays as applied; both run on INSERT.)
CREATE FUNCTION public.outbound_delivery_ai_auto_guard() RETURNS trigger
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
CREATE TRIGGER outbound_delivery_ai_auto_guard
  BEFORE INSERT ON outbound_delivery
  FOR EACH ROW EXECUTE FUNCTION public.outbound_delivery_ai_auto_guard();

-- 9. A-11: a partition created later is as append-only as its parent. The caller's flag still counts; a
--    parent with a reject_mutation row trigger (audit_log, ticket_event, ai_run) forces it on.
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
  must_be_append_only boolean;
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
  must_be_append_only := append_only OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = parent AND NOT t.tgisinternal AND t.tgfoid = 'public.reject_mutation'::regproc
  );

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
      IF must_be_append_only THEN
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

-- 10. T-301e: a grade is re-made once when the customer's CSAT answer arrives after it. The row of the
--     resolution is updated in place (metrics count one row per resolution; a second row would count it
--     twice) and `version` / `regraded_at` say it happened. The first verdict is still in its ai_run row.
ALTER TABLE ai_resolution_grade
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN regraded_at timestamptz,
  ADD CONSTRAINT ai_resolution_grade_version_check CHECK (version >= 1 AND (version = 1) = (regraded_at IS NULL));
