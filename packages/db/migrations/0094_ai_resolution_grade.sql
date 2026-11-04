-- T-301 (PRD 6.2, 6.4): the grader's verdict on a resolved ticket.
--   ai_resolution_grade  one row per resolution of a ticket (a reopen and a new resolve is a new `cycle`).
--                        resolution_class  verified | contained | assumed (the code caps the model's word).
--                        draft_verdict / draft_quality  how the AI draft compares with the reply that was
--                                          sent (null when there was no draft to compare).
--                        policy_violations [{ code, text, evidence }]; reasoning is claim-shaped
--                                          ({ text, evidence, uncited }) so the web has one way to show it.
--                        The text is stored as the staff would read it (placeholders restored for the
--                        ticket's own people); the ai_run row has the redacted input hash and answer.
-- No stage change and no customer message comes from this table: it is a measurement (N3).
-- Reversible: see 0094_ai_resolution_grade.down.sql.

CREATE TABLE ai_resolution_grade (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  -- ticket.reopen_count at the time of the resolve this row is about.
  cycle integer NOT NULL DEFAULT 0,
  intent_key text,
  resolution_class text NOT NULL,
  -- What the model said before the code capped it (kept so a disagreement can be measured).
  model_class text,
  draft_id uuid,
  draft_verdict text NOT NULL DEFAULT 'no_draft',
  draft_quality real,
  policy_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  violation_count integer NOT NULL DEFAULT 0,
  kb_gap boolean NOT NULL DEFAULT false,
  reasoning jsonb NOT NULL DEFAULT '[]'::jsonb,
  csat_score smallint,
  csat_resolved boolean,
  ai_run_id uuid,
  prompt_version integer NOT NULL,
  mock boolean NOT NULL DEFAULT false,
  graded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_resolution_grade_ticket_cycle_key UNIQUE (ticket_id, cycle),
  CONSTRAINT ai_resolution_grade_class_check CHECK (resolution_class IN ('verified', 'contained', 'assumed')),
  CONSTRAINT ai_resolution_grade_model_class_check CHECK (
    model_class IS NULL OR model_class IN ('verified', 'contained', 'assumed')
  ),
  CONSTRAINT ai_resolution_grade_verdict_check CHECK (draft_verdict IN ('matches', 'partial', 'differs', 'no_draft')),
  CONSTRAINT ai_resolution_grade_quality_check CHECK (
    draft_quality IS NULL OR (draft_quality >= 0 AND draft_quality <= 1)
  ),
  CONSTRAINT ai_resolution_grade_quality_verdict_check CHECK ((draft_verdict = 'no_draft') = (draft_quality IS NULL)),
  CONSTRAINT ai_resolution_grade_violations_check CHECK (
    jsonb_typeof(policy_violations) = 'array' AND violation_count >= 0
  ),
  CONSTRAINT ai_resolution_grade_reasoning_check CHECK (jsonb_typeof(reasoning) = 'array'),
  CONSTRAINT ai_resolution_grade_csat_check CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5),
  CONSTRAINT ai_resolution_grade_cycle_check CHECK (cycle >= 0)
);
CREATE INDEX ai_resolution_grade_intent_idx ON ai_resolution_grade (intent_key, graded_at DESC);
CREATE INDEX ai_resolution_grade_graded_idx ON ai_resolution_grade (graded_at DESC);
