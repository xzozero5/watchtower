-- T-122c: inbound ingestion (ADR-009 section 5, PRD section 4.2 R-2.2 / R-2.3 / R-2.6 / R-2.7 / R-2.9).
--   inbound_event:   one row per provider notification, written by the thin webhook receiver (api)
--                    together with an `ingest` outbox job. The unique key makes a redelivery a no-op
--                    (Pub/Sub messageId, LINE webhookEventId). `payload` holds the little the worker
--                    needs to fetch or normalise the event and is blanked once the event is processed.
--   inbound_message: one row per received message, whatever became of it. `disposition` says whether
--                    it opened a ticket, joined one, or stayed out of the ticket flow (noise,
--                    auto_reply, internal): those are the rows of the "Other mail" view (R-2.7).
-- Neither table is partitioned: the unique keys must hold across months (same reason as `message`).
-- Reversible: see 0008_inbound.down.sql.

CREATE TABLE inbound_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL REFERENCES channel_account (id) ON DELETE RESTRICT,
  -- Gmail: the Pub/Sub messageId (or the Gmail message id for a full sync). LINE: webhookEventId.
  provider_event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- What the receiver stored to process the event later; may hold personal data until processed,
  -- so the worker sets it back to '{}' as soon as the raw copy is in object storage (ADR-009 risk 6).
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Object storage key of the raw copy (set when the event produced exactly one message).
  raw_object_key text,
  status text NOT NULL DEFAULT 'pending',
  error_code text,
  processed_at timestamptz,
  CONSTRAINT inbound_event_status_check CHECK (status IN ('pending', 'processed', 'failed')),
  CONSTRAINT inbound_event_payload_check CHECK (jsonb_typeof(payload) = 'object')
);
-- The idempotency key of ingestion.
CREATE UNIQUE INDEX inbound_event_provider_key ON inbound_event (channel_account_id, provider_event_id);
-- "What is waiting to be processed", oldest first (monitoring and a backstop for the relay).
CREATE INDEX inbound_event_pending_idx ON inbound_event (received_at) WHERE status = 'pending';
-- Retention (7 days [ASSUMED]): finished events are deleted by age.
CREATE INDEX inbound_event_retention_idx ON inbound_event (received_at) WHERE status <> 'pending';

CREATE TABLE inbound_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL REFERENCES channel_account (id) ON DELETE RESTRICT,
  -- The event that brought it; the event is deleted after a week, the message stays.
  inbound_event_id uuid REFERENCES inbound_event (id) ON DELETE SET NULL,
  -- Gmail message id, LINE message id: the dedupe key (R-2.2, R-2.9).
  provider_message_id text NOT NULL,
  -- RFC 5322 Message-ID, normalised (no brackets, lower case): the secondary dedupe key and the
  -- target of In-Reply-To / References (R-2.2, R-2.3).
  rfc822_message_id text,
  -- Stable conversation key: `gmail:<threadId>`, `msgid:<root>`, `line:<conversationId>`.
  thread_key text,
  -- Candidates for thread matching, in priority order: [{ "kind": "...", "value": "..." }].
  thread_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Sender as received. An address or a LINE user id is personal data: it stays in this table only.
  from_address text,
  from_name text,
  line_user_id text,
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  body_html text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at timestamptz NOT NULL,
  -- Object storage key of the raw message (.eml / event JSON).
  raw_object_key text,
  -- What the adapter's header rules said (human | auto_reply | noise, subtype, signals).
  automated jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What decided it: { type, intentKey, confidence, source: 'ai' | 'rules', aiRunId }.
  classification jsonb NOT NULL DEFAULT '{}'::jsonb,
  disposition text NOT NULL DEFAULT 'pending',
  -- Set for `ticket` (the ticket it opened) and `appended` (the ticket it joined).
  ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  message_id uuid REFERENCES message (id) ON DELETE RESTRICT,
  -- Who set the disposition: 'system' (ingestion) or a user id (a person converted it).
  disposition_by text,
  disposition_at timestamptz,
  -- The disposition this row had before a person converted it ("This is a ticket").
  converted_from text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_message_disposition_check CHECK (
    disposition IN ('pending', 'ticket', 'appended', 'noise', 'auto_reply', 'internal')
  ),
  CONSTRAINT inbound_message_converted_from_check CHECK (
    converted_from IS NULL OR converted_from IN ('noise', 'auto_reply', 'internal')
  ),
  -- A ticket link exactly when the message is part of a ticket.
  CONSTRAINT inbound_message_ticket_link_check CHECK (
    (disposition IN ('ticket', 'appended')) = (ticket_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX inbound_message_provider_key ON inbound_message (channel_account_id, provider_message_id);
-- "Other mail": what did not become a ticket, newest first.
CREATE INDEX inbound_message_other_idx ON inbound_message (disposition, received_at DESC)
  WHERE disposition IN ('noise', 'auto_reply', 'internal');
-- Thread matching.
CREATE INDEX inbound_message_rfc822_idx ON inbound_message (channel_account_id, rfc822_message_id)
  WHERE rfc822_message_id IS NOT NULL;
-- Foreign-key side indexes.
CREATE INDEX inbound_message_event_idx ON inbound_message (inbound_event_id)
  WHERE inbound_event_id IS NOT NULL;
CREATE INDEX inbound_message_ticket_idx ON inbound_message (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX inbound_message_message_idx ON inbound_message (message_id) WHERE message_id IS NOT NULL;
-- Rows left pending by a crash between the steps of ingestion.
CREATE INDEX inbound_message_pending_idx ON inbound_message (created_at) WHERE disposition = 'pending';

-- Thread matching by Gmail thread id reads message.thread_key (set when a message is saved). The
-- existing message_external_key covers lookups by provider message id.
CREATE INDEX message_thread_key_idx ON message (channel_account_id, thread_key) WHERE thread_key IS NOT NULL;

-- Privileges, least privilege on top of the default privileges of 0001:
--   inbound_event:   the receiver inserts; ingestion reads it and records the outcome. The identity
--                    columns never change after the insert. Finished events are deleted by the
--                    retention job (DELETE stays granted).
--   inbound_message: ingestion inserts and decides. Content (addresses, subject, bodies, thread
--                    keys) is immutable for the application: only the outcome columns update. The
--                    application never deletes one; the retention of noise (90 days [ASSUMED])
--                    needs its own grant in the migration that adds that job.
REVOKE UPDATE ON inbound_event FROM watchtower_app, PUBLIC;
GRANT UPDATE (payload, raw_object_key, status, error_code, processed_at) ON inbound_event TO watchtower_app;

REVOKE UPDATE, DELETE ON inbound_message FROM watchtower_app, PUBLIC;
GRANT UPDATE (
  inbound_event_id, raw_object_key, classification, disposition, ticket_id, message_id,
  disposition_by, disposition_at, converted_from
) ON inbound_message TO watchtower_app;
