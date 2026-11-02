-- T-203d: saved investigation templates and the evidence cards a run leaves on a ticket or an incident
-- (PRD R-5.1, R-5.2, R-5.6, AC-5).
--   tool_template   a Cloud Logging filter or a SQL statement with {{name}} placeholders, per intent. A
--                   person presses a button and the template runs with the ticket's organization; the
--                   AI runs the templates of the ticket's intent that are marked `run_by_ai`. Editing
--                   one is a head's act and is audited: it is a query against customer data.
--   evidence_card   what a run found, pinned to a ticket or an incident: the query's name, when, a
--                   summary and a redacted excerpt (N4) with a keyed hash of the full result and of the
--                   parameters. The full result is not kept (phase-2 breakdown, scope cut).
-- Reversible: see 0065_tool_template_evidence.down.sql.

CREATE TABLE tool_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  name text NOT NULL,
  -- The words on the button.
  title text NOT NULL,
  -- Null: offered on every ticket (never run by the AI: its scope comes from an intent).
  intent_id uuid REFERENCES intent (id) ON DELETE RESTRICT,
  -- logs: a filter in the subset the connectors read; data: one SELECT. Placeholders are {{name}}.
  body text NOT NULL,
  -- Result columns this template may show besides the global allow-list (data only).
  allowed_columns text[] NOT NULL DEFAULT '{}',
  run_by_ai boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tool_template_kind_check CHECK (kind IN ('logs', 'data')),
  CONSTRAINT tool_template_name_check CHECK (name ~ '^[a-z][a-z0-9_-]{1,60}$'),
  CONSTRAINT tool_template_title_check CHECK (length(title) BETWEEN 1 AND 120),
  CONSTRAINT tool_template_body_check CHECK (length(body) BETWEEN 1 AND 4000),
  CONSTRAINT tool_template_name_key UNIQUE (kind, name),
  -- The AI runs a template on its own, so the template must be about the ticket's organization: without
  -- {{org_id}} it would read every customer's rows or lines (P3 of the T-203 security review).
  CONSTRAINT tool_template_ai_org_check CHECK (NOT run_by_ai OR position('{{org_id}}' in body) > 0)
);
CREATE INDEX tool_template_intent_idx ON tool_template (intent_id) WHERE active;

CREATE TABLE evidence_card (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of the two.
  ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  incident_id uuid REFERENCES incident (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  template_id uuid REFERENCES tool_template (id) ON DELETE SET NULL,
  -- The template's name when it ran, or `adhoc`: the card still reads after the template is gone.
  template_name text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  -- Redacted before it was stored (N4); at most a few lines.
  excerpt text NOT NULL,
  result_count integer NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  -- Result columns that were hidden because they are not on the allow-list.
  masked_columns text[] NOT NULL DEFAULT '{}',
  window_from timestamptz,
  window_to timestamptz,
  -- Keyed hashes (HMAC-SHA-256) of the parameters and of the full result: they prove, they do not reveal.
  params_hash text NOT NULL,
  result_hash text NOT NULL,
  -- The answer came from a fake or a sandbox, not the real system.
  mock boolean NOT NULL DEFAULT false,
  -- Joins the tool_execution rows of the run (no foreign key: that table is partitioned).
  run_key text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT evidence_card_subject_check CHECK ((ticket_id IS NULL) <> (incident_id IS NULL)),
  CONSTRAINT evidence_card_kind_check CHECK (kind IN ('logs', 'data', 'repo', 'metrics')),
  CONSTRAINT evidence_card_counts_check CHECK (result_count >= 0),
  CONSTRAINT evidence_card_hash_check CHECK (params_hash ~ '^[0-9a-f]{64}$' AND result_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_card_excerpt_check CHECK (length(excerpt) <= 6000)
);
CREATE INDEX evidence_card_ticket_idx ON evidence_card (ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;
CREATE INDEX evidence_card_incident_idx ON evidence_card (incident_id, created_at DESC) WHERE incident_id IS NOT NULL;
