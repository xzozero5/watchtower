-- T-122d: outbound delivery to customers, at-most-once, with a server-side undo-send hold
-- (ADR-010, ADR-011 follow-ups A-2 and A-3, PRD section 4.2 R-2.3 / R-2.10, N3).
--   1. ai_draft:            an AI-written draft and the person's approval of exactly that text. The
--                           content hash is computed by a trigger from the immutable body, so an
--                           application bug cannot approve one text and send another (A-2).
--   2. outbound_delivery:   source of truth of every message that goes to a customer through Gmail or
--                           LINE. The outbox only triggers it; a compare-and-set claim (`scheduled ->
--                           sending`) makes the send at-most-once. Holds no message text: the body is read
--                           from `message` at send time, and its hash is compared with `content_hash`.
--   3. channel_quota_usage: LINE push messages counted per account and month (R-2.10).
--   4. instance_setting:    the first instance-wide setting, `outbound.undo_send_seconds` (0-30, default 5).
--   5. message:             `delivery_status` gains `scheduled` and `cancelled`; the application may set
--                           `external_id` / `thread_key`, when the provider has accepted the message
--                           (T-122c matches replies on them). The text and the rest stay immutable.
--   6. inbound_message:     `reply_token_sealed`, the LINE reply token sealed (AES-256-GCM, bound to the
--                           row) until the dispatcher spends it once or the sweeper blanks it.
--
-- `ai_auto` is not a legal origin: in Phase 1 nothing an AI wrote reaches a customer without a person
-- (N3). Phase 3 widens the CHECK with its own ADR, owner decision and migration (ADR-011 section 2).
-- Not partitioned: the unique indexes below must hold across months, as for `message`.
-- Reversible: see 0013_outbound_delivery.down.sql.

-- 1. AI drafts.
CREATE TABLE ai_draft (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  -- The text as the AI wrote it, trimmed like a reply body. Immutable for the application role.
  body_text text NOT NULL,
  -- sha256 of the UTF-8 body, hex. Always overwritten by the trigger below on INSERT, so nobody can
  -- store a hash that does not match the text (a generated column cannot be used: convert_to() is
  -- only STABLE). Not updatable by the application, like the body.
  content_hash text NOT NULL DEFAULT '',
  -- draft: waiting for a person. approved: a person pressed send (delivery scheduled). sent: delivered.
  -- rejected: a person discarded it. Undoing a send returns an approved draft to draft.
  status text NOT NULL DEFAULT 'draft',
  -- The run that wrote it (audit link to the `ai_run` of T-106; no foreign key until that table exists).
  ai_run_id uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_draft_status_check CHECK (status IN ('draft', 'approved', 'sent', 'rejected')),
  CONSTRAINT ai_draft_body_check CHECK (body_text <> ''),
  CONSTRAINT ai_draft_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT ai_draft_approval_state CHECK ((status IN ('approved', 'sent')) = (approved_by IS NOT NULL))
);
CREATE FUNCTION ai_draft_set_hash() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.content_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.body_text, 'UTF8')), 'hex');
  RETURN NEW;
END
$$;
CREATE TRIGGER ai_draft_set_hash
  BEFORE INSERT ON ai_draft
  FOR EACH ROW EXECUTE FUNCTION ai_draft_set_hash();
CREATE INDEX ai_draft_ticket_idx ON ai_draft (ticket_id, created_at);
-- The text never changes after it was written; the application moves the status and the approval.
REVOKE UPDATE, DELETE ON ai_draft FROM watchtower_app, PUBLIC;
GRANT UPDATE (status, approved_by, approved_at) ON ai_draft TO watchtower_app;

