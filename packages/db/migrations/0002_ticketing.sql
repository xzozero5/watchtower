-- T-005: organizations, contacts, team queues, intents, SLA policies, business calendars, tickets,
-- messages and the ticket event log (PRD section 7), and the foreign key from users.org_id that
-- T-004 left open.
-- Hand-written SQL for the same reason as 0001: drizzle-kit cannot declare PARTITION BY, triggers or
-- privileges. packages/db/src/schema/ticketing.ts mirrors these tables.
--
-- Privileges: `watchtower_app` gets SELECT/INSERT/UPDATE/DELETE on every table here through the
-- default privileges from 0001, except ticket_event (append-only, see section 12).
--
-- Not created yet because no Phase 0 feature uses them: alert, incident, service, deploy, KB,
-- shift, ai_*, csat_survey, usage_*, status_*, notification. incident_id, runbook_article_id and
-- procedure_version_id on the tables below are plain uuid columns until those tables exist.

-- 1. Helpers.

-- True when every element is non-empty and already trimmed and lower-cased.
CREATE FUNCTION is_normalized_text_array(items text[]) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(items) AS item WHERE item IS NULL OR item = '' OR item <> lower(btrim(item))
  )
$$;

-- No two rows may share an element of a text[] column (an email domain belongs to one organization,
-- an email address to one contact). TG_ARGV[0] is the column. The advisory lock makes two
-- concurrent transactions queue up, so the second sees the first one's committed row; a plain
-- unique index cannot express "overlapping arrays".
CREATE FUNCTION enforce_unique_array_elements() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  column_name text := TG_ARGV[0];
  mine text[];
  clash integer;
BEGIN
  mine := ARRAY(SELECT jsonb_array_elements_text(to_jsonb(NEW) -> column_name));
  IF cardinality(mine) = 0 THEN
    RETURN NEW;
  END IF;
  IF cardinality(mine) <> (SELECT count(DISTINCT item) FROM unnest(mine) AS item) THEN
    RAISE EXCEPTION 'duplicate value inside %.%', TG_TABLE_NAME, column_name
      USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || '.' || column_name, 0));
  EXECUTE format(
    'SELECT 1 FROM %I.%I AS other WHERE other.%I && $1 AND other.id <> $2 LIMIT 1',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, column_name
  ) INTO clash USING mine, NEW.id;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'a value of %.% already belongs to another row', TG_TABLE_NAME, column_name
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 2. Business calendars and SLA policies.
CREATE TABLE business_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  -- {"mon": [{"start": "09:00", "end": "18:00"}], ...}; validated by the API (packages/shared/src/sla.ts).
  hours jsonb NOT NULL,
  -- [{"date": "2026-12-31", "name": "..."}], dates in `timezone`.
  holidays jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_calendar_hours_object CHECK (jsonb_typeof(hours) = 'object'),
  CONSTRAINT business_calendar_holidays_array CHECK (jsonb_typeof(holidays) = 'array')
);
CREATE UNIQUE INDEX business_calendar_name_key ON business_calendar (lower(name));
CREATE UNIQUE INDEX business_calendar_default_key ON business_calendar (is_default) WHERE is_default;

CREATE TABLE sla_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- The organization tier this policy is the default for (at most one policy per tier).
  tier text,
  -- {"P1": {"first_response_min": 15, "resolution_min": 240, "calendar": "24x7"}, ...}
  targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_calendar_id uuid REFERENCES business_calendar (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sla_policy_tier_check CHECK (tier IS NULL OR tier IN ('gold', 'silver', 'standard')),
  CONSTRAINT sla_policy_targets_object CHECK (jsonb_typeof(targets) = 'object')
);
CREATE UNIQUE INDEX sla_policy_name_key ON sla_policy (lower(name));
CREATE UNIQUE INDEX sla_policy_tier_key ON sla_policy (tier) WHERE tier IS NOT NULL;

