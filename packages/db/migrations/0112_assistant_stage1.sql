-- T-401 (ADR-029): Watchtower assistant stage 1.
--   assistant_memory          what a person asked the assistant to remember ("pin"). Redacted text only (N4),
--                             at most 300 characters, at most five {kind, id} refs that are resolved again with the
--                             person's permissions each time they are used. Written by the person only, never by
--                             a model. Expires 90 days after it was last used; one person never reads another's.
--   assistant_message.evidence the evidence of an answer as [{kind, id}] only: label and href are rebuilt with the
--                             permissions the person has when the history is shown.
--   assistant_message.path     how the turn was answered: facts_only | llm1 | llm2 (null for the turns before this).
--   assistant.use             the permission of every /v1/assistant route. agent, lead (inherits agent), head
--                             (inherits lead) and dev. A client and a system identity are refused in code even if
--                             a head grants it (rbac.manage).
-- Reversible: see 0112_assistant_stage1.down.sql.

CREATE TABLE assistant_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Redacted before it was stored (N4).
  body text NOT NULL,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT assistant_memory_body_check CHECK (length(body) BETWEEN 1 AND 300),
  CONSTRAINT assistant_memory_refs_check CHECK (
    jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) <= 5
  )
);
CREATE INDEX assistant_memory_user_idx ON assistant_memory (user_id, last_used_at DESC);
CREATE INDEX assistant_memory_expires_idx ON assistant_memory (expires_at);

ALTER TABLE assistant_message
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN path text,
  ADD CONSTRAINT assistant_message_path_check CHECK (path IS NULL OR path IN ('facts_only', 'llm1', 'llm2'));

INSERT INTO permissions (key, description) VALUES
  ('assistant.use', 'Use the AI assistant: ask questions about what your role may already read');

INSERT INTO role_permissions (role, permission) VALUES
  ('agent', 'assistant.use'),
  ('lead', 'assistant.use'),
  ('head', 'assistant.use'),
  ('dev', 'assistant.use');