-- 2. Deliveries.
CREATE TABLE outbound_delivery (
  -- Also the idempotency key at every provider that has one (LINE X-Line-Retry-Key, the Gmail Message-ID).
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  message_id uuid NOT NULL REFERENCES message (id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES channel_account (id) ON DELETE RESTRICT,
  channel text NOT NULL,
  -- Chosen at claim time (LINE: reply token or push); null while scheduled.
  route text,
  origin text NOT NULL,
  -- The auto-ack template; the body was rendered from it on the server (A-3).
  template_key text,
  -- The inputs the acknowledgment text was rendered from (ticket key, portal link, first-response
  -- target). The dispatcher renders again from them and compares with the message (review O-4).
  render_inputs jsonb,
  ai_draft_id uuid REFERENCES ai_draft (id) ON DELETE RESTRICT,
  -- sha256 of the message body when it was scheduled. The dispatcher refuses to send a body that no longer matches.
  content_hash text NOT NULL,
  -- The person who approved an AI draft. No foreign key, like audit_log.actor_id: the record must outlive the user.
  approved_by uuid,
  state text NOT NULL DEFAULT 'scheduled',
  hold_seconds integer NOT NULL,
  -- When the hold ends / when the next attempt may start. Undo works only before it.
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  -- Claim fencing (security review O-1): set to a fresh uuid by every claim and cleared when the row is
  -- released. Every write after the claim must present it, so a worker that stalled past its lease and
  -- was replaced can never dispatch or record a result.
  claim_token uuid,
  -- Set just before the provider is called: a `sending` row without it provably never reached the provider.
  dispatched_at timestamptz,
  provider_message_id text,
  -- Our RFC 5322 Message-ID, normalised (no brackets, lower case): replies quote it (T-122c thread matching).
  rfc822_message_id text,
  provider_thread_id text,
  error_code text,
  -- True when the provider may have sent it although we did not hear back: a retry may duplicate it.
  outcome_unknown boolean NOT NULL DEFAULT false,
  created_by uuid,
  cancelled_by uuid,
  cancelled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_delivery_state_check CHECK (state IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT outbound_delivery_channel_check CHECK (channel IN ('gmail', 'line')),
  CONSTRAINT outbound_delivery_route_check CHECK (
    route IS NULL
    OR (channel = 'line' AND route IN ('line_reply', 'line_push'))
    OR (channel = 'gmail' AND route IN ('gmail_thread', 'gmail_new'))
  ),
  CONSTRAINT outbound_delivery_origin_check CHECK (origin IN ('human', 'ai_approved', 'system_template')),
  CONSTRAINT outbound_delivery_origin_draft CHECK ((origin = 'ai_approved') = (ai_draft_id IS NOT NULL)),
  CONSTRAINT outbound_delivery_origin_approver CHECK ((origin = 'ai_approved') = (approved_by IS NOT NULL)),
  CONSTRAINT outbound_delivery_origin_template CHECK ((origin = 'system_template') = (template_key IS NOT NULL)),
  CONSTRAINT outbound_delivery_origin_creator CHECK ((origin = 'system_template') = (created_by IS NULL)),
  CONSTRAINT outbound_delivery_origin_render CHECK ((origin = 'system_template') = (render_inputs IS NOT NULL)),
  CONSTRAINT outbound_delivery_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outbound_delivery_hold_check CHECK (hold_seconds BETWEEN 0 AND 30),
  CONSTRAINT outbound_delivery_attempts_check CHECK (attempts >= 0),
  CONSTRAINT outbound_delivery_sending_lease CHECK (state <> 'sending' OR lease_until IS NOT NULL),
  CONSTRAINT outbound_delivery_sent_at CHECK (state <> 'sent' OR sent_at IS NOT NULL),
  CONSTRAINT outbound_delivery_failed_code CHECK (state <> 'failed' OR error_code IS NOT NULL),
  CONSTRAINT outbound_delivery_cancelled_at CHECK (state <> 'cancelled' OR cancelled_at IS NOT NULL)
);
-- One active delivery per message; a failed or cancelled one makes room for a Retry.
CREATE UNIQUE INDEX outbound_delivery_message_active_key ON outbound_delivery (message_id)
  WHERE state NOT IN ('failed', 'cancelled');
-- A draft is sent once.
CREATE UNIQUE INDEX outbound_delivery_draft_active_key ON outbound_delivery (ai_draft_id)
  WHERE ai_draft_id IS NOT NULL AND state NOT IN ('failed', 'cancelled');
CREATE INDEX outbound_delivery_due_idx ON outbound_delivery (next_attempt_at) WHERE state = 'scheduled';
CREATE INDEX outbound_delivery_lease_idx ON outbound_delivery (lease_until) WHERE state = 'sending';
CREATE INDEX outbound_delivery_ticket_idx ON outbound_delivery (ticket_id, created_at);
CREATE INDEX outbound_delivery_account_idx ON outbound_delivery (channel_account_id, updated_at DESC);
-- Thread matching of a customer's reply to our mail (In-Reply-To / References).
CREATE INDEX outbound_delivery_rfc822_idx ON outbound_delivery (channel_account_id, rfc822_message_id)
  WHERE rfc822_message_id IS NOT NULL;
-- Who, what and where never change; the application moves the state and records the result. No DELETE.
REVOKE UPDATE, DELETE ON outbound_delivery FROM watchtower_app, PUBLIC;
GRANT UPDATE (
  route, state, next_attempt_at, attempts, lease_until, claim_token, dispatched_at, provider_message_id,
  rfc822_message_id, provider_thread_id, error_code, outcome_unknown, cancelled_by, cancelled_at,
  sent_at, updated_at
) ON outbound_delivery TO watchtower_app;

-- Rules the database enforces itself, whatever the application does (security review O-3). They run for
-- every role, with a pinned search_path and qualified names (ADR-011 section 3).
--   Safe auto-acknowledgment keys. Adding one is a security-relevant change with its own reviewer (N7);
--   the domain's SAFE_AUTO_ACK_TEMPLATES must list the same keys (a test compares them).
CREATE TABLE outbound_template_allowlist (key text PRIMARY KEY);
INSERT INTO outbound_template_allowlist (key) VALUES ('auto_ack.received'), ('auto_ack.received_with_sla');
REVOKE INSERT, UPDATE, DELETE ON outbound_template_allowlist FROM watchtower_app, PUBLIC;

CREATE FUNCTION outbound_delivery_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  msg public.message%ROWTYPE;
  draft public.ai_draft%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO msg FROM public.message WHERE id = NEW.message_id;
    IF NOT FOUND OR msg.ticket_id <> NEW.ticket_id OR msg.direction <> 'outbound'
       OR msg.visibility <> 'public' OR msg.channel_account_id IS DISTINCT FROM NEW.channel_account_id THEN
      RAISE EXCEPTION 'outbound_delivery: the message is not a public outbound message of this ticket and account'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- The hash is the database's own reading of the message, never the caller's.
    NEW.content_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(msg.body_text, 'UTF8')), 'hex');
    IF NEW.state <> 'scheduled' OR NEW.attempts <> 0 OR NEW.route IS NOT NULL OR NEW.claim_token IS NOT NULL
       OR NEW.lease_until IS NOT NULL OR NEW.dispatched_at IS NOT NULL OR NEW.provider_message_id IS NOT NULL
       OR NEW.rfc822_message_id IS NOT NULL OR NEW.provider_thread_id IS NOT NULL OR NEW.error_code IS NOT NULL
       OR NEW.outcome_unknown OR NEW.sent_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL THEN
      RAISE EXCEPTION 'outbound_delivery: a delivery starts scheduled and empty'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.origin = 'ai_approved' THEN
      SELECT * INTO draft FROM public.ai_draft WHERE id = NEW.ai_draft_id;
      IF NOT FOUND OR draft.ticket_id <> NEW.ticket_id OR draft.status <> 'approved'
         OR draft.content_hash <> NEW.content_hash OR draft.approved_by IS DISTINCT FROM NEW.approved_by
         OR NEW.approved_by IS DISTINCT FROM NEW.created_by THEN
        RAISE EXCEPTION 'outbound_delivery: the AI draft is not approved for exactly this text by the sender'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF NEW.origin = 'system_template' THEN
      IF NOT EXISTS (SELECT 1 FROM public.outbound_template_allowlist WHERE key = NEW.template_key) THEN
        RAISE EXCEPTION 'outbound_delivery: template key is not on the safe list'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the state machine of ADR-010 section 2.
  IF OLD.state IN ('sent', 'cancelled') THEN
    RAISE EXCEPTION 'outbound_delivery: a % delivery does not change', OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'failed' THEN
    -- Only a provider that answers late after an unknown outcome may turn it into sent.
    IF NOT (OLD.outcome_unknown AND NEW.state = 'sent') THEN
      RAISE EXCEPTION 'outbound_delivery: a failed delivery does not change'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'scheduled' AND NEW.state IN ('sending', 'cancelled'))
         OR (OLD.state = 'sending' AND NEW.state IN ('sent', 'failed', 'scheduled', 'cancelled'))) THEN
      RAISE EXCEPTION 'outbound_delivery: % -> % is not a transition', OLD.state, NEW.state
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.state = 'scheduled' AND NEW.state = 'sending'
       AND (NEW.attempts <> OLD.attempts + 1 OR NEW.claim_token IS NULL) THEN
      RAISE EXCEPTION 'outbound_delivery: a claim counts an attempt and carries a claim token'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.state = 'sending' AND NEW.state = 'scheduled' AND NEW.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'outbound_delivery: releasing a claim clears its token'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbound_delivery_guard
  BEFORE INSERT OR UPDATE ON outbound_delivery
  FOR EACH ROW EXECUTE FUNCTION outbound_delivery_guard();

