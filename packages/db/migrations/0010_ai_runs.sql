-- T-106d: the AI audit trail and the latest AI result per ticket (ADR-008, PRD sections 6.1, 8.2).
--   ai_run:            one row per model call, including failed ones. Partitioned by month and
--                      append-only exactly like audit_log (0001): the application role has no
--                      UPDATE, DELETE or TRUNCATE and a trigger rejects them for everyone. It holds
--                      the redacted form of the answer only (N4), a keyed hash of the redacted
--                      input (never the input), and the redaction counts of the session itself
--                      (SR106-R9), so a caller cannot report a smaller number than what was replaced.
--   ai_ticket_insight: the latest AI result per ticket, for fast reads (the AI brief and the queue
--                      row). One row per ticket, replaced by an upsert; the history is ai_run.
--   ai_budget_event:   the first time per UTC day a daily cap reached its alert level or its limit,
--                      so the alert fires once a day and the stop is on record.
-- Reversible: see 0010_ai_runs.down.sql.

CREATE TABLE ai_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL,
  agent text NOT NULL,
  -- Absent when the call happened before the ticket existed (the ingest classifier).
  ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  intent text,
  provider text NOT NULL,
  -- The model id from settings; `mock-*` for the offline mock provider.
  model text NOT NULL,
  tier text NOT NULL,
  prompt_id text NOT NULL,
  prompt_version integer NOT NULL,
  prompt_hash text NOT NULL,
  tools text[] NOT NULL DEFAULT '{}',
  -- HMAC-SHA-256 (hex) of the redacted input under the server-side key. Not the input.
  input_hmac text NOT NULL,
  -- The model's answer in redacted (placeholder) form. Null when the call failed.
  output text,
  confidence real,
  -- {"total": n, "byKind": {"EMAIL": n, ...}}: counts only, no original values.
  redaction jsonb NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  -- Null: the model has no price in settings (cost unknown, which is not zero).
  cost_usd numeric(14, 8),
  latency_ms integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  -- The error class only (for example ProviderError), never a message or a payload.
  error_code text,
  -- A partitioned table's primary key must contain the partition key.
  PRIMARY KEY (id, created_at),
  CONSTRAINT ai_run_status_check CHECK (status IN ('ok', 'error')),
  CONSTRAINT ai_run_provider_check CHECK (provider IN ('mock', 'anthropic', 'vertex')),
  CONSTRAINT ai_run_tier_check CHECK (tier IN ('deep', 'standard', 'light')),
  CONSTRAINT ai_run_agent_check CHECK (agent ~ '^[a-z][a-z_]*$'),
  CONSTRAINT ai_run_hmac_check CHECK (input_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_run_prompt_hash_check CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_run_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT ai_run_counts_check CHECK (input_tokens >= 0 AND output_tokens >= 0 AND latency_ms >= 0),
  CONSTRAINT ai_run_redaction_check CHECK (jsonb_typeof(redaction) = 'object')
) PARTITION BY RANGE (created_at);

CREATE INDEX ai_run_created_idx ON ai_run (created_at DESC, id DESC);
CREATE INDEX ai_run_ticket_idx ON ai_run (ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;
CREATE INDEX ai_run_agent_idx ON ai_run (agent, created_at DESC);

-- Row triggers on the parent are cloned to every partition, including ones created later.
CREATE TRIGGER ai_run_reject_update_delete
  BEFORE UPDATE OR DELETE ON ai_run
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
-- Statement triggers are not cloned: each partition gets its own (see ensure_monthly_partitions).
CREATE TRIGGER ai_run_reject_truncate
  BEFORE TRUNCATE ON ai_run
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE ai_run_default PARTITION OF ai_run DEFAULT;
CREATE TRIGGER ai_run_default_reject_truncate
  BEFORE TRUNCATE ON ai_run_default
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON ai_run, ai_run_default FROM watchtower_app, PUBLIC;

SELECT ensure_monthly_partitions('ai_run', 12, true);

CREATE TABLE ai_ticket_insight (
  ticket_id uuid PRIMARY KEY REFERENCES ticket (id) ON DELETE RESTRICT,
  -- none | classified | investigating | draft_ready | needs_human | failed (shared AI_STATES).
  state text NOT NULL,
  -- Why a ticket is `needs_human` or `failed`: a stable code such as `kill_switch_on`,
  -- `budget_stop`, `name_match_limit`, `model_output_invalid`. Never prose from a model.
  reason_code text,
  summary text,
  intent_key text,
  intent_confidence real,
  intent_reason text,
  next_step_kind text,
  next_step_label text,
  -- [{id, kind, title, snippet, confidence, href?}]; filled by the investigator (T-108).
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The draft the drafter wrote (T-108). No foreign key: the draft table does not exist yet.
  draft_id uuid,
  -- The autonomy stage of the ticket's intent when this was written (N3: 0 to 2 in Phase 1).
  stage smallint NOT NULL DEFAULT 0,
  -- The ai_run rows this insight came from (no foreign key: ai_run is partitioned).
  classifier_run_id uuid,
  summarizer_run_id uuid,
  generated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_ticket_insight_state_check CHECK (
    state IN ('none', 'classified', 'investigating', 'draft_ready', 'needs_human', 'failed')
  ),
  CONSTRAINT ai_ticket_insight_next_step_check CHECK (
    next_step_kind IS NULL OR next_step_kind IN
      ('approve_draft', 'reply', 'escalate_dev', 'wait_customer', 'resolve', 'other')
  ),
  CONSTRAINT ai_ticket_insight_confidence_check CHECK (
    intent_confidence IS NULL OR (intent_confidence >= 0 AND intent_confidence <= 1)
  ),
  CONSTRAINT ai_ticket_insight_stage_check CHECK (stage BETWEEN 0 AND 4),
  CONSTRAINT ai_ticket_insight_evidence_check CHECK (jsonb_typeof(evidence) = 'array')
);
CREATE INDEX ai_ticket_insight_state_idx ON ai_ticket_insight (state, updated_at DESC);

CREATE TABLE ai_budget_event (
  day date NOT NULL,
  -- `alert` at the alert percentage of a cap, `stop` at the cap itself.
  level text NOT NULL,
  dimension text NOT NULL,
  spent numeric NOT NULL,
  cap numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, level, dimension),
  CONSTRAINT ai_budget_event_level_check CHECK (level IN ('alert', 'stop')),
  CONSTRAINT ai_budget_event_dimension_check CHECK (dimension IN ('cost', 'tokens'))
);
CREATE TRIGGER ai_budget_event_reject_update_delete
  BEFORE UPDATE OR DELETE ON ai_budget_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON ai_budget_event FROM watchtower_app, PUBLIC;
