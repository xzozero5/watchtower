-- T-302a (PRD 6.4): a reply that a lead or head marks as a good answer to its intent ("Mark as golden").
--   golden_answer  one row per marked message, kept only in redacted form (the same redactor that runs before
--                  the LLM, N4): the original text is never copied. The drafter reads the newest few of the
--                  same intent as examples of tone and content (never as facts about the new ticket).
--                  Append-only: a row is added, and it is retired by setting deleted_at / deleted_by (soft
--                  delete). Nothing else is ever updated, and nothing is physically deleted by the app role.
-- A message can be golden once while it is live (partial unique index); after a delete it can be marked again.
-- Reversible: see 0098_golden_answer.down.sql.

INSERT INTO permissions (key, description) VALUES
  ('ai.golden.manage', 'Mark a sent reply as a golden answer, list and remove golden answers')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role, permission) VALUES
  ('lead', 'ai.golden.manage'),
  ('head', 'ai.golden.manage')
ON CONFLICT DO NOTHING;

CREATE TABLE golden_answer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  message_id uuid NOT NULL REFERENCES message (id) ON DELETE RESTRICT,
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  -- Redacted: placeholders such as [EMAIL_1] stand where a person's details were.
  body_redacted text NOT NULL,
  language text,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT golden_answer_body_check CHECK (btrim(body_redacted) <> '' AND char_length(body_redacted) <= 20000),
  CONSTRAINT golden_answer_language_check CHECK (language IS NULL OR language IN ('th', 'en')),
  CONSTRAINT golden_answer_deleted_check CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE UNIQUE INDEX golden_answer_live_message_key ON golden_answer (message_id) WHERE deleted_at IS NULL;
CREATE INDEX golden_answer_intent_idx ON golden_answer (intent_id, created_at DESC) WHERE deleted_at IS NULL;

-- Append and soft delete only: the app role can change the two columns that retire a row and nothing else.
REVOKE UPDATE, DELETE, TRUNCATE ON golden_answer FROM watchtower_app, PUBLIC;
GRANT UPDATE (deleted_at, deleted_by) ON golden_answer TO watchtower_app;
