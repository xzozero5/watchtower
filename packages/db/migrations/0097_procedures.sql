-- T-303b (ADR-026, PRD 6.3-6.5): a procedure per intent, written as natural language by a lead or a
-- head, compiled into steps (the AI drafts, a person confirms), versioned, simulated, then published.
--   procedure             one per intent. Nothing is ever deleted (the application role has no DELETE).
--   procedure_version     draft -> confirmed -> simulated -> published -> retired.
--                           * Only a draft can change its text or its steps. After that a trigger refuses
--                             any change to source_md, steps, schema_version, steps_hash and the AI run
--                             that compiled it, for everybody, the owner included.
--                           * version and steps_hash are computed by the database (a client cannot lie
--                             about either): steps_hash is the SHA-256 of the canonical jsonb text.
--                           * Reaching `published` or `retired` needs columns the application role cannot
--                             write (published_by/at, retired_at/by, simulation_id) and CHECKs that demand
--                             them, so the only way is publish_procedure_version() /
--                             retire_procedure_version() below (SECURITY DEFINER, search_path pinned).
--                           * At most one published version per procedure (partial unique index).
--   procedure_simulation  append-only result of replaying a version over old tickets (T-303d writes the
--                         rows; this migration only makes them the gate). Inserting one moves a
--                         confirmed version to `simulated` (passed) or keeps it `confirmed` (failed).
--   publish_procedure_version(version, actor): needs status `simulated` (or `retired` for a rollback to a
--                         version that was published before) AND a latest simulation that passed, is for
--                         the same steps_hash and is at most 30 days old [ASSUMED]. For an intent at
--                         stage 3 or more [ASSUMED] the publisher must not be the person who confirmed,
--                         and a simulation that used seeded tickets does not count. It retires the
--                         version that is published now and sets intent.procedure_version_id.
--                         Raises WT110 wrong status, WT111 no passing simulation, WT112 simulation too
--                         old, WT113 same person at stage 3+, WT114 seeded simulation at stage 3+,
--                         WT115 procedure archived, P0002 no such version, 23514 no actor.
--   retire_procedure_version(version, actor): published -> retired (the intent falls back to the default
--                         runbook), or throw away a draft/confirmed/simulated version. WT110 if retired.
--   intent.procedure_version_id gets its foreign key, and the application role loses UPDATE on that
--   column: the only writers are the two functions. ai_run gets procedure_version_id (written by
--   T-303c). eval_result does not exist yet; it gets its own column when the table is created.
--   Permissions procedure.read (agent, lead, head, dev), procedure.author and procedure.publish
--   (lead, head) [ASSUMED]; packages/shared/src/rbac.ts holds the same data.
-- Reversible: see 0097_procedures.down.sql.

CREATE TABLE procedure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES intent (id) ON DELETE RESTRICT,
  -- No foreign key on the people columns of this file, like audit_log.actor_id: the row must outlive the
  -- user, and an ON DELETE SET NULL would be an UPDATE that the immutability trigger refuses.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT procedure_intent_key UNIQUE (intent_id)
);

