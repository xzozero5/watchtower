-- T-122f: follow-up to the T-122e re-review of outbound delivery (ADR-010).
--   F-1  a LINE push that was attempted before (route = line_push) can no longer become `cancelled`: neither by
--        the undo, nor by a policy refusal at the next claim. It may have reached the customer, so "cancelled"
--        (certainly not sent) would be false; the application ends it `failed` with `outcome_unknown`.
--   F-3  `route` is written once (the one change allowed: a LINE reply whose token was refused goes out as a
--        push), and `dispatched_at` is cleared only when a claim is released.
--   F-4  the link of an automatic message is exactly the stored portal address: stored addresses are plain
--        ASCII, and the two link sentences are taken out before the body is matched, so text glued to the
--        link (a no-break space, Thai without a space) is refused.
--   N-1  a `human` delivery whose text is the text of an unsent AI draft of the same ticket is refused: it
--        must go as the draft, through the policy gate.
-- `outbound_delivery_guard()` is replaced in place (0014 stays as applied).
-- Reversible: 0035_outbound_followup.down.sql restores the 0014 function.

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
  v_en text;
  v_th text;
  stripped text;
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
    -- T-122f N-1: the text of an AI draft that nobody sent yet is not a person's own reply. It goes out as
    -- the draft (`ai_approved`, which the policy gate judges), or the person edits it first.
    IF NEW.origin = 'human' AND EXISTS (
         SELECT 1 FROM public.ai_draft d
          WHERE d.ticket_id = NEW.ticket_id AND d.content_hash = NEW.content_hash AND d.status <> 'sent') THEN
      RAISE EXCEPTION 'outbound_delivery: this is the text of an AI draft; send it as the draft'
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
                  OR (v_portal #>> '{}') !~ '^https?://[A-Za-z0-9._~:/?#@!$&''()*+,;=%-]+$'
                  OR pg_catalog.strpos(msg.body_text, v_portal #>> '{}') = 0))
         OR (v_due IS NOT NULL AND pg_catalog.jsonb_typeof(v_due) <> 'null'
             AND (pg_catalog.jsonb_typeof(v_due) <> 'string'
                  OR (v_due #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'))) THEN
        RAISE EXCEPTION 'outbound_delivery: the inputs of an automatic message must be plain facts shown in its text'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- T-122f F-4: the link in the text is exactly the stored portal address and nothing else. The pattern
      -- above lets "any non-space characters" stand for a link, which would also take a no-break space or
      -- Thai written straight after it. So take the two exact link sentences out first: what is left must be
      -- the text of the template WITHOUT a link (the pattern's link groups are optional), and a template
      -- that has a link address must carry both sentences.
      IF v_portal IS NOT NULL AND pg_catalog.jsonb_typeof(v_portal) = 'string' THEN
        v_en := ' You can follow it at ' || (v_portal #>> '{}');
        v_th := ' ติดตามสถานะได้ที่ ' || (v_portal #>> '{}');
        IF pg_catalog.strpos(msg.body_text, v_en) = 0 OR pg_catalog.strpos(msg.body_text, v_th) = 0 THEN
          RAISE EXCEPTION 'outbound_delivery: the text does not carry the portal address of its inputs'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        stripped := pg_catalog.replace(pg_catalog.replace(msg.body_text, v_en, ''), v_th, '');
      ELSE
        stripped := msg.body_text;
      END IF;
      IF stripped !~ pattern OR stripped ~ 'You can follow it at|ติดตามสถานะได้ที่' THEN
        RAISE EXCEPTION 'outbound_delivery: the text carries something other than the portal address of its inputs'
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
  -- T-122f F-3: the route is chosen once. The only change is a LINE reply whose token was refused and
  -- went out as a push instead; a push stays a push (its retry key), a Gmail route stays what it was.
  IF OLD.route IS NOT NULL AND NEW.route IS DISTINCT FROM OLD.route
     AND NOT (OLD.state = 'sending' AND OLD.route = 'line_reply' AND NEW.route = 'line_push') THEN
    RAISE EXCEPTION 'outbound_delivery: the route is written once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- T-122f F-3: "the provider call was about to start" is cleared only when the claim is released.
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NULL
     AND NOT (OLD.state = 'sending' AND NEW.state = 'scheduled') THEN
    RAISE EXCEPTION 'outbound_delivery: dispatched_at is cleared only when a claim is released'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- T-122f F-1: once a push has gone out in an earlier attempt, "cancelled" (certainly not sent) would be a
  -- false statement. The delivery goes on to sent, or to failed with the unknown outcome.
  IF NEW.state = 'cancelled' AND OLD.route = 'line_push' THEN
    RAISE EXCEPTION 'outbound_delivery: a push that was attempted may have reached the customer and cannot be cancelled'
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
