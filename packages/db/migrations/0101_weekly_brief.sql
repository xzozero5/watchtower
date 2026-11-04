-- T-305c (PRD 9.2): the AI-drafted weekly brief of the CEO view. One row per weekly slot (the local date of the
-- configured day and time), made by the worker from the real figures of the CEO view and the facts of the week.
--   content     what the head reads and edits: summary claims, up to five root causes, decisions needed. Every
--               claim carries its evidence (ticket / incident / metric), or says it has none (`uncited`).
--   ai_content  the same text as the model wrote it, never changed after insert: the diff of the head's edit
--               is what shows whether the brief was good (N5).
--   figures     the CEO view as it was when the brief was made, so a published brief never moves.
-- A draft is edited by a head; a published brief is final (the CHECK and the app both refuse a change).
-- Reversible: see 0101_weekly_brief.down.sql.

CREATE TABLE weekly_brief (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The local date of the slot the brief was made for (for example the Monday it is due). One brief per slot.
  slot_date date NOT NULL,
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  -- draft | published
  status text NOT NULL DEFAULT 'draft',
  -- th | en: the language of the text
  locale text NOT NULL DEFAULT 'en',
  -- ai: written by the model. data_only: the AI was off, over budget or gave nothing usable; the figures are
  -- there and the head writes the words. `reason_code` says why.
  source text NOT NULL,
  reason_code text,
  figures jsonb NOT NULL,
  content jsonb NOT NULL,
  ai_content jsonb NOT NULL,
  ai_run_id uuid,
  prompt_version integer,
  mock boolean NOT NULL DEFAULT false,
  edited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  edited_at timestamptz,
  recipients text[] NOT NULL DEFAULT '{}',
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT weekly_brief_slot_key UNIQUE (slot_date),
  CONSTRAINT weekly_brief_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT weekly_brief_locale_check CHECK (locale IN ('th', 'en')),
  CONSTRAINT weekly_brief_source_check CHECK (source IN ('ai', 'data_only')),
  CONSTRAINT weekly_brief_period_check CHECK (period_from < period_to),
  CONSTRAINT weekly_brief_published_check CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT weekly_brief_recipients_check CHECK (cardinality(recipients) <= 50)
);
CREATE INDEX weekly_brief_status_idx ON weekly_brief (status, slot_date DESC);

-- A published brief is final: the text, the figures and the recipients do not change after the head published.
CREATE FUNCTION weekly_brief_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'a published weekly brief cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.ai_content IS DISTINCT FROM OLD.ai_content OR NEW.figures IS DISTINCT FROM OLD.figures THEN
    RAISE EXCEPTION 'the figures and the AI text of a weekly brief cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weekly_brief_final_update BEFORE UPDATE ON weekly_brief
  FOR EACH ROW EXECUTE FUNCTION weekly_brief_final();
REVOKE DELETE, TRUNCATE ON weekly_brief FROM watchtower_app, PUBLIC;