-- 3. Team queues. Members are rows, not an array, so they can reference users.
CREATE TABLE team_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  assignment_mode text NOT NULL DEFAULT 'manual',
  -- Tickets created without a queue land in the default one.
  is_default boolean NOT NULL DEFAULT false,
  -- Round-robin cursor: the member who was handed the previous ticket.
  last_assigned_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_queue_mode_check CHECK (assignment_mode IN ('manual', 'round_robin'))
);
CREATE UNIQUE INDEX team_queue_name_key ON team_queue (lower(name));
CREATE UNIQUE INDEX team_queue_default_key ON team_queue (is_default) WHERE is_default;

CREATE TABLE team_queue_member (
  queue_id uuid NOT NULL REFERENCES team_queue (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, user_id)
);
CREATE INDEX team_queue_member_user_idx ON team_queue_member (user_id);

-- 4. Organizations and contacts.
CREATE TABLE organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tier text NOT NULL DEFAULT 'standard',
  sla_policy_id uuid REFERENCES sla_policy (id) ON DELETE RESTRICT,
  -- Email domains whose owners may sign in as this organization's clients (PRD section 2.3).
  domains text[] NOT NULL DEFAULT '{}',
  line_group_ids text[] NOT NULL DEFAULT '{}',
  health_score smallint,
  primary_contact_id uuid,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_tier_check CHECK (tier IN ('gold', 'silver', 'standard')),
  CONSTRAINT organization_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT organization_health_check CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100),
  CONSTRAINT organization_domains_normalized CHECK (is_normalized_text_array(domains))
);
CREATE INDEX organization_domains_idx ON organization USING gin (domains);
CREATE INDEX organization_name_trgm_idx ON organization USING gin (name gin_trgm_ops);
CREATE TRIGGER organization_domains_unique
  BEFORE INSERT OR UPDATE OF domains ON organization
  FOR EACH ROW EXECUTE FUNCTION enforce_unique_array_elements('domains');

CREATE TABLE contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organization (id) ON DELETE RESTRICT,
  name text NOT NULL,
  emails text[] NOT NULL DEFAULT '{}',
  line_user_id text,
  phone text,
  verified_at timestamptz,
  role_in_org text,
  notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_emails_normalized CHECK (is_normalized_text_array(emails)),
  CONSTRAINT contact_has_email CHECK (cardinality(emails) >= 1 OR line_user_id IS NOT NULL)
);
CREATE INDEX contact_org_idx ON contact (org_id);
CREATE INDEX contact_emails_idx ON contact USING gin (emails);
CREATE INDEX contact_name_trgm_idx ON contact USING gin (name gin_trgm_ops);
CREATE UNIQUE INDEX contact_line_user_key ON contact (line_user_id) WHERE line_user_id IS NOT NULL;
CREATE TRIGGER contact_emails_unique
  BEFORE INSERT OR UPDATE OF emails ON contact
  FOR EACH ROW EXECUTE FUNCTION enforce_unique_array_elements('emails');

ALTER TABLE organization
  ADD CONSTRAINT organization_primary_contact_fkey
  FOREIGN KEY (primary_contact_id) REFERENCES contact (id) ON DELETE SET NULL;

-- The key T-004 left open: a client user belongs to an organization that exists.
ALTER TABLE users
  ADD CONSTRAINT users_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES organization (id) ON DELETE RESTRICT;

-- 5. Channel accounts. Phase 0 has the portal only; the config column is for the integrations
--    that arrive later (encrypted by the application, never plain text).
CREATE TABLE channel_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  name text NOT NULL,
  config_encrypted bytea,
  health text NOT NULL DEFAULT 'unknown',
  quota_used integer NOT NULL DEFAULT 0,
  quota_limit integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_account_type_check CHECK (type IN ('gmail', 'line', 'portal', 'discord', 'webhook'))
);
-- One portal per installation.
CREATE UNIQUE INDEX channel_account_portal_key ON channel_account (type) WHERE type = 'portal';
INSERT INTO channel_account (type, name) VALUES ('portal', 'Client portal');

