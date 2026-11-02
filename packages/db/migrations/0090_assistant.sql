-- T-134 / T-135 (ADR-017): the AI assistant and the claim-shaped AI summaries.
--   assistant_conversation  one thread of one person with the assistant. Kept for a limited time
--                           (ASSISTANT_RETENTION_DAYS); a person can delete their own.
--   assistant_message       what was said, in REDACTED form only (N4): placeholders instead of personal
--                           data, no token map. Also the per-person meter: tokens and cost of the
--                           model calls behind an assistant turn (the daily token budget per person).
--   assistant_proposal      a write the assistant proposed. The card is made of server values; the
--                           person presses once; it can be used once, by its owner, before it expires.
--   assistant_usage         what each person has used today: messages and tokens. Kept apart from the
--                           conversations on purpose: deleting a conversation must not give the day's
--                           budget back. Holds numbers only.
--   ai_summary              the latest AI summary of a screen for one person (daily brief, handoff
--                           prefill) with the fingerprint of the facts it was made from, so an
--                           unchanged screen does not cost another model call.
-- Reversible: see 0090_assistant.down.sql.

CREATE TABLE assistant_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  locale text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assistant_conversation_locale_check CHECK (locale IN ('th', 'en'))
);
CREATE INDEX assistant_conversation_user_idx ON assistant_conversation (user_id, updated_at DESC);
-- The retention sweep walks the oldest first, by the day a conversation began: a conversation that is
-- kept in use does not live for ever.
CREATE INDEX assistant_conversation_created_idx ON assistant_conversation (created_at);

CREATE TABLE assistant_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversation (id) ON DELETE CASCADE,
  -- Repeated from the conversation so the daily meter of a person is one indexed range scan.
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL,
  -- Redacted before it was stored. Never the text the person saw (that has the personal data back).
  body text NOT NULL,
  -- What the chips sent: { page, ticket } (the ticket number, not its content).
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The tools the turn used: [{ name, status, mock }].
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- ai_run ids of the model calls of this turn (no foreign key: ai_run is partitioned).
  ai_run_ids uuid[] NOT NULL DEFAULT '{}',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(14, 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assistant_message_role_check CHECK (role IN ('user', 'assistant')),
  CONSTRAINT assistant_message_body_check CHECK (length(body) <= 20000),
  CONSTRAINT assistant_message_tokens_check CHECK (input_tokens >= 0 AND output_tokens >= 0)
);
CREATE INDEX assistant_message_conversation_idx ON assistant_message (conversation_id, created_at);
CREATE INDEX assistant_message_user_idx ON assistant_message (user_id, created_at DESC);

CREATE TABLE assistant_proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversation (id) ON DELETE CASCADE,
  message_id uuid REFERENCES assistant_message (id) ON DELETE SET NULL,
  -- Only this person may confirm or reject it.
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- The ticket acted on; null for a new ticket or a KB draft.
  ticket_id uuid REFERENCES ticket (id) ON DELETE CASCADE,
  -- Validated against the schema of the ordinary route, with ids resolved by the server.
  params jsonb NOT NULL,
  -- The card the person saw (ProposalCard without id/status/expiresAt).
  card jsonb NOT NULL,
  -- The ticket's updated_at when the card was made: a different value at confirm time means stale.
  base_updated_at timestamptz,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  -- A stable code when a confirmed attempt failed or went stale; never a message.
  fail_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assistant_proposal_kind_check CHECK (
    kind IN ('assign', 'status', 'tag', 'note', 'create_ticket', 'kb_draft', 'reply_draft')
  ),
  CONSTRAINT assistant_proposal_status_check CHECK (
    status IN ('pending', 'confirmed', 'rejected', 'expired', 'failed')
  ),
  CONSTRAINT assistant_proposal_decided_check CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX assistant_proposal_user_idx ON assistant_proposal (user_id, created_at DESC);
CREATE INDEX assistant_proposal_conversation_idx ON assistant_proposal (conversation_id);

CREATE TABLE assistant_usage (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The UTC day, the same day the AI budget of the system uses.
  day date NOT NULL,
  messages integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(14, 8),
  PRIMARY KEY (user_id, day),
  CONSTRAINT assistant_usage_counts_check CHECK (messages >= 0 AND input_tokens >= 0 AND output_tokens >= 0)
);

CREATE TABLE ai_summary (
  kind text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- One row per language: switching the language of the screen back and forth costs nothing.
  locale text NOT NULL DEFAULT 'en',
  -- Keyed hash of the facts and the language the summary was made from.
  fingerprint text NOT NULL,
  claims jsonb NOT NULL,
  ai_run_id uuid,
  mock boolean NOT NULL DEFAULT false,
  data_as_of timestamptz NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, user_id, locale),
  CONSTRAINT ai_summary_kind_check CHECK (kind IN ('brief', 'handoff')),
  CONSTRAINT ai_summary_locale_check CHECK (locale IN ('th', 'en'))
);
