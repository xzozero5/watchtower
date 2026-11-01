-- T-122e: security re-review of T-122d (N-1, N-3, and the permission N-4 needs).
--   N-1  who wrote the message: a `human` / `ai_approved` delivery needs `message.sender_user_id` to be the
--        person who created it (so an app-role insert cannot pair an AI-authored message, which has no
--        sender, with a human origin and pass the gate as that person). A `system_template` delivery needs a
--        message with no sender.
--   N-3  state machine: the claim token cannot change while `sending` (only a claim sets it, only a release
--        clears it), `attempts` moves only at a claim, a `sending` row that reached the provider does not go
--        back to `scheduled` unless it is a LINE push (retry key) or the application attests that the provider
--        refused it (`error_code` set, `outcome_unknown` false), a template delivery carries no free text
--        (the message must match the key's pattern and the stored inputs must be plain facts), and the
--        delivery channel must be the type of its channel account.
--   N-4  `ticket.cancel.any`: undo a colleague's pending send (lead and head), replacing a role-name check.
-- `outbound_delivery_guard()` is replaced in place (0013 is checksummed and stays as applied).
-- Reversible: see 0014_outbound_hardening.down.sql (it restores the 0013 function).

-- 1. The shape of each automatic text, kept next to the key (Postgres regular expression). The domain's
--    renderers must produce text that matches; a test renders every key and checks it against this column.
ALTER TABLE outbound_template_allowlist ADD COLUMN body_pattern text;
UPDATE outbound_template_allowlist SET body_pattern =
  '^We have received your request and filed it as [A-Z][A-Z0-9]{1,9}-[0-9]+\. Our team will review it and reply here\.( You can follow it at https?://[^[:space:]]+)?'
  || E'\n\n'
  || 'เราได้รับเรื่องของคุณแล้ว และบันทึกเป็นหมายเลข [A-Z][A-Z0-9]{1,9}-[0-9]+ ทีมงานจะตรวจสอบและตอบกลับที่นี่( ติดตามสถานะได้ที่ https?://[^[:space:]]+)?$'
WHERE key = 'auto_ack.received';
UPDATE outbound_template_allowlist SET body_pattern =
  '^We have received your request and filed it as [A-Z][A-Z0-9]{1,9}-[0-9]+\. Our team will review it and reply here\.( You can follow it at https?://[^[:space:]]+)?'
  || E'\n\n'
  || 'เราได้รับเรื่องของคุณแล้ว และบันทึกเป็นหมายเลข [A-Z][A-Z0-9]{1,9}-[0-9]+ ทีมงานจะตรวจสอบและตอบกลับที่นี่( ติดตามสถานะได้ที่ https?://[^[:space:]]+)?'
  || E'(\n\n'
  || 'We aim to reply by [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} \(UTC\+7\)\.'
  || E'\n\n'
  || 'เราตั้งเป้าตอบกลับภายใน [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} \(UTC\+7\))?$'
WHERE key = 'auto_ack.received_with_sla';
ALTER TABLE outbound_template_allowlist ALTER COLUMN body_pattern SET NOT NULL;

-- 2. The guard.
CREATE OR REPLACE FUNCTION outbound_delivery_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  msg public.message%ROWTYPE;
  draft public.ai_draft%ROWTYPE;
  account_type text;
  pattern text;
  v_ticket_key text;
  v_portal jsonb;
  v_due jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO msg FROM public.message WHERE id = NEW.message_id;
    IF NOT FOUND OR msg.ticket_id <> NEW.ticket_id OR msg.direction <> 'outbound'
       OR msg.visibility <> 'public' OR msg.channel_account_id IS DISTINCT FROM NEW.channel_account_id THEN
      RAISE EXCEPTION 'outbound_delivery: the message is not a public outbound message of this ticket and account'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- N-3: the channel is the kind of account the message goes through.
    SELECT type INTO account_type FROM public.channel_account WHERE id = NEW.channel_account_id;
    IF account_type IS DISTINCT FROM NEW.channel THEN
      RAISE EXCEPTION 'outbound_delivery: the channel does not match the type of the channel account'
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
    -- N-1: a person's send is the message that person wrote.
    IF NEW.origin IN ('human', 'ai_approved')
       AND (msg.sender_user_id IS NULL OR NEW.created_by IS NULL OR msg.sender_user_id <> NEW.created_by) THEN
      RAISE EXCEPTION 'outbound_delivery: a person''s send must carry a message written by that person'
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
      SELECT body_pattern INTO pattern FROM public.outbound_template_allowlist WHERE key = NEW.template_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'outbound_delivery: template key is not on the safe list'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- N-1 / N-3: an automatic message has no author and no free text.
      IF msg.sender_user_id IS NOT NULL OR msg.sender_contact_id IS NOT NULL OR msg.body_html IS NOT NULL THEN
        RAISE EXCEPTION 'outbound_delivery: an automatic message has no author'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF msg.body_text !~ pattern THEN
        RAISE EXCEPTION 'outbound_delivery: the body is not the text of the template'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      v_ticket_key := NEW.render_inputs ->> 'ticketKey';
      v_portal := NEW.render_inputs -> 'portalUrl';
      v_due := NEW.render_inputs -> 'firstResponseDueAt';
      -- (Missing inputs are refused by the table's own CHECK.)
      IF NEW.render_inputs IS NOT NULL AND (pg_catalog.jsonb_typeof(NEW.render_inputs) <> 'object'
         OR EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_object_keys(NEW.render_inputs) AS k(name)
            WHERE k.name NOT IN ('ticketKey', 'portalUrl', 'firstResponseDueAt')
         )
         OR pg_catalog.jsonb_typeof(NEW.render_inputs -> 'ticketKey') IS DISTINCT FROM 'string'
         OR v_ticket_key !~ '^[A-Z][A-Z0-9]{1,9}-[0-9]+$'
         OR pg_catalog.strpos(msg.body_text, v_ticket_key) = 0
         OR (v_portal IS NOT NULL AND pg_catalog.jsonb_typeof(v_portal) <> 'null'
             AND (pg_catalog.jsonb_typeof(v_portal) <> 'string'
                  OR (v_portal #>> '{}') !~ '^https?://[^[:space:]]+$'
                  OR pg_catalog.strpos(msg.body_text, v_portal #>> '{}') = 0))
         OR (v_due IS NOT NULL AND pg_catalog.jsonb_typeof(v_due) <> 'null'
             AND (pg_catalog.jsonb_typeof(v_due) <> 'string'
                  OR (v_due #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'))) THEN
        RAISE EXCEPTION 'outbound_delivery: the inputs of an automatic message must be plain facts shown in its text'
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
    IF NEW.claim_token IS DISTINCT FROM OLD.claim_token OR NEW.attempts <> OLD.attempts THEN
      RAISE EXCEPTION 'outbound_delivery: a late answer does not change the claim or the attempts'
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
    IF OLD.state = 'sending' AND NEW.state = 'scheduled' THEN
      IF NEW.claim_token IS NOT NULL THEN
        RAISE EXCEPTION 'outbound_delivery: releasing a claim clears its token'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- N-3: the next attempt writes dispatched_at again; and a row that reached the provider goes back
      -- only when a repeat is safe: a LINE push (retry key), or the provider refused it and the application
      -- says so (error_code set, outcome known).
      IF NEW.dispatched_at IS NOT NULL THEN
        RAISE EXCEPTION 'outbound_delivery: releasing a claim clears dispatched_at'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.dispatched_at IS NOT NULL AND OLD.route IS DISTINCT FROM 'line_push'
         AND (NEW.error_code IS NULL OR NEW.outcome_unknown) THEN
        RAISE EXCEPTION 'outbound_delivery: a delivery that reached the provider does not go back to scheduled without a refusal'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  -- N-3: attempts count claims, nothing else.
  IF NOT (OLD.state = 'scheduled' AND NEW.state = 'sending') AND NEW.attempts <> OLD.attempts THEN
    RAISE EXCEPTION 'outbound_delivery: attempts change only at a claim'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- N-3: the claim token is set by a claim, cleared by a release, and otherwise stays what it is.
  IF OLD.state = 'scheduled' AND NEW.state = 'sending' THEN
    NULL; -- checked above
  ELSIF NEW.state = 'scheduled' THEN
    IF NEW.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'outbound_delivery: a scheduled delivery holds no claim token'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
    RAISE EXCEPTION 'outbound_delivery: the claim token cannot change while the delivery is claimed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 3. N-4: the permission to undo a colleague's pending send.
INSERT INTO permissions (key, description) VALUES
  ('ticket.cancel.any', 'Undo a colleague''s send before it goes out');
INSERT INTO role_permissions (role, permission) VALUES
  ('lead', 'ticket.cancel.any'),
  ('head', 'ticket.cancel.any');
