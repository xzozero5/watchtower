-- T-202c: mass customer communication from an incident (PRD R-3.14, N3). Reversible:
-- 0046_incident_comm.down.sql.
--
--   incident_comm           one update drafted for the customers of an incident's linked tickets. A draft is
--                           written by a person or by the AI (`origin`); it is only ever SENT by a person:
--                           `sent_by` is required as soon as the status leaves `draft`, so no code path, AI or
--                           system, can leave a comm sending or sent without a human who pressed the button.
--                           `confirmed_recipients` is the count that person saw and confirmed.
--   incident_comm_delivery  what happened for one ticket. PRIMARY KEY (comm_id, ticket_id): a ticket gets the
--                           update once however often a send is resumed. The message itself goes through the
--                           normal outbound dispatcher (ADR-010), one ticket at a time, like a staff reply.
--
-- Clock: created_at and sent_at are the database clock.

CREATE TABLE incident_comm (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incident (id) ON DELETE RESTRICT,
  body text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  drafted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  sent_by uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_recipients integer,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT incident_comm_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  CONSTRAINT incident_comm_origin_check CHECK (origin IN ('human', 'ai')),
  CONSTRAINT incident_comm_status_check CHECK (status IN ('draft', 'sending', 'sent', 'cancelled')),
  -- N3: only a person sends. A comm that is sending or sent has the person who pressed the button and the
  -- recipient count they confirmed; a draft has neither.
  CONSTRAINT incident_comm_human_sends CHECK (
    status = 'cancelled'
    OR (
      (status IN ('sending', 'sent')) = (sent_by IS NOT NULL AND confirmed_recipients IS NOT NULL)
      AND (status <> 'draft' OR (sent_by IS NULL AND confirmed_recipients IS NULL))
    )
  ),
  CONSTRAINT incident_comm_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT incident_comm_recipients_check CHECK (confirmed_recipients IS NULL OR confirmed_recipients >= 0)
);
CREATE INDEX incident_comm_incident_idx ON incident_comm (incident_id, created_at DESC);

CREATE TABLE incident_comm_delivery (
  comm_id uuid NOT NULL REFERENCES incident_comm (id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  -- `sent`: the reply was made (for Gmail and LINE it is now scheduled with the dispatcher, whose own
  -- ledger says when the provider accepted it). `failed`: it could not be made; `reason` is a stable code.
  state text NOT NULL,
  message_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (comm_id, ticket_id),
  CONSTRAINT incident_comm_delivery_state_check CHECK (state IN ('sent', 'failed')),
  CONSTRAINT incident_comm_delivery_reason_check CHECK ((state = 'failed') = (reason IS NOT NULL)),
  CONSTRAINT incident_comm_delivery_message_check CHECK (message_id IS NULL OR state = 'sent')
);
CREATE INDEX incident_comm_delivery_ticket_idx ON incident_comm_delivery (ticket_id);
