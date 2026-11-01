-- T-111a: shifts, roster, clock in/out, structured handoff with per-item acknowledgment, and shift
-- notes (PRD R-7.1, R-7.3, R-7.5 to R-7.7, AC-7), plus two more queue assignment modes (R-1.7).
--   1. team_queue:        assignment_mode also accepts `load_balanced` and `stay_with_last_handler`.
--   2. shift_definition:  a named wall-clock window ("08:00" to "17:00") with an on-call flag. The zone of
--                         that wall clock is the default business calendar's, never the server's. The
--                         starter shifts (owner decision po #7) are seeded by the dev seed, not here.
--   3. roster_entry:      who works which shift on which local date (the date the shift starts).
--   4. shift_session:     one row per clock in. At most one is open per person. Not deleted; the
--                         application may only set the clock-out, the lead override and the brief-read stamp.
--   5. handoff:           one per session, draft until confirmed; handoff_item holds its rows (pending
--                         tickets, incidents, ...) and the incoming person's acknowledgment of each.
--   6. shift_note:        a message to the next shift, a person, or a date and time; shift_note_read is
--                         the per-person "marked read".
-- The application role gets SELECT, INSERT, UPDATE and DELETE from the default privileges of 0001, except
-- where noted. Reversible: see 0020_shifts.down.sql.

-- 1. Queue assignment modes.
ALTER TABLE team_queue DROP CONSTRAINT team_queue_mode_check;
ALTER TABLE team_queue ADD CONSTRAINT team_queue_mode_check CHECK (
  assignment_mode IN ('manual', 'round_robin', 'load_balanced', 'stay_with_last_handler')
);

-- 2. Shift definitions.
CREATE TABLE shift_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Local wall-clock time, HH:MM (24 h). An end that is not after the start means the shift ends the next day.
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  on_call boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_definition_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT shift_definition_starts_check CHECK (starts_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT shift_definition_ends_check CHECK (ends_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT shift_definition_span_check CHECK (starts_at <> ends_at)
);
CREATE UNIQUE INDEX shift_definition_name_key ON shift_definition (lower(name));

-- 3. Roster.
CREATE TABLE roster_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES shift_definition (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The local date (in the calendar's zone) on which the shift starts.
  work_date date NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roster_entry_slot_key ON roster_entry (user_id, shift_id, work_date);
CREATE INDEX roster_entry_date_idx ON roster_entry (work_date, shift_id);

-- 4. Clock in and out.
CREATE TABLE shift_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- What the person was rostered for when they clocked in; null for "clock in anyway".
  shift_id uuid REFERENCES shift_definition (id) ON DELETE SET NULL,
  roster_entry_id uuid REFERENCES roster_entry (id) ON DELETE SET NULL,
  -- The window as it was then: later edits of the definition do not move a past session.
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  clocked_in_at timestamptz NOT NULL DEFAULT now(),
  late_minutes integer NOT NULL DEFAULT 0,
  device text,
  -- Consent only. No position is stored in Phase 1.
  location_consent boolean NOT NULL DEFAULT false,
  clocked_out_at timestamptz,
  -- A lead or head clocked the person out with the handoff incomplete (R-7.3); the reason is required.
  override_by uuid REFERENCES users (id) ON DELETE SET NULL,
  override_reason text,
  brief_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_session_late_check CHECK (late_minutes >= 0),
  CONSTRAINT shift_session_window_pair CHECK ((scheduled_start IS NULL) = (scheduled_end IS NULL)),
  CONSTRAINT shift_session_out_check CHECK (clocked_out_at IS NULL OR clocked_out_at >= clocked_in_at),
  CONSTRAINT shift_session_override_check CHECK (
    override_reason IS NULL OR (clocked_out_at IS NOT NULL AND btrim(override_reason) <> '')
  )
);
-- A person is clocked in at most once at a time.
CREATE UNIQUE INDEX shift_session_open_key ON shift_session (user_id) WHERE clocked_out_at IS NULL;
CREATE INDEX shift_session_user_idx ON shift_session (user_id, clocked_in_at DESC);
CREATE INDEX shift_session_roster_idx ON shift_session (roster_entry_id) WHERE roster_entry_id IS NOT NULL;
REVOKE UPDATE, DELETE ON shift_session FROM watchtower_app, PUBLIC;
GRANT UPDATE (clocked_out_at, override_by, override_reason, brief_read_at) ON shift_session TO watchtower_app;

-- 5. Handoff.
CREATE TABLE handoff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One handoff per clock-in session: the outgoing person's.
  session_id uuid NOT NULL UNIQUE REFERENCES shift_session (id) ON DELETE RESTRICT,
  from_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- The named incoming person; null means whoever is on the next shift.
  to_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  notes text NOT NULL DEFAULT '',
  message_for_next text NOT NULL DEFAULT '',
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoff_status_check CHECK (status IN ('draft', 'confirmed')),
  CONSTRAINT handoff_confirmed_check CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT handoff_recipient_check CHECK (to_user_id IS NULL OR to_user_id <> from_user_id)
);
CREATE INDEX handoff_confirmed_idx ON handoff (confirmed_at DESC) WHERE status = 'confirmed';
CREATE INDEX handoff_to_idx ON handoff (to_user_id) WHERE to_user_id IS NOT NULL;

CREATE TABLE handoff_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES handoff (id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  -- pending: a ticket carried over. The rest are written by the outgoing person.
  kind text NOT NULL,
  ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  title text NOT NULL,
  next_action text,
  due_at timestamptz,
  severity text,
  -- prefill: made from the data when the draft was created. manual: typed by the person.
  source text NOT NULL,
  -- A prefilled item whose text the person changed (R-7.5).
  edited boolean NOT NULL DEFAULT false,
  requires_ack boolean NOT NULL,
  -- Shifts the ticket had crossed before this handoff (R-7.6).
  carried_shifts integer NOT NULL DEFAULT 0,
  -- The incoming person's answer (R-7.6). `question` counts as acknowledged; the item stays open.
  ack_status text NOT NULL DEFAULT 'pending',
  ack_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ack_at timestamptz,
  ack_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoff_item_kind_check CHECK (kind IN ('pending', 'incident', 'deploy', 'alert', 'watch', 'note')),
  CONSTRAINT handoff_item_source_check CHECK (source IN ('prefill', 'manual')),
  CONSTRAINT handoff_item_ticket_check CHECK ((kind = 'pending') = (ticket_id IS NOT NULL)),
  CONSTRAINT handoff_item_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT handoff_item_carried_check CHECK (carried_shifts >= 0),
  CONSTRAINT handoff_item_ack_check CHECK (ack_status IN ('pending', 'accepted', 'reassigned', 'question')),
  CONSTRAINT handoff_item_ack_time CHECK ((ack_status = 'pending') = (ack_at IS NULL)),
  CONSTRAINT handoff_item_ack_needed CHECK (requires_ack OR ack_status = 'pending')
);
CREATE INDEX handoff_item_handoff_idx ON handoff_item (handoff_id, position);
CREATE UNIQUE INDEX handoff_item_ticket_key ON handoff_item (handoff_id, ticket_id) WHERE ticket_id IS NOT NULL;
-- The lead's "unacknowledged" count and the incoming person's list.
CREATE INDEX handoff_item_open_idx ON handoff_item (handoff_id) WHERE requires_ack AND ack_status IN ('pending', 'question');
-- Carried-over count: the latest earlier item of the same ticket.
CREATE INDEX handoff_item_ticket_idx ON handoff_item (ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;

-- 6. Shift notes.
CREATE TABLE shift_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  audience text NOT NULL,
  to_user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  -- For `datetime`: when the note starts to show.
  deliver_at timestamptz,
  body text NOT NULL,
  -- Set on the note that a handoff's "message for the next shift" became.
  handoff_id uuid REFERENCES handoff (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_note_audience_check CHECK (audience IN ('next_shift', 'person', 'datetime')),
  CONSTRAINT shift_note_person_check CHECK (audience <> 'person' OR to_user_id IS NOT NULL),
  CONSTRAINT shift_note_datetime_check CHECK (audience <> 'datetime' OR deliver_at IS NOT NULL),
  CONSTRAINT shift_note_body_check CHECK (btrim(body) <> '')
);
CREATE INDEX shift_note_to_idx ON shift_note (to_user_id, created_at DESC) WHERE to_user_id IS NOT NULL;
CREATE INDEX shift_note_audience_idx ON shift_note (audience, created_at DESC);
CREATE INDEX shift_note_author_idx ON shift_note (author_id, created_at DESC);
CREATE UNIQUE INDEX shift_note_handoff_key ON shift_note (handoff_id) WHERE handoff_id IS NOT NULL;
-- The text never changes after it was written. (handoff_id is set by ON DELETE SET NULL, a system action.)
REVOKE UPDATE ON shift_note FROM watchtower_app, PUBLIC;

CREATE TABLE shift_note_read (
  note_id uuid NOT NULL REFERENCES shift_note (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX shift_note_read_user_idx ON shift_note_read (user_id, read_at DESC);