-- An AI draft's status follows its own rules: a person approves it (with name and time), the approval
-- is withdrawn by an undo, and sent or rejected is the end. While approved, the approval cannot be
-- swapped for another person's.
CREATE FUNCTION ai_draft_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('sent', 'rejected') AND (NEW.status <> OLD.status OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'ai_draft: a % draft does not change', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'sent', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sent'))
    -- A send that failed with an unknown outcome reopened the draft; a late success closes it.
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
CREATE TRIGGER ai_draft_guard
  BEFORE UPDATE ON ai_draft
  FOR EACH ROW EXECUTE FUNCTION ai_draft_guard();

-- 3. LINE quota counter.
CREATE TABLE channel_quota_usage (
  channel_account_id uuid NOT NULL REFERENCES channel_account (id) ON DELETE RESTRICT,
  -- Billing month, 'YYYY-MM' in the instance's business zone (LINE does not say which zone [VERIFY]).
  period text NOT NULL,
  -- Counted messages, reservations included (reserved at claim, given back after a send that provably did not happen).
  used integer NOT NULL DEFAULT 0,
  -- Monthly cap; null = unknown (nothing is blocked). Seeded from the plan's free allowance, then reconciled with LINE.
  quota_limit integer,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_account_id, period),
  CONSTRAINT channel_quota_usage_period_check CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT channel_quota_usage_used_check CHECK (used >= 0),
  CONSTRAINT channel_quota_usage_limit_check CHECK (quota_limit IS NULL OR quota_limit >= 0)
);
REVOKE DELETE ON channel_quota_usage FROM watchtower_app, PUBLIC;

