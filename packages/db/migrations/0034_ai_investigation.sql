-- T-108: investigator, drafter and KB author (PRD sections 6.2, 6.5, R-5.1 to R-5.3, AC-4).
--   1. tool_execution:        one row per tool call of an AI run. It is the budget ledger (calls per run,
--                             per ticket and per tool in a window are counted from it, outside the
--                             handle of any one run) and the audit of what a tool was asked (a keyed
--                             hash of the input, never the input or the result). N2.
--   2. watchtower_ai_ro:      a role that can SELECT from a short list of views and from nothing else, so
--                             "the tools only read" is enforced by the database and not only by the code.
--   3. ai_draft:              what the drafter writes (language, citations, disclosure, uncited claims)
--                             and what a person did with it (approved, edited, rejected) for the learning
--                             loop (PRD section 6.5): edit distance and one of nine reason codes.
--   4. ai_ticket_insight:     the investigation report, the progress of the job and who asked for it.
--   5. kb_article_version:    `requested_by`, the person who triggered an AI-written version, who may not
--                             approve it (po decision 27, ISO 27001 A.5.3).
-- Reversible: see 0034_ai_investigation.down.sql.

-- 1. Tool executions.
CREATE TABLE tool_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  -- One id per investigation or draft run. A run calls several tools, and it is not an ai_run (that is
  -- one row per model call, written after the call).
  run_key text NOT NULL,
  agent text NOT NULL,
  tool text NOT NULL,
  -- The intent the tool scope was built from: past the confidence threshold or confirmed by a person (SR106-R8).
  intent text,
  stage smallint,
  -- HMAC-SHA-256 of the canonical input (keyed, like ai_run.input_hmac).
  input_hash text NOT NULL,
  -- running: counted against the budget, not finished. ok / error: finished. denied: the budget or the
  -- allow-list said no; it is kept as evidence and is not counted.
  status text NOT NULL,
  error_code text,
  latency_ms integer,
  -- How many rows, hits or entries came back. Never the content.
  result_count integer,
  -- The tool answered from a fixture, not from the real system.
  mock boolean NOT NULL DEFAULT false,
  CONSTRAINT tool_execution_status_check CHECK (status IN ('running', 'ok', 'error', 'denied')),
  CONSTRAINT tool_execution_name_check CHECK (tool ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT tool_execution_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tool_execution_finished_check CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX tool_execution_ticket_idx ON tool_execution (ticket_id, created_at DESC);
CREATE INDEX tool_execution_tool_idx ON tool_execution (tool, created_at DESC);
CREATE INDEX tool_execution_run_idx ON tool_execution (run_key);
-- The application writes a row, then closes it. It cannot rewrite who, what or when, and cannot delete.
REVOKE UPDATE, DELETE, TRUNCATE ON tool_execution FROM watchtower_app, PUBLIC;
GRANT UPDATE (status, error_code, finished_at, latency_ms, result_count) ON tool_execution TO watchtower_app;

-- 2. The read-only role and the views it may read. A view runs with its owner's rights, so the role
-- needs no right on the tables behind it. Columns are listed one by one: a column added to a table
-- later is not visible to the AI until somebody adds it here on purpose.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'watchtower_ai_ro') THEN
    CREATE ROLE watchtower_ai_ro NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO watchtower_ai_ro;

-- Tickets: no requester, no assignee, no custom fields, no free-form notes.
CREATE VIEW ai_v_ticket AS
SELECT t.id, t.number, t.subject, t.org_id, t.channel, t.priority, t.status,
       i.key AS intent_key, t.created_at, t.resolved_at
FROM ticket t
LEFT JOIN intent i ON i.id = t.intent_id;

-- Messages the customer could see (public), cut to the start of the text.
CREATE VIEW ai_v_ticket_message AS
SELECT m.id, m.ticket_id, m.direction, left(m.body_text, 1500) AS body_text, m.created_at
FROM message m
WHERE m.visibility = 'public';

-- Organizations: name, tier and status. No domains, no notes, no contact list.
CREATE VIEW ai_v_org AS
SELECT o.id, o.name, o.tier, o.status, o.created_at
FROM organization o;

REVOKE ALL ON ai_v_ticket, ai_v_ticket_message, ai_v_org FROM PUBLIC;
-- The default privileges of 0001 would let the application role write through a simple view; it only reads.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ai_v_ticket, ai_v_ticket_message, ai_v_org FROM watchtower_app;
GRANT SELECT ON ai_v_ticket, ai_v_ticket_message, ai_v_org TO watchtower_ai_ro;

