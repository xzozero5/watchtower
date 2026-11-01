-- T-105: in-app notifications and per-user preferences.
-- A notification belongs to one person and is read only by that person (the API filters on the
-- caller's id; the table has no organization-scoped reader). It holds ids and small counts only:
-- no ticket subject, no customer name, no message text (N1, N4). The center joins the ticket at
-- read time, so an edited subject is never stale and a copy of it never outlives the ticket.
-- `org_id`, `queue_id` and `channel` are facets copied from the ticket when the notification is
-- made, so a filter ("N new" in this queue) does not need the ticket.
-- `dedupe_key` makes the same alert for the same person happen once (a re-run of a shift scan, a
-- ticket raised to P1 twice).
-- The application may change only `read_at`; it may delete (retention).
-- Reversible: see 0032_notifications.down.sql.

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL,
  dedupe_key text NOT NULL,
  ticket_id uuid REFERENCES ticket (id) ON DELETE CASCADE,
  org_id uuid,
  queue_id uuid,
  channel text,
  -- Counts and ids only, for example {"count": 2}.
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notification_kind_check CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show')),
  CONSTRAINT notification_severity_check CHECK (severity IN ('critical', 'high', 'normal')),
  CONSTRAINT notification_data_object CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT notification_user_dedupe UNIQUE (user_id, dedupe_key)
);
-- The center: newest first for one person.
CREATE INDEX notification_user_created_idx ON notification (user_id, created_at DESC, id DESC);
-- The badge and the sticky banner: what is still unread.
CREATE INDEX notification_user_unread_idx ON notification (user_id, created_at DESC) WHERE read_at IS NULL;
-- Retention sweeps by age.
CREATE INDEX notification_created_idx ON notification (created_at);

CREATE TABLE notification_preference (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind),
  CONSTRAINT notification_preference_kind_check CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show')),
  -- Missing a P1 is not a preference.
  CONSTRAINT notification_preference_p1_on CHECK (kind <> 'ticket.p1' OR in_app)
);

-- A notification is never edited except to mark it read.
REVOKE UPDATE ON notification FROM watchtower_app, PUBLIC;
GRANT UPDATE (read_at) ON notification TO watchtower_app;
