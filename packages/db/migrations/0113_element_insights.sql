-- T-414 (ADR-029 section 9): embedded insights.
--   ai_element_insight   the narration of one screen element for one audience (element, scope, period, language),
--                        written ahead of time by the worker; the api only reads it. Facts are computed on read.
--   ai_summary.kind      gains 'my_work' (section 9.9): the narration of Home "my work" is per person, so it uses the
--                        per-person cache that already exists.
-- Written only by the worker. That is a convention enforced by the boundary lint (apps/api must not import the
-- insight writer, C-15), not by a grant: api and worker share the watchtower_app role (default privileges of 0001).
-- ai_run_id has no foreign key: ai_run is partitioned (same reason as assistant_message in 0090).
-- Reversible: 0113_element_insights.down.sql.

CREATE TABLE ai_element_insight (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A key of INSIGHT_ELEMENTS (packages/shared). Not a CHECK list: the registry grows without a migration.
  element text NOT NULL,
  -- 'instance' | 'org:<uuid>' | 'intent:<uuid>' | 'incident:<uuid>' | 'service:<uuid>'
  scope_key text NOT NULL,
  -- 'd7' | 'now' | 'shift:<id>' | 'w2026-45' | '-'
  period text NOT NULL,
  locale text NOT NULL,
  org_id uuid REFERENCES organization (id) ON DELETE CASCADE,
  -- Snapshot the narration was made from (allow-list facts, view 'full'). No free text.
  facts jsonb NOT NULL,
  -- Hash of the facts after bucketing; equal = no new model call.
  facts_fingerprint text NOT NULL,
  -- Stored claims: redacted text with placeholders, evidence = [{kind, id, factId}].
  claims jsonb NOT NULL,
  prompt_id text NOT NULL,
  prompt_version text NOT NULL,
  model text NOT NULL,
  ai_run_id uuid,
  mock boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ai_element_insight_locale_check CHECK (locale IN ('th', 'en')),
  CONSTRAINT ai_element_insight_json_check CHECK (jsonb_typeof(claims) = 'array' AND jsonb_typeof(facts) = 'array'),
  CONSTRAINT ai_element_insight_expiry_check CHECK (expires_at > generated_at),
  CONSTRAINT ai_element_insight_key UNIQUE (element, scope_key, period, locale)
);
CREATE INDEX ai_element_insight_expires_idx ON ai_element_insight (expires_at);
CREATE INDEX ai_element_insight_org_idx ON ai_element_insight (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX ai_element_insight_run_idx ON ai_element_insight (ai_run_id) WHERE ai_run_id IS NOT NULL;

ALTER TABLE ai_summary DROP CONSTRAINT ai_summary_kind_check;
ALTER TABLE ai_summary ADD CONSTRAINT ai_summary_kind_check CHECK (kind IN ('brief', 'handoff', 'my_work'));
