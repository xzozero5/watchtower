-- T-202b: the ids of Discord interactions already handled (PRD section 11: Discord interactions over
-- HTTP, 3 s to answer). Discord may deliver an interaction again (a retry after a slow answer, a replayed
-- request); the id is unique, so the second delivery changes nothing and is answered "already handled".
-- Ids and a code only: no user, no message, no payload (N4). Rows older than a day are pruned by the
-- handler itself; an interaction token is valid for 15 minutes, so a day is generous. Reversible:
-- 0045_discord_interaction.down.sql.
CREATE TABLE discord_interaction (
  id text PRIMARY KEY,
  -- A stable code of what was done: `acked`, `already`, `refused_unlinked`, `refused_forbidden`, ...
  outcome text NOT NULL,
  handled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discord_interaction_id_check CHECK (id ~ '^[0-9]{5,30}$'),
  CONSTRAINT discord_interaction_outcome_check CHECK (length(outcome) BETWEEN 1 AND 60)
);
CREATE INDEX discord_interaction_handled_idx ON discord_interaction (handled_at);