-- 4. Instance settings.
CREATE TABLE instance_setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instance_setting_undo_send_check CHECK (
    key <> 'outbound.undo_send_seconds'
    OR CASE
         WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,2}$'
           THEN (value #>> '{}')::integer BETWEEN 0 AND 30
         ELSE false
       END
  )
);
INSERT INTO instance_setting (key, value) VALUES ('outbound.undo_send_seconds', '5'::jsonb);
-- Rows are created by migrations; the application only changes the value.
REVOKE INSERT, UPDATE, DELETE ON instance_setting FROM watchtower_app, PUBLIC;
GRANT UPDATE (value, updated_by, updated_at) ON instance_setting TO watchtower_app;

-- 5. message: two more delivery states, and the provider identity set when the provider accepted it.
--    Only `recordSent` writes these two columns; the unique key (channel_account_id, external_id) stops a duplicate.
ALTER TABLE message DROP CONSTRAINT message_delivery_check;
ALTER TABLE message ADD CONSTRAINT message_delivery_check CHECK (
  delivery_status IN ('not_applicable', 'pending', 'scheduled', 'delivered', 'failed', 'cancelled')
);
GRANT UPDATE (external_id, thread_key) ON message TO watchtower_app;

-- 6. LINE reply token (sealed), spent by the dispatcher with a conditional UPDATE.
ALTER TABLE inbound_message ADD COLUMN reply_token_sealed text;
GRANT UPDATE (reply_token_sealed) ON inbound_message TO watchtower_app;
CREATE INDEX inbound_message_reply_token_idx ON inbound_message (ticket_id, received_at DESC)
  WHERE reply_token_sealed IS NOT NULL;
