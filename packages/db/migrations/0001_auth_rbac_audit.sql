-- T-004: users, RBAC (permission table + seed), sessions, magic links and the audit log.
-- Hand-written SQL: drizzle-kit cannot declare PARTITION BY, triggers or privileges (see
-- docs/04-ARCHITECTURE.md section 7). Schema/audit TypeScript in src/schema mirrors these tables.
--
-- Privileges: the application connects as a member of the group role `watchtower_app` (login
-- roles are provisioned by `cli.js provision-app-role`). The owner running migrations keeps full
-- rights. `watchtower_app` can SELECT/INSERT/UPDATE/DELETE every table created from here on, except
-- the append-only audit log, where UPDATE, DELETE and TRUNCATE are revoked (and a trigger rejects
-- them for everyone, including the owner).

-- 1. Application role (cluster-wide, so created only when missing). Retried because two databases
--    migrating at once can race on the shared catalog.
DO $$
DECLARE
  attempt integer := 0;
BEGIN
  LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'watchtower_app');
    attempt := attempt + 1;
    BEGIN
      CREATE ROLE watchtower_app NOLOGIN;
    EXCEPTION WHEN OTHERS THEN
      IF attempt >= 5 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO watchtower_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO watchtower_app;

-- 2. Users. Staff and clients share the table; a client belongs to exactly one organization.
--    org_id has no foreign key yet: the organization table arrives with T-005, which adds it.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  -- Extra permission strings on top of the role's (for service identities). Unknown strings are ignored.
  permissions text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  org_id uuid,
  shift_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  discord_user_id text,
  google_sub text,
  -- argon2id PHC string; only the break-glass admin has one.
  password_hash text,
  is_break_glass boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('agent', 'lead', 'head', 'client', 'system')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  CONSTRAINT users_client_org CHECK ((role = 'client') = (org_id IS NOT NULL)),
  CONSTRAINT users_break_glass_head CHECK (NOT is_break_glass OR (role = 'head' AND password_hash IS NOT NULL)),
  CONSTRAINT users_password_only_break_glass CHECK (password_hash IS NULL OR is_break_glass)
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_google_sub_key ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX users_org_idx ON users (org_id) WHERE org_id IS NOT NULL;

-- 3. RBAC: permission strings and which role has which. Edited through the API, no deploy needed.
CREATE TABLE permissions (
  key text PRIMARY KEY,
  description text NOT NULL
);
CREATE TABLE role_permissions (
  role text NOT NULL,
  permission text NOT NULL REFERENCES permissions (key) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (role, permission),
  CONSTRAINT role_permissions_role_check CHECK (role IN ('agent', 'lead', 'head', 'client', 'system'))
);

-- 4. Sessions and rotating refresh tokens. Only SHA-256 hashes of tokens are stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  auth_method text NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  -- Absolute lifetime: refresh cannot extend a session past this.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('google', 'dev', 'magic_link', 'break_glass'))
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set when the token is exchanged. Presenting a used token again is a replay: the session dies.
  used_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

-- 5. Client magic links: single use, short lived, stored as a hash.
CREATE TABLE magic_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_ip text
);
CREATE UNIQUE INDEX magic_link_tokens_hash_key ON magic_link_tokens (token_hash);
CREATE INDEX magic_link_tokens_user_open_idx ON magic_link_tokens (user_id) WHERE consumed_at IS NULL;

-- 6. Append-only guard, reused by every immutable table (ticket_event in T-005, for example).
CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- 7. Audit log (PRD section 8.2): partitioned by month, immutable.
CREATE TABLE audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  outcome text NOT NULL DEFAULT 'success',
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  ip text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A partitioned table's primary key must contain the partition key.
  PRIMARY KEY (id, created_at),
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user', 'system', 'ai', 'anonymous')),
  CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('success', 'failure', 'denied'))
) PARTITION BY RANGE (created_at);

CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

-- Row triggers on the parent are cloned to every partition, including ones created later.
CREATE TRIGGER audit_log_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
-- Statement triggers are not cloned: each partition gets its own (see ensure_monthly_partitions).
CREATE TRIGGER audit_log_reject_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE TRIGGER audit_log_default_reject_truncate
  BEFORE TRUNCATE ON audit_log_default
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, audit_log_default FROM watchtower_app, PUBLIC;

