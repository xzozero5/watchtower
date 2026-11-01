-- T-202a: incidents, their timeline, and the deploy feed (PRD R-3.12, R-5.4, ADR-015). Reversible:
-- 0044_incident.down.sql.
--
--   incident             SEV1-SEV4, status investigating -> identified -> monitoring -> resolved, a commander,
--                        a root cause, the Discord thread (state says whether it is real: `mock` is a fake).
--                        `number` is the human number (INC-12); it never repeats.
--   incident_service     the affected services.
--   incident_org         the affected organizations: added by hand (`manual`) or inferred when a ticket of the
--                        organization is linked (`ticket`).
--   incident_timeline    what happened, in order. Append-only and partitioned by month like ticket_event
--                        (migration 0002): a correction is a new entry, never an edit. Payloads hold ids,
--                        enumerations and counts; a note's text is the one free-text type and is internal.
--   deploy               what was deployed, posted by CI (a signed webhook) or taken from the repo host.
--                        UNIQUE (source, external_id) makes a retried delivery one row. `occurred_at` is the
--                        provider's time (finished, else started, else when we heard) and is used to show what
--                        changed before an incident, never to decide anything.
--   ticket.incident_id and alert.incident_id become real foreign keys (the columns exist since 0002 / 0041).
--
-- Clock: started_at, resolved_at, created_at and the timeline are written with the database clock.

CREATE TABLE incident (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY,
  title text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'investigating',
  commander_id uuid REFERENCES users (id) ON DELETE SET NULL,
  root_cause text,
  postmortem_article_id uuid REFERENCES kb_article (id) ON DELETE SET NULL,
  -- The Discord thread (R-3.13). `pending`: to be created. `created`: a real thread, with its ids.
  -- `mock`: a fake transport recorded it and nothing exists; it never carries an id.
  discord_thread_state text NOT NULL DEFAULT 'pending',
  discord_channel_id text,
  discord_thread_id text,
  status_page_visible boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT incident_number_key UNIQUE (number),
  CONSTRAINT incident_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT incident_severity_check CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4')),
  CONSTRAINT incident_status_check CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  CONSTRAINT incident_resolved_consistent CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT incident_root_cause_check CHECK (root_cause IS NULL OR length(root_cause) <= 4000),
  CONSTRAINT incident_thread_state_check
    CHECK (discord_thread_state IN ('pending', 'created', 'mock', 'skipped', 'failed')),
  CONSTRAINT incident_thread_ids_check CHECK (
    (discord_thread_id IS NULL AND discord_channel_id IS NULL) OR discord_thread_state = 'created'
  )
);
CREATE INDEX incident_open_idx ON incident (started_at DESC) WHERE status <> 'resolved';
CREATE INDEX incident_list_idx ON incident (created_at DESC, id DESC);

CREATE TABLE incident_service (
  incident_id uuid NOT NULL REFERENCES incident (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service (id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, service_id)
);
CREATE INDEX incident_service_service_idx ON incident_service (service_id);

CREATE TABLE incident_org (
  incident_id uuid NOT NULL REFERENCES incident (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (incident_id, org_id),
  CONSTRAINT incident_org_source_check CHECK (source IN ('manual', 'ticket'))
);

CREATE TABLE incident_timeline (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  incident_id uuid NOT NULL REFERENCES incident (id) ON DELETE RESTRICT,
  type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, created_at),
  CONSTRAINT incident_timeline_type_check CHECK (type IN (
    'created', 'status_changed', 'severity_changed', 'commander_changed', 'alert_linked',
    'ticket_linked', 'ticket_unlinked', 'service_added', 'note', 'comms_drafted', 'comms_sent',
    'thread_created', 'deploy_noted'
  )),
  CONSTRAINT incident_timeline_actor_type_check CHECK (actor_type IN ('user', 'system', 'ai', 'anonymous')),
  CONSTRAINT incident_timeline_payload_object CHECK (jsonb_typeof(payload) = 'object')
) PARTITION BY RANGE (created_at);

CREATE INDEX incident_timeline_incident_idx ON incident_timeline (incident_id, created_at);

CREATE TRIGGER incident_timeline_reject_update_delete
  BEFORE UPDATE OR DELETE ON incident_timeline
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER incident_timeline_reject_truncate
  BEFORE TRUNCATE ON incident_timeline
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE incident_timeline_default PARTITION OF incident_timeline DEFAULT;
CREATE TRIGGER incident_timeline_default_reject_truncate
  BEFORE TRUNCATE ON incident_timeline_default
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON incident_timeline, incident_timeline_default FROM watchtower_app, PUBLIC;

SELECT ensure_monthly_partitions('incident_timeline', 12, true);

CREATE TABLE deploy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid REFERENCES service (id) ON DELETE SET NULL,
  -- Kept after the service is removed from the catalog, so the history still reads.
  service_slug text NOT NULL,
  version text NOT NULL,
  env text NOT NULL,
  actor text,
  source text NOT NULL,
  external_id text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  url text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  occurred_at timestamptz GENERATED ALWAYS AS (COALESCE(finished_at, started_at, received_at)) STORED,
  CONSTRAINT deploy_source_external_key UNIQUE (source, external_id),
  CONSTRAINT deploy_version_check CHECK (length(btrim(version)) BETWEEN 1 AND 200),
  CONSTRAINT deploy_env_check CHECK (length(btrim(env)) BETWEEN 1 AND 50),
  CONSTRAINT deploy_actor_check CHECK (actor IS NULL OR length(actor) <= 100),
  CONSTRAINT deploy_source_check CHECK (source IN ('ci', 'github')),
  CONSTRAINT deploy_external_id_check CHECK (length(external_id) BETWEEN 1 AND 200),
  CONSTRAINT deploy_url_check CHECK (url IS NULL OR url ~ '^https?://'),
  CONSTRAINT deploy_times_check CHECK (started_at IS NULL OR finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX deploy_service_time_idx ON deploy (service_id, occurred_at DESC) WHERE service_id IS NOT NULL;
CREATE INDEX deploy_time_idx ON deploy (occurred_at DESC);

ALTER TABLE ticket ADD CONSTRAINT ticket_incident_fk
  FOREIGN KEY (incident_id) REFERENCES incident (id) ON DELETE SET NULL;
CREATE INDEX ticket_incident_idx ON ticket (incident_id) WHERE incident_id IS NOT NULL;
ALTER TABLE alert ADD CONSTRAINT alert_incident_fk
  FOREIGN KEY (incident_id) REFERENCES incident (id) ON DELETE SET NULL;
CREATE INDEX alert_incident_idx ON alert (incident_id) WHERE incident_id IS NOT NULL;