-- 3. AI drafts.
ALTER TABLE ai_draft DROP CONSTRAINT ai_draft_status_check;
-- superseded: a newer draft replaced this one before a person acted on it.
ALTER TABLE ai_draft ADD CONSTRAINT ai_draft_status_check
  CHECK (status IN ('draft', 'approved', 'sent', 'rejected', 'superseded'));
ALTER TABLE ai_draft
  -- Language of the body ('th' or 'en'), and the language of the customer it was written for.
  ADD COLUMN language text,
  ADD COLUMN customer_language text,
  -- [{evidenceId, sentence}]: which evidence card supports which sentence.
  ADD COLUMN citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN uncited_claims integer NOT NULL DEFAULT 0,
  ADD COLUMN prompt_id text,
  ADD COLUMN prompt_version integer,
  -- verified: the contact is verified. restricted: the disclosure policy applied (PRD section 6.6).
  ADD COLUMN disclosure_level text,
  ADD COLUMN disclosure_removed integer NOT NULL DEFAULT 0,
  -- The text still holds a placeholder that is not the customer's own, or is in another language: a
  -- person must read it before it goes anywhere.
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN requested_by uuid,
  -- What the person did: approved as written, edited and sent, or rejected.
  ADD COLUMN disposition text,
  -- Normalised word edit distance between the draft and what was sent: 0 (the same) to 1.
  ADD COLUMN edit_distance real,
  -- One of the nine ids of docs/06-UI-SPEC.md section 6.3. Data, not a CHECK (the list may grow).
  ADD COLUMN reject_reason text,
  ADD COLUMN reject_comment text,
  ADD COLUMN resolved_by uuid,
  ADD COLUMN resolved_at timestamptz,
  -- The message a person sent after editing the draft.
  ADD COLUMN final_message_id uuid REFERENCES message (id) ON DELETE RESTRICT;
ALTER TABLE ai_draft
  ADD CONSTRAINT ai_draft_disposition_check CHECK (disposition IS NULL OR disposition IN ('approved', 'edited', 'rejected')),
  ADD CONSTRAINT ai_draft_edit_distance_check CHECK (edit_distance IS NULL OR edit_distance BETWEEN 0 AND 1),
  ADD CONSTRAINT ai_draft_uncited_check CHECK (uncited_claims >= 0 AND disclosure_removed >= 0),
  ADD CONSTRAINT ai_draft_disclosure_check CHECK (disclosure_level IS NULL OR disclosure_level IN ('verified', 'restricted')),
  ADD CONSTRAINT ai_draft_reject_check CHECK ((disposition IS NOT DISTINCT FROM 'rejected') = (reject_reason IS NOT NULL)),
  -- A rejection by a person carries its reason; the status may also be `rejected` without one (0013 allowed it).
  ADD CONSTRAINT ai_draft_reject_status_check CHECK (disposition IS DISTINCT FROM 'rejected' OR status = 'rejected');
-- The status rules of 0013 plus the new end state: a draft that waits for a person can be superseded by
-- a newer one, and a superseded draft does not change (0013 stays as applied; the function is replaced).
CREATE OR REPLACE FUNCTION ai_draft_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('sent', 'rejected', 'superseded') AND (NEW.status <> OLD.status OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'ai_draft: a % draft does not change', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'sent', 'rejected', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sent'))
    ) THEN
    RAISE EXCEPTION 'ai_draft: % -> % is not a transition', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'ai_draft: the approval of an approved draft cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
-- At most one draft waits for a person per ticket: the writer supersedes the old one in the same
-- transaction, under a lock on the ticket (not a unique index: 0013's tests insert several).
GRANT UPDATE (disposition, edit_distance, reject_reason, reject_comment, resolved_by, resolved_at, final_message_id)
  ON ai_draft TO watchtower_app;

-- 4. Insight: the report, the progress and who asked.
ALTER TABLE ai_ticket_insight
  ADD COLUMN report jsonb,
  ADD COLUMN progress jsonb,
  ADD COLUMN requested_by uuid,
  ADD COLUMN investigated_at timestamptz,
  ADD CONSTRAINT ai_ticket_insight_draft_fk FOREIGN KEY (draft_id) REFERENCES ai_draft (id) ON DELETE RESTRICT;

-- 5. KB versions: who asked the AI to write it.
ALTER TABLE kb_article_version ADD COLUMN requested_by uuid;
