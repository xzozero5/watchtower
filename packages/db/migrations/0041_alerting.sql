-- T-201b: alerts, the service catalog and escalation policies (PRD section 4.3, section 7, ADR-015).
--
--   escalation_policy  who is told and after how long; `steps` is an array of
--                      {target: on_shift|lead|head, afterSeconds}. One row is the default (seeded):
--                      a service without a policy of its own uses it. [ASSUMED] T1 = 300 s, T2 = 900 s.
--   service            the catalog (R-3.7). `match_rules` maps an alert to it (see
--                      packages/shared/src/features/alerts.ts); an alert no service claims is "unmapped".
--   alert              one row per OPEN fingerprint (partial unique index), counting how often it
--                      fired. `closed` from the provider resolves it; the row stays as history, and the
--                      next fire of the same fingerprint opens a new row.
--   alert_event        one row per delivery that changed the alert. UNIQUE (source, provider_event_id)
--                      is the idempotency key: a redelivery carries the same id (ignored), two real fires
--                      carry two.
--
-- Clock: every timestamp the system decides with (first_seen_at, last_seen_at, resolved_at, and the
-- escalation clock of T-201d) is written with the database clock (now()), never a process clock.
-- `alert_event.occurred_at` is the provider's own time, for display only.
-- alert.incident_id has no foreign key yet: the incident table arrives with T-202a, which adds it.
-- alert.payload keeps allow-listed keys only (N4): enforced in the application and bounded here.
-- Reversible: see 0041_alerting.down.sql.

CREATE TABLE escalation_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  steps jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escalation_policy_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT escalation_policy_steps_check CHECK (
    jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 5
  )
);
CREATE UNIQUE INDEX escalation_policy_name_key ON escalation_policy (lower(name));
CREATE UNIQUE INDEX escalation_policy_default_key ON escalation_policy (is_default) WHERE is_default;

INSERT INTO escalation_policy (name, steps, is_default) VALUES (
  'Default',
  '[{"target":"on_shift","afterSeconds":0},{"target":"lead","afterSeconds":300},{"target":"head","afterSeconds":900}]'::jsonb,
  true
);

CREATE TABLE service (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  owner_queue_id uuid REFERENCES team_queue (id) ON DELETE SET NULL,
  runbook_url text,
  runbook_article_id uuid REFERENCES kb_article (id) ON DELETE SET NULL,
  dashboard_url text,
  match_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  repos text[] NOT NULL DEFAULT '{}',
  escalation_policy_id uuid REFERENCES escalation_policy (id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 64),
  CONSTRAINT service_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT service_match_rules_check CHECK (
    jsonb_typeof(match_rules) = 'array' AND jsonb_array_length(match_rules) <= 20
  ),
  CONSTRAINT service_urls_check CHECK (
    (runbook_url IS NULL OR runbook_url ~ '^https?://')
    AND (dashboard_url IS NULL OR dashboard_url ~ '^https?://')
  )
);
CREATE UNIQUE INDEX service_slug_key ON service (slug);
CREATE INDEX service_owner_queue_idx ON service (owner_queue_id) WHERE owner_queue_id IS NOT NULL;
CREATE INDEX service_escalation_policy_idx ON service (escalation_policy_id)
  WHERE escalation_policy_id IS NOT NULL;

CREATE TABLE alert (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL,
  source text NOT NULL,
  service_id uuid REFERENCES service (id) ON DELETE SET NULL,
  severity text NOT NULL DEFAULT 'unknown',
  state text NOT NULL DEFAULT 'open',
  title text NOT NULL,
  summary text,
  count integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  acked_at timestamptz,
  acked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Escalation (T-201d): how far it has gone and when the next step is due (database clock).
  escalation_level smallint NOT NULL DEFAULT 0,
  next_escalation_at timestamptz,
  -- Snooze (T-201e): mandatory expiry and reason.
  snoozed_until timestamptz,
  snooze_reason text,
  incident_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT alert_source_check CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager')),
  CONSTRAINT alert_severity_check CHECK (severity IN ('critical', 'error', 'warning', 'info', 'unknown')),
  CONSTRAINT alert_state_check CHECK (state IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT alert_count_check CHECK (count >= 1),
  CONSTRAINT alert_title_check CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT alert_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT alert_payload_size CHECK (octet_length(payload::text) <= 16384),
  CONSTRAINT alert_resolved_consistent CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT alert_acked_consistent CHECK (state <> 'acknowledged' OR acked_at IS NOT NULL),
  CONSTRAINT alert_escalation_level_check CHECK (escalation_level BETWEEN 0 AND 10),
  CONSTRAINT alert_snooze_has_reason CHECK (snoozed_until IS NULL OR snooze_reason IS NOT NULL)
);
-- At most one open alert per fingerprint: the dedup of R-3.5 is this index plus an upsert.
CREATE UNIQUE INDEX alert_open_fingerprint_key ON alert (fingerprint) WHERE state <> 'resolved';
CREATE INDEX alert_list_idx ON alert (last_seen_at DESC, id DESC);
CREATE INDEX alert_state_list_idx ON alert (state, last_seen_at DESC, id DESC);
CREATE INDEX alert_service_idx ON alert (service_id, last_seen_at DESC) WHERE service_id IS NOT NULL;
CREATE INDEX alert_unmapped_idx ON alert (last_seen_at DESC) WHERE service_id IS NULL;
CREATE INDEX alert_escalation_due_idx ON alert (next_escalation_at)
  WHERE state = 'open' AND next_escalation_at IS NOT NULL;

CREATE TABLE alert_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES alert (id) ON DELETE CASCADE,
  source text NOT NULL,
  provider_event_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_event_source_check CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager')),
  CONSTRAINT alert_event_type_check CHECK (type IN ('fired', 'renotified', 'resolved')),
  CONSTRAINT alert_event_provider_id_check CHECK (length(provider_event_id) BETWEEN 1 AND 300)
);
-- The idempotency key of an alert delivery (ADR-015 section 2).
CREATE UNIQUE INDEX alert_event_provider_key ON alert_event (source, provider_event_id);
CREATE INDEX alert_event_alert_idx ON alert_event (alert_id, created_at);
