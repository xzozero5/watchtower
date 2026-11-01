-- Reverts 0014: the 0013 guard comes back, the extra column and the permission go. Grants of the
-- permission (including any made by hand) go with it (ON DELETE CASCADE).
DELETE FROM permissions WHERE key = 'ticket.cancel.any';

CREATE OR REPLACE FUNCTION outbound_delivery_guard() RETURNS trigger
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

ALTER TABLE outbound_template_allowlist DROP COLUMN IF EXISTS body_pattern;
