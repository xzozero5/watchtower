-- T-408 (ADR-029 sections 5 and 9.6): feedback on the assistant.
--   assistant_feedback   one thumbs-up / thumbs-down per person and target, with a reason code on a thumbs-down. The target
--                        is an answer of the assistant ('message') or an embedded insight ('insight'). It holds no text
--                        of the person and none of the answer: ids, the element key of an insight, the rating and a code.
--                        target_id has no foreign key on purpose: the answer is gone after the conversation's retention
--                        and the insight after its expiry, and the rating is still a measure of the prompt (the
--                        'judges_person' share of section 9.9). The api checks that the person may see the target before
--                        it writes (a target they may not see is a 404, C-18).
-- Reversible: 0114_assistant_feedback.down.sql.

CREATE TABLE assistant_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  -- Key of INSIGHT_ELEMENTS for an insight (so the share per element can be read); null for a message.
  element text,
  rating text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assistant_feedback_target_kind_check CHECK (target_kind IN ('message', 'insight')),
  CONSTRAINT assistant_feedback_rating_check CHECK (rating IN ('up', 'down')),
  CONSTRAINT assistant_feedback_reason_check CHECK (
    reason IS NULL
    OR (rating = 'down' AND reason IN ('wrong_number', 'not_useful', 'misleading', 'judges_person', 'other'))
  ),
  CONSTRAINT assistant_feedback_one_per_target UNIQUE (user_id, target_kind, target_id)
);
CREATE INDEX assistant_feedback_updated_idx ON assistant_feedback (updated_at);