-- 6. Intents (PRD section 3.1). Rows are loaded from examples/intents by the seed code, never
--    hard-coded. autonomy_stage defaults to 2, draft-for-approval (N3).
CREATE TABLE intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  typical_evidence text NOT NULL DEFAULT '',
  default_priority text NOT NULL DEFAULT 'P3',
  sla_policy_id uuid REFERENCES sla_policy (id) ON DELETE SET NULL,
  runbook_article_id uuid,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  autonomy_stage smallint NOT NULL DEFAULT 2,
  procedure_version_id uuid,
  reply_templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intent_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT intent_priority_check CHECK (default_priority IN ('P1', 'P2', 'P3', 'P4')),
  CONSTRAINT intent_autonomy_check CHECK (autonomy_stage BETWEEN 0 AND 4),
  CONSTRAINT intent_templates_array CHECK (jsonb_typeof(reply_templates) = 'array')
);
CREATE UNIQUE INDEX intent_key_key ON intent (key);

-- 7. Status workflow (R-1.2). The allowed transitions are data so a head can change them.
CREATE TABLE ticket_status_transition (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status),
  CONSTRAINT transition_from_check CHECK (
    from_status IN ('new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev', 'resolved', 'closed')
  ),
  CONSTRAINT transition_to_check CHECK (
    to_status IN ('new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev', 'resolved', 'closed')
  ),
  CONSTRAINT transition_not_a_loop CHECK (from_status <> to_status)
);
-- packages/shared/src/ticketing.ts holds the same list; an integration test keeps them equal.
INSERT INTO ticket_status_transition (from_status, to_status) VALUES
  ('new', 'triage'), ('new', 'open'), ('new', 'waiting_on_customer'), ('new', 'resolved'), ('new', 'closed'),
  ('triage', 'open'), ('triage', 'waiting_on_customer'), ('triage', 'waiting_on_dev'),
  ('triage', 'resolved'), ('triage', 'closed'),
  ('open', 'triage'), ('open', 'waiting_on_customer'), ('open', 'waiting_on_dev'),
  ('open', 'resolved'), ('open', 'closed'),
  ('waiting_on_customer', 'open'), ('waiting_on_customer', 'waiting_on_dev'),
  ('waiting_on_customer', 'resolved'), ('waiting_on_customer', 'closed'),
  ('waiting_on_dev', 'open'), ('waiting_on_dev', 'waiting_on_customer'),
  ('waiting_on_dev', 'resolved'), ('waiting_on_dev', 'closed'),
  ('resolved', 'open'), ('resolved', 'closed');

-- 8. Tickets. `number` comes from a sequence, so two tickets created at the same instant never
--    share one (a rolled-back creation leaves a gap, which is fine). The app role needs USAGE on
--    the sequence because default privileges cover tables only.
CREATE SEQUENCE ticket_number_seq START WITH 1001;
GRANT USAGE ON SEQUENCE ticket_number_seq TO watchtower_app;