CREATE TABLE procedure_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_id uuid NOT NULL REFERENCES procedure (id) ON DELETE RESTRICT,
  -- Assigned by the trigger (max + 1 under a lock on the procedure); the value given is ignored.
  version integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  source_md text NOT NULL DEFAULT '',
  steps jsonb NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1,
  -- Computed by the trigger from `steps`.
  steps_hash text NOT NULL DEFAULT repeat('0', 64),
  -- The ai_run row of the compile call (ai_run is partitioned, so this is a plain id, not a foreign key).
  compiled_by_ai_run_id uuid,
  authored_by uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  simulation_id uuid,
  published_by uuid,
  published_at timestamptz,
  retired_by uuid,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT procedure_version_number_key UNIQUE (procedure_id, version),
  CONSTRAINT procedure_version_status_check CHECK (status IN ('draft', 'confirmed', 'simulated', 'published', 'retired')),
  CONSTRAINT procedure_version_version_check CHECK (version >= 1),
  CONSTRAINT procedure_version_schema_check CHECK (schema_version = 1),
  CONSTRAINT procedure_version_source_check CHECK (octet_length(source_md) <= 8192),
  CONSTRAINT procedure_version_steps_check CHECK (jsonb_typeof(steps) = 'object' AND octet_length(steps::text) <= 65536),
  CONSTRAINT procedure_version_hash_check CHECK (steps_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT procedure_version_confirmed_check CHECK (
    status NOT IN ('confirmed', 'simulated', 'published') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT procedure_version_simulated_check CHECK (status NOT IN ('simulated', 'published') OR simulation_id IS NOT NULL),
  CONSTRAINT procedure_version_published_check CHECK (
    status <> 'published' OR (published_by IS NOT NULL AND published_at IS NOT NULL AND retired_at IS NULL)
  ),
  CONSTRAINT procedure_version_retired_check CHECK (status <> 'retired' OR (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE UNIQUE INDEX procedure_version_one_published ON procedure_version (procedure_id) WHERE status = 'published';

CREATE TABLE procedure_simulation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_version_id uuid NOT NULL REFERENCES procedure_version (id) ON DELETE RESTRICT,
  -- Copied from the version by the trigger: a simulation always says which steps it ran.
  steps_hash text NOT NULL DEFAULT repeat('0', 64),
  passed boolean NOT NULL,
  -- True when seeded (demo) tickets were part of the data set: not enough for an intent at stage 3.
  seed_only boolean NOT NULL DEFAULT false,
  case_count integer NOT NULL DEFAULT 0,
  -- Numbers and codes only (violations, leaks, edit distance, per-step status); never ticket text.
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  ran_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT procedure_simulation_hash_check CHECK (steps_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT procedure_simulation_count_check CHECK (case_count >= 0 AND (NOT passed OR case_count > 0)),
  CONSTRAINT procedure_simulation_metrics_check CHECK (jsonb_typeof(metrics) = 'object')
);
CREATE INDEX procedure_simulation_version_idx ON procedure_simulation (procedure_version_id, created_at DESC);

ALTER TABLE procedure_version
  ADD CONSTRAINT procedure_version_simulation_fk FOREIGN KEY (simulation_id) REFERENCES procedure_simulation (id) ON DELETE RESTRICT;

-- The version number, the hash and the rules of what may change. Invoker rights; names are qualified.
CREATE FUNCTION public.procedure_version_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  archived timestamptz;
  next_version integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a procedure version starts as a draft' USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT p.archived_at INTO archived FROM public.procedure AS p WHERE p.id = NEW.procedure_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such procedure' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF archived IS NOT NULL THEN
      RAISE EXCEPTION 'the procedure is archived' USING ERRCODE = 'WT115';
    END IF;
    SELECT COALESCE(max(v.version), 0) + 1 INTO next_version
      FROM public.procedure_version AS v WHERE v.procedure_id = NEW.procedure_id;
    NEW.version := next_version;
    NEW.steps_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.steps::text, 'UTF8')), 'hex');
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id <> OLD.id OR NEW.procedure_id <> OLD.procedure_id OR NEW.version <> OLD.version
     OR NEW.authored_by IS DISTINCT FROM OLD.authored_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identity of a procedure version cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.source_md <> OLD.source_md OR NEW.steps <> OLD.steps OR NEW.schema_version <> OLD.schema_version
       OR NEW.steps_hash <> OLD.steps_hash
       OR NEW.compiled_by_ai_run_id IS DISTINCT FROM OLD.compiled_by_ai_run_id
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
      RAISE EXCEPTION 'a procedure version cannot be changed after it left draft: write a new version'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    NEW.steps_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.steps::text, 'UTF8')), 'hex');
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('confirmed', 'retired'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('simulated', 'retired'))
    OR (OLD.status = 'simulated' AND NEW.status IN ('confirmed', 'published', 'retired'))
    OR (OLD.status = 'published' AND NEW.status = 'retired')
    OR (OLD.status = 'retired' AND NEW.status = 'published' AND OLD.published_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'a procedure version cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER procedure_version_guard
  BEFORE INSERT OR UPDATE ON procedure_version
  FOR EACH ROW EXECUTE FUNCTION public.procedure_version_guard();

CREATE FUNCTION public.procedure_version_reject_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'a procedure version that left draft cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER procedure_version_reject_delete
  BEFORE DELETE ON procedure_version
  FOR EACH ROW EXECUTE FUNCTION public.procedure_version_reject_delete();

-- Simulation rows: bound to the hash of the version they ran, only for a version that was confirmed.
CREATE FUNCTION public.procedure_simulation_bind() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
  v_hash text;
BEGIN
  SELECT v.status, v.steps_hash INTO v_status, v_hash
    FROM public.procedure_version AS v WHERE v.id = NEW.procedure_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such procedure version' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'a draft version cannot be simulated: confirm it first' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.steps_hash := v_hash;
  RETURN NEW;
END
$$;
CREATE TRIGGER procedure_simulation_bind
  BEFORE INSERT ON procedure_simulation
  FOR EACH ROW EXECUTE FUNCTION public.procedure_simulation_bind();

-- A new simulation moves a confirmed/simulated version: passed -> simulated, failed -> confirmed. The
-- application role cannot write simulation_id, so this runs with the owner's rights.
CREATE FUNCTION public.procedure_simulation_apply() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.procedure_version AS v
     SET simulation_id = NEW.id,
         status = CASE WHEN NEW.passed THEN 'simulated' ELSE 'confirmed' END
   WHERE v.id = NEW.procedure_version_id AND v.status IN ('confirmed', 'simulated');
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.procedure_simulation_apply() FROM PUBLIC;
CREATE TRIGGER procedure_simulation_apply
  AFTER INSERT ON procedure_simulation
  FOR EACH ROW EXECUTE FUNCTION public.procedure_simulation_apply();

CREATE TRIGGER procedure_simulation_reject_update_delete
  BEFORE UPDATE OR DELETE ON procedure_simulation
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER procedure_simulation_reject_truncate
  BEFORE TRUNCATE ON procedure_simulation
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Privileges. The application role reads and inserts; it writes only the draft's own columns.
REVOKE DELETE, TRUNCATE ON procedure, procedure_version FROM watchtower_app, PUBLIC;
REVOKE UPDATE ON procedure, procedure_version FROM watchtower_app, PUBLIC;
GRANT UPDATE (archived_at) ON procedure TO watchtower_app;
GRANT UPDATE (source_md, steps, compiled_by_ai_run_id, status, confirmed_by, confirmed_at)
  ON procedure_version TO watchtower_app;
REVOKE UPDATE, DELETE, TRUNCATE ON procedure_simulation FROM watchtower_app, PUBLIC;

-- The intent points at its published version, and only the functions below may move the pointer.
ALTER TABLE intent
  ADD CONSTRAINT intent_procedure_version_fk FOREIGN KEY (procedure_version_id) REFERENCES procedure_version (id) ON DELETE RESTRICT;
CREATE INDEX intent_procedure_version_idx ON intent (procedure_version_id) WHERE procedure_version_id IS NOT NULL;
REVOKE UPDATE (procedure_version_id) ON intent FROM watchtower_app, PUBLIC;

-- Which procedure version shaped an AI run (T-303c fills it). Nullable: most runs have none.
ALTER TABLE ai_run ADD COLUMN procedure_version_id uuid REFERENCES procedure_version (id) ON DELETE RESTRICT;
CREATE INDEX ai_run_procedure_version_idx ON ai_run (procedure_version_id, created_at DESC) WHERE procedure_version_id IS NOT NULL;

CREATE FUNCTION public.publish_procedure_version(p_version_id uuid, p_actor uuid) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v public.procedure_version%ROWTYPE;
  proc public.procedure%ROWTYPE;
  it public.intent%ROWTYPE;
  sim public.procedure_simulation%ROWTYPE;
  previous uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = 'check_violation';
  END IF;
  -- Lock order: procedure, intent, version (the insert trigger locks the procedure first too).
  SELECT x.procedure_id INTO proc.id FROM public.procedure_version AS x WHERE x.id = p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such procedure version' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO proc FROM public.procedure AS p WHERE p.id = proc.id FOR UPDATE;
  SELECT * INTO it FROM public.intent AS i WHERE i.id = proc.intent_id FOR UPDATE;
  SELECT * INTO v FROM public.procedure_version AS x WHERE x.id = p_version_id FOR UPDATE;
  IF proc.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'the procedure is archived' USING ERRCODE = 'WT115';
  END IF;
  IF NOT (v.status = 'simulated' OR (v.status = 'retired' AND v.published_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'a version in status % cannot be published', v.status USING ERRCODE = 'WT110';
  END IF;

  SELECT * INTO sim FROM public.procedure_simulation AS s
   WHERE s.procedure_version_id = v.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
  IF NOT FOUND OR NOT sim.passed OR sim.steps_hash <> v.steps_hash THEN
    RAISE EXCEPTION 'no passing simulation for these steps' USING ERRCODE = 'WT111';
  END IF;
  IF sim.created_at < pg_catalog.clock_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION 'the simulation is older than 30 days: run it again' USING ERRCODE = 'WT112';
  END IF;
  IF it.autonomy_stage >= 3 THEN
    IF v.confirmed_by = p_actor THEN
      RAISE EXCEPTION 'at stage 3 the person who publishes must not be the person who confirmed' USING ERRCODE = 'WT113';
    END IF;
    IF sim.seed_only THEN
      RAISE EXCEPTION 'at stage 3 a simulation on seeded tickets does not count' USING ERRCODE = 'WT114';
    END IF;
  END IF;

  SELECT x.id INTO previous FROM public.procedure_version AS x
   WHERE x.procedure_id = v.procedure_id AND x.status = 'published' AND x.id <> v.id FOR UPDATE;
  IF previous IS NOT NULL THEN
    UPDATE public.procedure_version
       SET status = 'retired', retired_at = pg_catalog.clock_timestamp(), retired_by = p_actor
     WHERE id = previous;
  END IF;
  UPDATE public.procedure_version
     SET status = 'published', published_by = p_actor, published_at = pg_catalog.clock_timestamp(),
         retired_at = NULL, retired_by = NULL, simulation_id = sim.id
   WHERE id = v.id;
  UPDATE public.intent SET procedure_version_id = v.id, updated_at = pg_catalog.now() WHERE id = it.id;
  RETURN previous;
END
$$;
REVOKE ALL ON FUNCTION public.publish_procedure_version(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_procedure_version(uuid, uuid) TO watchtower_app;

CREATE FUNCTION public.retire_procedure_version(p_version_id uuid, p_actor uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v public.procedure_version%ROWTYPE;
  proc_id uuid;
  intent_id uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.procedure_id INTO proc_id FROM public.procedure_version AS x WHERE x.id = p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such procedure version' USING ERRCODE = 'P0002';
  END IF;
  SELECT p.intent_id INTO intent_id FROM public.procedure AS p WHERE p.id = proc_id FOR UPDATE;
  PERFORM 1 FROM public.intent AS i WHERE i.id = intent_id FOR UPDATE;
  SELECT * INTO v FROM public.procedure_version AS x WHERE x.id = p_version_id FOR UPDATE;
  IF v.status = 'retired' THEN
    RAISE EXCEPTION 'the version is already retired' USING ERRCODE = 'WT110';
  END IF;
  UPDATE public.procedure_version
     SET status = 'retired', retired_at = pg_catalog.clock_timestamp(), retired_by = p_actor
   WHERE id = v.id;
  IF v.status = 'published' THEN
    UPDATE public.intent SET procedure_version_id = NULL, updated_at = pg_catalog.now()
     WHERE id = intent_id AND procedure_version_id = v.id;
  END IF;
  RETURN v.status = 'published';
END
$$;
REVOKE ALL ON FUNCTION public.retire_procedure_version(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retire_procedure_version(uuid, uuid) TO watchtower_app;

INSERT INTO permissions (key, description) VALUES
  ('procedure.read', 'Read the procedure of an intent and its versions'),
  ('procedure.author', 'Write, compile and confirm the procedure of an intent'),
  ('procedure.publish', 'Publish or retire a procedure version');
INSERT INTO role_permissions (role, permission) VALUES
  ('agent', 'procedure.read'),
  ('dev', 'procedure.read'),
  ('lead', 'procedure.read'),
  ('lead', 'procedure.author'),
  ('lead', 'procedure.publish'),
  ('head', 'procedure.read'),
  ('head', 'procedure.author'),
  ('head', 'procedure.publish');
