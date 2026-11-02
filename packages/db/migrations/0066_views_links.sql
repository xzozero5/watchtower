-- T-119a,c: saved views kept on the server (R-1.8) and links between tickets (R-1.1).
--   saved_view: a named set of ticket filters and a sort. Personal (owner only) or shared with the team
--     (`view.share`). The built-in views (My queue, SLA at risk, ...) are code, not rows. `filters` is
--     validated by the application (packages/shared `savedViewFiltersSchema`); here it must be an
--     object. No ticket data is stored, only the filter values the person chose.
--   ticket_link: `duplicate` (from_ticket_id is a duplicate of to_ticket_id) or `related` (symmetric:
--     stored once, smaller id first, so the same pair cannot be linked twice in two directions). A link
--     is created and deleted by staff, never edited; the history is in ticket_event and audit_log.
-- Reversible: see 0066_views_links.down.sql.

CREATE TABLE saved_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name text NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort text NOT NULL DEFAULT 'sla_due_asc',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_view_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT saved_view_filters_object CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT saved_view_sort_check CHECK (
    sort IN ('created_desc', 'updated_desc', 'due_asc', 'created_asc', 'sla_due_asc')
  )
);
-- A name is unique among a person's own views and among the shared ones, ignoring case.
CREATE UNIQUE INDEX saved_view_personal_name_key ON saved_view (owner_id, lower(name)) WHERE NOT shared;
CREATE UNIQUE INDEX saved_view_shared_name_key ON saved_view (lower(name)) WHERE shared;
CREATE INDEX saved_view_owner_idx ON saved_view (owner_id);

CREATE TABLE ticket_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  from_ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  to_ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_link_kind_check CHECK (kind IN ('duplicate', 'related')),
  CONSTRAINT ticket_link_distinct_check CHECK (from_ticket_id <> to_ticket_id),
  -- `related` is symmetric: the pair is stored one way only.
  CONSTRAINT ticket_link_related_order_check CHECK (kind <> 'related' OR from_ticket_id < to_ticket_id)
);
CREATE UNIQUE INDEX ticket_link_pair_key ON ticket_link (kind, from_ticket_id, to_ticket_id);
CREATE INDEX ticket_link_from_idx ON ticket_link (from_ticket_id);
CREATE INDEX ticket_link_to_idx ON ticket_link (to_ticket_id);

-- A link is never edited: delete it and make another. Rows are removed by "unlink" only.
REVOKE UPDATE ON ticket_link FROM watchtower_app, PUBLIC;