CREATE TABLE ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint NOT NULL DEFAULT nextval('ticket_number_seq'),
  subject text NOT NULL,
  org_id uuid NOT NULL REFERENCES organization (id) ON DELETE RESTRICT,
  requester_contact_id uuid REFERENCES contact (id) ON DELETE SET NULL,
  -- Channel of origin: the account it came through and its type, kept here to filter cheaply.
  channel_account_id uuid REFERENCES channel_account (id) ON DELETE RESTRICT,
  channel text NOT NULL DEFAULT 'portal',
  intent_id uuid REFERENCES intent (id) ON DELETE RESTRICT,
  priority text NOT NULL DEFAULT 'P3',
  status text NOT NULL DEFAULT 'new',
  assignee_id uuid REFERENCES users (id) ON DELETE SET NULL,
  queue_id uuid REFERENCES team_queue (id) ON DELETE SET NULL,
  sla_policy_id uuid REFERENCES sla_policy (id) ON DELETE RESTRICT,
  first_response_due_at timestamptz,
  resolution_due_at timestamptz,
  -- Set while the SLA clock is stopped (waiting_on_customer); null otherwise.
  sla_paused_at timestamptz,
  first_responded_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  incident_id uuid,
  -- The ticket this one was merged into.
  parent_ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  tags text[] NOT NULL DEFAULT '{}',
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  autonomy_stage_at_creation smallint,
  ai_handled boolean NOT NULL DEFAULT false,
  reopen_count integer NOT NULL DEFAULT 0,
  csat_score smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_status_check CHECK (
    status IN ('new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev', 'resolved', 'closed', 'merged')
  ),
  CONSTRAINT ticket_priority_check CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  CONSTRAINT ticket_channel_check CHECK (channel IN ('gmail', 'line', 'portal', 'discord', 'webhook')),
  CONSTRAINT ticket_not_own_parent CHECK (parent_ticket_id IS NULL OR parent_ticket_id <> id),
  CONSTRAINT ticket_merged_has_parent CHECK (status <> 'merged' OR parent_ticket_id IS NOT NULL),
  CONSTRAINT ticket_autonomy_check CHECK (
    autonomy_stage_at_creation IS NULL OR autonomy_stage_at_creation BETWEEN 0 AND 4
  ),
  CONSTRAINT ticket_csat_check CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5),
  CONSTRAINT ticket_custom_fields_object CHECK (jsonb_typeof(custom_fields) = 'object')
);
CREATE UNIQUE INDEX ticket_number_key ON ticket (number);
-- Queue views (docs/04-ARCHITECTURE.md section 7).
CREATE INDEX ticket_queue_idx ON ticket (status, queue_id, priority, first_response_due_at);
CREATE INDEX ticket_org_status_idx ON ticket (org_id, status);
CREATE INDEX ticket_assignee_status_idx ON ticket (assignee_id, status);
CREATE INDEX ticket_open_due_idx ON ticket (first_response_due_at, resolution_due_at)
  WHERE status IN ('new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev');
-- Keyset pagination of the lists.
CREATE INDEX ticket_created_idx ON ticket (created_at DESC, id DESC);
CREATE INDEX ticket_updated_idx ON ticket (updated_at DESC, id DESC);
CREATE INDEX ticket_org_created_idx ON ticket (org_id, created_at DESC, id DESC);
CREATE INDEX ticket_parent_idx ON ticket (parent_ticket_id) WHERE parent_ticket_id IS NOT NULL;
CREATE INDEX ticket_requester_idx ON ticket (requester_contact_id) WHERE requester_contact_id IS NOT NULL;
CREATE INDEX ticket_tags_idx ON ticket USING gin (tags);
-- Substring and fuzzy search over the subject; pg_trgm indexes Thai text too, which the built-in
-- text search parser cannot split into words (docs/04-ARCHITECTURE.md section 7).
CREATE INDEX ticket_subject_trgm_idx ON ticket USING gin (subject gin_trgm_ops);

-- A merge chain can never loop back on itself, whatever the application does.
CREATE FUNCTION ticket_reject_parent_cycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ancestor uuid := NEW.parent_ticket_id;
  depth integer := 0;
BEGIN
  WHILE ancestor IS NOT NULL LOOP
    IF ancestor = NEW.id THEN
      RAISE EXCEPTION 'ticket % would become its own ancestor', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    depth := depth + 1;
    IF depth > 50 THEN
      RAISE EXCEPTION 'ticket parent chain is too deep'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_ticket_id INTO ancestor FROM ticket WHERE id = ancestor;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER ticket_parent_cycle
  BEFORE INSERT OR UPDATE OF parent_ticket_id ON ticket
  FOR EACH ROW
  WHEN (NEW.parent_ticket_id IS NOT NULL)
  EXECUTE FUNCTION ticket_reject_parent_cycle();

