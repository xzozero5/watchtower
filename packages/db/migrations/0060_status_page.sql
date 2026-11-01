-- T-204a: the public status page (PRD R-6.1 to R-6.3). Reversible: 0060_status_page.down.sql.
--
--   status_component              what the page lists. `public = false` (the default) keeps it off the page;
--                                 a component may point at a service of the catalog.
--   status_post                   one announcement, written as a DRAFT and published by a PERSON. The same
--                                 N3 rule as incident_comm: `published_by` is required as soon as the post is
--                                 published and absent while it is a draft, so no code path (AI or system) can
--                                 leave a post public without a human who pressed the button. A post may point
--                                 at an incident, but only to say "this is about it": nothing of the incident
--                                 (title, commander, root cause, organizations) is copied or exposed.
--   status_post_component         the components a post is about.
--   status_maintenance            a scheduled maintenance window, draft then published by a person, same rule.
--   status_maintenance_component  the components a window touches.
--   status_subscription           an email subscription with double opt-in: `pending` until the owner of the
--                                 address confirms, `unsubscribed` is final until a new request. The two nonces
--                                 are part of the signed links (the link itself is never stored), so a new
--                                 request invalidates the old confirmation link.
--   status_notification           which subscriber was told about which post or window, once.
--
-- Clock: every timestamp the system decides with is the database clock (clock_timestamp()).

CREATE TABLE status_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  service_id uuid REFERENCES service (id) ON DELETE SET NULL,
  public boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'operational',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT status_component_slug_key UNIQUE (slug),
  CONSTRAINT status_component_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 64),
  CONSTRAINT status_component_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT status_component_description_check CHECK (description IS NULL OR length(description) <= 500),
  CONSTRAINT status_component_status_check CHECK (
    status IN ('operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance')
  )
);
CREATE INDEX status_component_public_idx ON status_component (position, name) WHERE public;

CREATE TABLE status_post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid REFERENCES incident (id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL,
  phase text NOT NULL DEFAULT 'investigating',
  impact text NOT NULL DEFAULT 'minor',
  state text NOT NULL DEFAULT 'draft',
  origin text NOT NULL,
  drafted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT status_post_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT status_post_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  CONSTRAINT status_post_phase_check CHECK (phase IN ('investigating', 'identified', 'monitoring', 'resolved')),
  CONSTRAINT status_post_impact_check CHECK (impact IN ('none', 'minor', 'major', 'critical')),
  CONSTRAINT status_post_state_check CHECK (state IN ('draft', 'published')),
  CONSTRAINT status_post_origin_check CHECK (origin IN ('human', 'ai')),
  -- N3: only a person publishes. A published post has the person who pressed the button and the
  -- time; a draft has neither.
  CONSTRAINT status_post_human_publishes CHECK (
    (state = 'published') = (published_by IS NOT NULL AND published_at IS NOT NULL)
    AND (state = 'published' OR (published_by IS NULL AND published_at IS NULL))
  )
);
CREATE INDEX status_post_public_idx ON status_post (published_at DESC) WHERE state = 'published';
CREATE INDEX status_post_list_idx ON status_post (created_at DESC, id DESC);
CREATE INDEX status_post_incident_idx ON status_post (incident_id) WHERE incident_id IS NOT NULL;

CREATE TABLE status_post_component (
  post_id uuid NOT NULL REFERENCES status_post (id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES status_component (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, component_id)
);
CREATE INDEX status_post_component_component_idx ON status_post_component (component_id);

CREATE TABLE status_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  origin text NOT NULL,
  drafted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT status_maintenance_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT status_maintenance_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  CONSTRAINT status_maintenance_window_check CHECK (ends_at > starts_at),
  CONSTRAINT status_maintenance_state_check CHECK (state IN ('draft', 'published', 'cancelled')),
  CONSTRAINT status_maintenance_origin_check CHECK (origin IN ('human', 'ai')),
  -- N3: a window is public only with the person who published it. A cancelled one may or may not have been.
  CONSTRAINT status_maintenance_human_publishes CHECK (
    state = 'cancelled'
    OR ((state = 'published') = (published_by IS NOT NULL AND published_at IS NOT NULL))
  ),
  CONSTRAINT status_maintenance_cancelled_check CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX status_maintenance_public_idx ON status_maintenance (starts_at DESC) WHERE state = 'published';

CREATE TABLE status_maintenance_component (
  maintenance_id uuid NOT NULL REFERENCES status_maintenance (id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES status_component (id) ON DELETE CASCADE,
  PRIMARY KEY (maintenance_id, component_id)
);
CREATE INDEX status_maintenance_component_component_idx ON status_maintenance_component (component_id);

CREATE TABLE status_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  state text NOT NULL DEFAULT 'pending',
  confirm_nonce text NOT NULL,
  unsubscribe_nonce text NOT NULL,
  confirm_expires_at timestamptz,
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT status_subscription_email_key UNIQUE (email),
  CONSTRAINT status_subscription_email_check CHECK (
    email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s]+@[^@\s]+$'
  ),
  CONSTRAINT status_subscription_locale_check CHECK (locale IN ('en', 'th')),
  CONSTRAINT status_subscription_state_check CHECK (state IN ('pending', 'confirmed', 'unsubscribed')),
  CONSTRAINT status_subscription_nonce_check CHECK (
    confirm_nonce ~ '^[0-9a-f]{16}$' AND unsubscribe_nonce ~ '^[0-9a-f]{16}$'
  ),
  CONSTRAINT status_subscription_confirmed_check CHECK (state <> 'confirmed' OR confirmed_at IS NOT NULL),
  CONSTRAINT status_subscription_unsubscribed_check CHECK (state <> 'unsubscribed' OR unsubscribed_at IS NOT NULL)
);
CREATE INDEX status_subscription_confirmed_idx ON status_subscription (id) WHERE state = 'confirmed';

CREATE TABLE status_notification (
  subscription_id uuid NOT NULL REFERENCES status_subscription (id) ON DELETE CASCADE,
  ref_kind text NOT NULL,
  ref_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subscription_id, ref_kind, ref_id),
  CONSTRAINT status_notification_kind_check CHECK (ref_kind IN ('post', 'maintenance'))
);
