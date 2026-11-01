-- Reverts 0034. Lossy on purpose: tool executions, the investigation reports and what people did with
-- AI drafts (approve, edit, reject) go away. A superseded draft becomes `rejected`, which 0013 knows.
-- kb_article_version is immutable, so the
-- `requested_by` column cannot be dropped while versions exist without the owner lifting the trigger; the
-- column is dropped inside a transaction that disables the trigger for the owner.
ALTER TABLE kb_article_version DISABLE TRIGGER USER;
ALTER TABLE kb_article_version DROP COLUMN IF EXISTS requested_by;
ALTER TABLE kb_article_version ENABLE TRIGGER USER;

ALTER TABLE ai_ticket_insight
  DROP CONSTRAINT IF EXISTS ai_ticket_insight_draft_fk,
  DROP COLUMN IF EXISTS investigated_at,
  DROP COLUMN IF EXISTS requested_by,
  DROP COLUMN IF EXISTS progress,
  DROP COLUMN IF EXISTS report;

-- A superseded draft may be referenced by a delivery (an undone send), so it is kept and becomes
-- `rejected` (a status 0013 knows), not deleted. The guard trigger forbids leaving `superseded`, so it
-- is off for this one statement.
ALTER TABLE ai_draft DISABLE TRIGGER ai_draft_guard;
UPDATE ai_draft SET status = 'rejected' WHERE status = 'superseded';
ALTER TABLE ai_draft ENABLE TRIGGER ai_draft_guard;
ALTER TABLE ai_draft
  DROP CONSTRAINT IF EXISTS ai_draft_reject_status_check,
  DROP CONSTRAINT IF EXISTS ai_draft_reject_check,
  DROP CONSTRAINT IF EXISTS ai_draft_disclosure_check,
  DROP CONSTRAINT IF EXISTS ai_draft_uncited_check,
  DROP CONSTRAINT IF EXISTS ai_draft_edit_distance_check,
  DROP CONSTRAINT IF EXISTS ai_draft_disposition_check;
ALTER TABLE ai_draft
  DROP COLUMN IF EXISTS final_message_id,
  DROP COLUMN IF EXISTS resolved_at,
  DROP COLUMN IF EXISTS resolved_by,
  DROP COLUMN IF EXISTS reject_comment,
  DROP COLUMN IF EXISTS reject_reason,
  DROP COLUMN IF EXISTS edit_distance,
  DROP COLUMN IF EXISTS disposition,
  DROP COLUMN IF EXISTS requested_by,
  DROP COLUMN IF EXISTS needs_review,
  DROP COLUMN IF EXISTS disclosure_removed,
  DROP COLUMN IF EXISTS disclosure_level,
  DROP COLUMN IF EXISTS prompt_version,
  DROP COLUMN IF EXISTS prompt_id,
  DROP COLUMN IF EXISTS uncited_claims,
  DROP COLUMN IF EXISTS citations,
  DROP COLUMN IF EXISTS customer_language,
  DROP COLUMN IF EXISTS language;
ALTER TABLE ai_draft DROP CONSTRAINT IF EXISTS ai_draft_status_check;
ALTER TABLE ai_draft ADD CONSTRAINT ai_draft_status_check
  CHECK (status IN ('draft', 'approved', 'sent', 'rejected'));

-- The status rules of 0013 again.
CREATE OR REPLACE FUNCTION ai_draft_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('sent', 'rejected') AND (NEW.status <> OLD.status OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'ai_draft: a % draft does not change', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'sent', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sent'))
    -- A send that failed with an unknown outcome reopened the draft; a late success closes it.
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

DROP VIEW IF EXISTS ai_v_ticket_message;
DROP VIEW IF EXISTS ai_v_ticket;
DROP VIEW IF EXISTS ai_v_org;
-- The group role is cluster-wide and may serve other databases, so it is kept (like watchtower_app).
REVOKE USAGE ON SCHEMA public FROM watchtower_ai_ro;

DROP TABLE IF EXISTS tool_execution;