-- 9. Messages. NOT partitioned: a unique index on a partitioned table must include the partition
--    key, so (channel_account_id, external_id) could not be unique across months, and that
--    uniqueness is the idempotency of ingestion (PRD section 8.3).
CREATE TABLE message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  channel_account_id uuid REFERENCES channel_account (id) ON DELETE RESTRICT,
  -- inbound: from the customer. outbound: a public reply to the customer. internal: a staff note.
  direction text NOT NULL,
  -- The provider's id for this message (a Gmail message id, a LINE message id, a portal submission id).
  external_id text,
  thread_key text,
  sender_contact_id uuid REFERENCES contact (id) ON DELETE SET NULL,
  sender_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  body_text text NOT NULL,
  body_html text,
  -- PII-redacted copy for LLM prompts (N4); filled when the AI layer arrives.
  body_redacted text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility text NOT NULL,
  delivery_status text NOT NULL DEFAULT 'not_applicable',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_direction_check CHECK (direction IN ('inbound', 'outbound', 'internal')),
  CONSTRAINT message_visibility_check CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT message_internal_pair CHECK ((visibility = 'internal') = (direction = 'internal')),
  CONSTRAINT message_delivery_check CHECK (delivery_status IN ('not_applicable', 'pending', 'delivered', 'failed')),
  CONSTRAINT message_attachments_array CHECK (jsonb_typeof(attachments) = 'array')
);
CREATE INDEX message_ticket_idx ON message (ticket_id, created_at);
-- NULL external ids are distinct, so messages without a provider id (staff replies) are unaffected.
CREATE UNIQUE INDEX message_external_key ON message (channel_account_id, external_id);
CREATE INDEX message_thread_idx ON message (thread_key) WHERE thread_key IS NOT NULL;
CREATE INDEX message_body_trgm_idx ON message USING gin (body_text gin_trgm_ops);

-- 10. Ticket events: assignment history, status changes, merges, SLA changes. Append-only and
--     partitioned by month like audit_log (section 12 of 0001 explains the privileges and triggers).
--     visibility says whether a client may see the entry; payloads never carry message text.
CREATE TABLE ticket_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  visibility text NOT NULL DEFAULT 'internal',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, created_at),
  CONSTRAINT ticket_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'ai', 'anonymous')),
  CONSTRAINT ticket_event_visibility_check CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT ticket_event_payload_object CHECK (jsonb_typeof(payload) = 'object')
) PARTITION BY RANGE (created_at);

CREATE INDEX ticket_event_ticket_idx ON ticket_event (ticket_id, created_at);
CREATE INDEX ticket_event_type_idx ON ticket_event (type, created_at DESC);

CREATE TRIGGER ticket_event_reject_update_delete
  BEFORE UPDATE OR DELETE ON ticket_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ticket_event_reject_truncate
  BEFORE TRUNCATE ON ticket_event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE ticket_event_default PARTITION OF ticket_event DEFAULT;
CREATE TRIGGER ticket_event_default_reject_truncate
  BEFORE TRUNCATE ON ticket_event_default
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON ticket_event, ticket_event_default FROM watchtower_app, PUBLIC;

SELECT ensure_monthly_partitions('ticket_event', 12, true);

-- 11. New permission strings (PRD section 2.2 is silent on queues, intents and the workflow;
--     [ASSUMED] lead manages queues and intents, head manages the workflow).
--     packages/shared/src/rbac.ts holds the same data; an integration test keeps them equal.
INSERT INTO permissions (key, description) VALUES
  ('queue.manage', 'Manage team queues and their members'),
  ('intent.manage', 'Create and edit intents (not their autonomy stage)'),
  ('workflow.manage', 'Change which ticket status transitions are allowed');

INSERT INTO role_permissions (role, permission) VALUES
  ('lead', 'queue.manage'),
  ('lead', 'intent.manage'),
  ('head', 'queue.manage'),
  ('head', 'intent.manage'),
  ('head', 'workflow.manage');
