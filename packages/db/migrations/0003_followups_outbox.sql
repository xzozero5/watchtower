-- T-013: review follow-ups of T-005.
--   1. org_tier: tiers are data, not a CHECK list (an admin can add a tier without a migration).
--   2. A contact or a queue that tickets or messages still point at can no longer be deleted
--      silently: the foreign keys become RESTRICT and the API answers 409.
--   3. message: the application role loses DELETE and can UPDATE only the columns code changes.
--   4. Foreign-key-side indexes that 0002 left out, so RESTRICT checks and joins do not scan.
--   5. outbox: the transactional outbox behind every BullMQ enqueue (ADR-006, PRD section 8.3).
-- Reversible: see 0003_followups_outbox.down.sql.

-- 1. Tiers as data. `organization.tier` and `sla_policy.tier` stay text columns; a foreign key to
--    this table says which values exist. ON UPDATE CASCADE lets an admin rename a slug.
CREATE TABLE org_tier (
  slug text PRIMARY KEY,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_tier_slug_check CHECK (slug ~ '^[a-z][a-z0-9_-]{0,31}$')
);
-- [ASSUMED] Gold/Silver/Standard from PRD R-1.6: neutral names, the numbers live in the SLA policies.
INSERT INTO org_tier (slug, name, sort_order) VALUES
  ('gold', 'Gold', 10),
  ('silver', 'Silver', 20),
  ('standard', 'Standard', 30);

ALTER TABLE organization DROP CONSTRAINT organization_tier_check;
ALTER TABLE organization
  ADD CONSTRAINT organization_tier_fkey
  FOREIGN KEY (tier) REFERENCES org_tier (slug) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE sla_policy DROP CONSTRAINT sla_policy_tier_check;
ALTER TABLE sla_policy
  ADD CONSTRAINT sla_policy_tier_fkey
  FOREIGN KEY (tier) REFERENCES org_tier (slug) ON UPDATE CASCADE ON DELETE RESTRICT;

-- 2. Deleting a contact or a queue must not rewrite history. 0002 used ON DELETE SET NULL, which
--    erased who a ticket was from. RESTRICT makes the database refuse; erasing a person for PDPA
--    is a separate, deliberate flow (anonymize, not delete) that does not exist yet.
ALTER TABLE ticket DROP CONSTRAINT ticket_requester_contact_id_fkey;
ALTER TABLE ticket
  ADD CONSTRAINT ticket_requester_contact_id_fkey
  FOREIGN KEY (requester_contact_id) REFERENCES contact (id) ON DELETE RESTRICT;
ALTER TABLE ticket DROP CONSTRAINT ticket_queue_id_fkey;
ALTER TABLE ticket
  ADD CONSTRAINT ticket_queue_id_fkey
  FOREIGN KEY (queue_id) REFERENCES team_queue (id) ON DELETE RESTRICT;
ALTER TABLE message DROP CONSTRAINT message_sender_contact_id_fkey;
ALTER TABLE message
  ADD CONSTRAINT message_sender_contact_id_fkey
  FOREIGN KEY (sender_contact_id) REFERENCES contact (id) ON DELETE RESTRICT;

-- 3. Messages are a record of what was said: the application never deletes one and edits none of
--    the text. The only columns code updates are the delivery state (an adapter reports that a
--    send succeeded or failed) and the PII-redacted copy the AI layer fills in (N4). Every other
--    column is immutable for the application role; the schema owner can still correct data.
REVOKE UPDATE, DELETE ON message FROM watchtower_app, PUBLIC;
GRANT UPDATE (delivery_status, body_redacted) ON message TO watchtower_app;

-- 4. Foreign-key-side indexes. Partial where the column is mostly NULL (client messages have no
--    sender_user_id), which keeps them small; an equality lookup still uses a partial index.
CREATE INDEX message_sender_contact_idx ON message (sender_contact_id) WHERE sender_contact_id IS NOT NULL;
CREATE INDEX message_sender_user_idx ON message (sender_user_id) WHERE sender_user_id IS NOT NULL;
CREATE INDEX ticket_queue_id_idx ON ticket (queue_id) WHERE queue_id IS NOT NULL;
CREATE INDEX ticket_intent_idx ON ticket (intent_id) WHERE intent_id IS NOT NULL;

-- 5. Transactional outbox. Business code inserts a row in the same transaction as the change that
--    needs a job; a relay in apps/worker moves pending rows to BullMQ and marks them sent, so a
--    Redis outage delays a job and never loses it (at-least-once; job_id is the idempotency key).
--    `payload` can carry a one-time secret (a magic link): it is blanked as soon as the row is sent
--    or declared dead, and sent rows are purged after a week.
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue text NOT NULL,
  job_name text NOT NULL,
  -- The BullMQ jobId: enqueueing the same (queue, job_id) twice sends once.
  job_id text NOT NULL,
  payload jsonb NOT NULL,
  -- BullMQ job options (attempts, backoff, removeOnComplete, ...), validated by the application.
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  -- Failed hand-overs to Redis so far; drives the retry delay.
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- A relay that claimed the row holds it until then; a crashed relay's claim simply expires.
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT outbox_status_check CHECK (status IN ('pending', 'sent', 'dead')),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_options_object CHECK (jsonb_typeof(options) = 'object')
);
CREATE UNIQUE INDEX outbox_job_key ON outbox (queue, job_id);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX outbox_finished_idx ON outbox (finished_at) WHERE status <> 'pending';
