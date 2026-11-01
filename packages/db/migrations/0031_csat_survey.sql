-- T-110a,b: CSAT survey ledger (R-10.1 to R-10.5). One row per ticket that was resolved and is owed (or
-- was spared) a survey. The row is the whole state of the survey: when it is due, whether it was sent,
-- whether the customer answered, and why it was skipped or voided. The survey link itself is never
-- stored: it is an HMAC of this row's id and expiry, so a database dump cannot be used to answer
-- surveys. A link works once: the answer is a conditional UPDATE (status 'sent' -> 'answered').
-- Holds ids, codes, the 1-5 score and the customer's optional comment. No address, no ticket text.
-- Also: per-organization opt-out (R-10.4) and the instance setting `csat.delay_minutes` (R-10.1).
-- Reversible: see 0031_csat_survey.down.sql.

CREATE TABLE csat_survey (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES contact (id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES organization (id) ON DELETE RESTRICT,
  -- How the survey reaches the customer. LINE delivery is T-110c; the column allows it already.
  channel text NOT NULL DEFAULT 'email',
  status text NOT NULL DEFAULT 'scheduled',
  -- Not sent before this instant (resolved time + the configured delay).
  send_after timestamptz NOT NULL,
  sent_at timestamptz,
  -- One reminder, 48 hours after the survey was sent, if it is still unanswered (R-10.4).
  reminder_due_at timestamptz,
  reminder_sent_at timestamptz,
  -- The survey link stops working at this instant (set when the survey is sent).
  token_expires_at timestamptz,
  answered_at timestamptz,
  -- A stable code, set when the survey is skipped or voided (never free text).
  reason text,
  score smallint,
  -- "Was this resolved?": null when the customer did not say.
  resolved boolean,
  comment text,
  -- True when this answer reopened the ticket (R-1.10, R-10.5).
  reopened boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT csat_survey_channel_check CHECK (channel IN ('email', 'line')),
  CONSTRAINT csat_survey_status_check CHECK (
    status IN ('scheduled', 'sent', 'answered', 'voided', 'skipped', 'expired')
  ),
  CONSTRAINT csat_survey_score_check CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  CONSTRAINT csat_survey_comment_check CHECK (comment IS NULL OR char_length(comment) <= 2000),
  -- A survey that went out has a delivery time and a link lifetime; one that did not go out has neither.
  CONSTRAINT csat_survey_sent_check CHECK (
    status NOT IN ('sent', 'answered', 'expired')
    OR (sent_at IS NOT NULL AND token_expires_at IS NOT NULL)
  ),
  CONSTRAINT csat_survey_unsent_check CHECK (status NOT IN ('scheduled', 'skipped') OR sent_at IS NULL),
  -- An answer has a time and a score, and only an answer does.
  CONSTRAINT csat_survey_answered_check CHECK (
    (status = 'answered') = (answered_at IS NOT NULL AND score IS NOT NULL)
  ),
  CONSTRAINT csat_survey_answer_fields_check CHECK (
    status = 'answered' OR (score IS NULL AND resolved IS NULL AND comment IS NULL AND NOT reopened)
  ),
  CONSTRAINT csat_survey_reason_check CHECK (status NOT IN ('voided', 'skipped') OR reason IS NOT NULL),
  CONSTRAINT csat_survey_reminder_check CHECK (reminder_sent_at IS NULL OR sent_at IS NOT NULL)
);
-- A ticket has at most one survey in flight; an answered, voided, skipped or expired one does not block
-- the next resolve (a ticket that was reopened and resolved again may be surveyed again).
CREATE UNIQUE INDEX csat_survey_ticket_live_key ON csat_survey (ticket_id)
  WHERE status IN ('scheduled', 'sent');
-- The sweep: surveys that are due, reminders that are due, links that ran out.
CREATE INDEX csat_survey_due_idx ON csat_survey (send_after) WHERE status = 'scheduled';
CREATE INDEX csat_survey_reminder_idx ON csat_survey (reminder_due_at)
  WHERE status = 'sent' AND reminder_sent_at IS NULL;
CREATE INDEX csat_survey_expiry_idx ON csat_survey (token_expires_at) WHERE status = 'sent';
-- "At most one survey per contact per 7 days" (R-10.4).
CREATE INDEX csat_survey_contact_idx ON csat_survey (contact_id, sent_at DESC) WHERE sent_at IS NOT NULL;
-- The results feed (R-10.5).
CREATE INDEX csat_survey_answered_idx ON csat_survey (answered_at DESC, id DESC) WHERE status = 'answered';

-- The application records surveys and their outcome; it never deletes one.
REVOKE DELETE ON csat_survey FROM watchtower_app, PUBLIC;

-- Organizations that asked not to be surveyed (R-10.4). A row means opted out; removing it opts back in.
CREATE TABLE csat_org_opt_out (
  org_id uuid PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE ON csat_org_opt_out FROM watchtower_app, PUBLIC;

-- The delay between "resolved" and the survey, in minutes (R-10.1, default one hour).
ALTER TABLE instance_setting ADD CONSTRAINT instance_setting_csat_delay_check CHECK (
  key <> 'csat.delay_minutes'
  OR CASE
       WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,5}$'
         THEN (value #>> '{}')::integer BETWEEN 0 AND 10080
       ELSE false
     END
);
INSERT INTO instance_setting (key, value) VALUES ('csat.delay_minutes', '60'::jsonb);