-- 8. Monthly partitions (UTC month boundaries). SECURITY DEFINER because creating a partition
--    needs ownership of the parent, which the application role does not have. It only accepts a
--    partitioned table in schema public. Retention: detach and archive a partition once it is
--    older than the retention period; never DELETE.
CREATE FUNCTION ensure_monthly_partitions(
  parent regclass,
  months_ahead integer DEFAULT 3,
  append_only boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent_name text;
  month_start date;
  month_end date;
  part_name text;
  created integer := 0;
  i integer;
BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 36';
  END IF;
  SELECT c.relname INTO parent_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = parent AND c.relkind = 'p' AND n.nspname = 'public';
  IF parent_name IS NULL THEN
    RAISE EXCEPTION '% is not a partitioned table in schema public', parent;
  END IF;

  FOR i IN 0..months_ahead LOOP
    month_start := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i))::date;
    month_end := (month_start + make_interval(months => 1))::date;
    part_name := parent_name || '_p' || to_char(month_start, 'YYYYMM');
    IF to_regclass(format('public.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent_name,
        month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00'
      );
      IF append_only THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM watchtower_app, PUBLIC', part_name);
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()',
          part_name || '_reject_truncate', part_name
        );
      END IF;
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION ensure_monthly_partitions(regclass, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_monthly_partitions(regclass, integer, boolean) TO watchtower_app;

SELECT ensure_monthly_partitions('audit_log', 12, true);

-- 9. Seed: permission strings and the default role matrix (PRD section 2.2, [ASSUMED]).
--    packages/shared/src/rbac.ts holds the same data; an integration test keeps them equal.
INSERT INTO permissions (key, description) VALUES
  ('ticket.read', 'View all tickets'),
  ('ticket.handle', 'Handle tickets: assign, change status, add internal notes'),
  ('ticket.reply', 'Reply to a customer on any channel'),
  ('ticket.create', 'Create a ticket'),
  ('ticket.read.org', 'View the tickets of the caller own organization (client)'),
  ('ticket.reply.own', 'Reply on a ticket of the caller own organization (client)'),
  ('ai.draft.review', 'Approve, edit or reject AI drafts'),
  ('ai.autonomy.set', 'Change AI autonomy stage per intent, up to stage 3'),
  ('ai.autonomy.set.any', 'Change AI autonomy stage per intent to any stage'),
  ('investigate.run', 'Run read-only investigation tools'),
  ('incident.create', 'Create an incident'),
  ('incident.manage', 'Close incidents and publish status page posts'),
  ('statuspage.subscribe', 'Subscribe to the status page'),
  ('shift.clock', 'Clock in and out of a shift'),
  ('handoff.write', 'Write a shift handoff'),
  ('roster.manage', 'Manage the roster and shift swaps'),
  ('performance.read.own', 'View own performance'),
  ('performance.read.all', 'View per-agent performance'),
  ('kb.read', 'Read knowledge base articles'),
  ('kb.write', 'Write knowledge base drafts'),
  ('kb.approve', 'Approve knowledge base articles'),
  ('integration.manage', 'Manage integrations'),
  ('ai.provider.manage', 'Manage the AI provider and model settings'),
  ('apikey.manage', 'Manage API keys'),
  ('org.manage', 'Manage organizations and contacts'),
  ('sla.manage', 'Manage SLA policies'),
  ('user.read', 'List users'),
  ('user.manage', 'Create users and change their role or status'),
  ('client.invite', 'Invite client users to an organization'),
  ('audit.read', 'View the audit log'),
  ('ceo.view', 'CEO view and exports'),
  ('pii.export', 'Export personal data'),
  ('rbac.manage', 'Change which permissions each role has'),
  ('session.revoke.any', 'Force logout of any user'),
  ('auth.session.self', 'View and revoke the caller own sessions');

INSERT INTO role_permissions (role, permission) VALUES
  ('agent', 'ticket.read'),
  ('agent', 'ticket.handle'),
  ('agent', 'ticket.reply'),
  ('agent', 'ticket.create'),
  ('agent', 'ai.draft.review'),
  ('agent', 'investigate.run'),
  ('agent', 'incident.create'),
  ('agent', 'shift.clock'),
  ('agent', 'handoff.write'),
  ('agent', 'performance.read.own'),
  ('agent', 'kb.read'),
  ('agent', 'kb.write'),
  ('agent', 'auth.session.self'),
  ('lead', 'ticket.read'),
  ('lead', 'ticket.handle'),
  ('lead', 'ticket.reply'),
  ('lead', 'ticket.create'),
  ('lead', 'ai.draft.review'),
  ('lead', 'investigate.run'),
  ('lead', 'incident.create'),
  ('lead', 'shift.clock'),
  ('lead', 'handoff.write'),
  ('lead', 'performance.read.own'),
  ('lead', 'kb.read'),
  ('lead', 'kb.write'),
  ('lead', 'auth.session.self'),
  ('lead', 'ai.autonomy.set'),
  ('lead', 'incident.manage'),
  ('lead', 'roster.manage'),
  ('lead', 'performance.read.all'),
  ('lead', 'kb.approve'),
  ('lead', 'org.manage'),
  ('lead', 'client.invite'),
  ('lead', 'user.read'),
  ('lead', 'ceo.view'),
  ('head', 'ticket.read'),
  ('head', 'ticket.handle'),
  ('head', 'ticket.reply'),
  ('head', 'ticket.create'),
  ('head', 'ai.draft.review'),
  ('head', 'investigate.run'),
  ('head', 'incident.create'),
  ('head', 'shift.clock'),
  ('head', 'handoff.write'),
  ('head', 'performance.read.own'),
  ('head', 'kb.read'),
  ('head', 'kb.write'),
  ('head', 'auth.session.self'),
  ('head', 'ai.autonomy.set'),
  ('head', 'incident.manage'),
  ('head', 'roster.manage'),
  ('head', 'performance.read.all'),
  ('head', 'kb.approve'),
  ('head', 'org.manage'),
  ('head', 'client.invite'),
  ('head', 'user.read'),
  ('head', 'ceo.view'),
  ('head', 'ai.autonomy.set.any'),
  ('head', 'integration.manage'),
  ('head', 'ai.provider.manage'),
  ('head', 'apikey.manage'),
  ('head', 'sla.manage'),
  ('head', 'user.manage'),
  ('head', 'audit.read'),
  ('head', 'pii.export'),
  ('head', 'rbac.manage'),
  ('head', 'session.revoke.any'),
  ('client', 'ticket.read.org'),
  ('client', 'ticket.create'),
  ('client', 'ticket.reply.own'),
  ('client', 'statuspage.subscribe'),
  ('client', 'auth.session.self');
