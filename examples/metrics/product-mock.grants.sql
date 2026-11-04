-- The logins the data tool uses on product_mock (T-203c, ADR-016). Two roles, both created by whoever
-- runs this (compose: product_mock_ro and product_mock_ro_reader; the tests: throwaway names):
--   __RO_ROLE__      LOGIN, NOINHERIT. The executor connects as it. It owns nothing and holds no right.
--   __READER_ROLE__  NOLOGIN. The executor does `SET LOCAL ROLE` to it for the one statement. It holds
--                    the column-level SELECT grants below and nothing else.
-- A role can always change its own session defaults, so the role that runs a person's statement is
-- not the login role. `__RO_ROLE__` must be a member of `__READER_ROLE__` (granted at the end).
--
-- This is the real barrier of the PII allow-list (R-5.2): the reader can read columns, not tables, and
-- the personal ones (display_name, contact_email, submitted_by) are left out, so no statement, however
-- it renames its columns, can return them. The allow-list in code is the second layer.

-- Nobody gets to make anything in this database by default: no temporary tables, nothing in `public`.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Functions. PUBLIC may execute every function by default, and a denylist of names keeps losing
-- (pg_advisory_lock held the whole cluster at 53200, pg_logical_emit_message wrote 196 MB of WAL in a
-- READ ONLY transaction). So the rule is by kind, not by name:
--   1. every VOLATILE function of pg_catalog loses EXECUTE for PUBLIC, except the few that only make a
--      value (random, gen_random_uuid, clock_timestamp, timeofday). Volatile is exactly "may have a side
--      effect or depend on more than its arguments": locks, sequences, WAL, notifications, settings,
--      sleeps, large objects, backend control, file reads.
--   2. whatever its volatility, a function of these families loses it too, in any schema: advisory
--      locks, logical decoding and replication, notify, file and directory reads, large objects,
--      transaction ids, WAL, dblink, backend control, sleeps, set_config.
-- Immutable and stable functions (operators, casts, aggregates, date, string, math, JSON) stay: a
-- statement needs them, and they cannot change anything. The reader, which runs the statement, and the
-- login are PUBLIC for this purpose; the executor needs none of the revoked ones (it uses SET LOCAL).
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p')
      AND n.nspname NOT IN ('information_schema')
      AND (
        (n.nspname = 'pg_catalog'
          AND p.provolatile = 'v'
          AND p.proname NOT IN ('random', 'random_normal', 'gen_random_uuid', 'clock_timestamp', 'timeofday'))
        OR p.proname ~ '^(pg_advisory|pg_logical|pg_replication|pg_notify|pg_read|pg_ls|pg_stat_file|pg_current_wal|pg_current_xact|pg_xact|pg_wal|pg_switch|pg_create|pg_drop|pg_promote|pg_reload|pg_rotate|pg_import|pg_export|pg_cancel|pg_terminate|pg_sleep|pg_log|txid_|lo_|dblink|set_config)'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature);
  END LOOP;
END
$$;

-- Functions outside pg_catalog (T-207a C-4): the block above only knew the system ones, and an extension or a
-- helper that lands in `public` (or any schema) is executable by PUBLIC by default. Everything the database
-- defines itself loses EXECUTE for PUBLIC in every schema but the two system ones (revoking those would stop
-- the operators and casts that every statement needs), and so does whatever the creating role adds later.
-- (ALTER DEFAULT PRIVILEGES covers objects created by the role that runs this file; another creating role
-- needs its own.) The reader has no function of its own to run, and none is granted to it below.
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg\_toast%'
      AND nspname NOT LIKE 'pg\_temp%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', s.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', s.nspname);
  END LOOP;
END
$$;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Limits that no statement can raise: the reader has no set_config, and these are set for the login
-- by whoever created it (a superuser; temp_file_limit is superuser-only). work_mem and the temporary
-- file cap bound what a sort or a hash can spill to disk; the executor adds a byte cap on what it reads.
ALTER ROLE __RO_ROLE__ SET work_mem = '16MB';
ALTER ROLE __RO_ROLE__ SET temp_file_limit = '64MB';
ALTER ROLE __RO_ROLE__ SET max_parallel_workers_per_gather = 0;


GRANT USAGE ON SCHEMA public TO __READER_ROLE__;
GRANT SELECT (id, plan, region, created_at) ON tenants TO __READER_ROLE__;
GRANT SELECT ON api_daily TO __READER_ROLE__;
GRANT SELECT (id, tenant_id, submitted_at, kind, status, duration_ms) ON jobs TO __READER_ROLE__;

-- The stand-in flow runs the starter usage metrics read (product_mock.sql, T-205a): ids, categories, times.
GRANT USAGE ON SCHEMA product_mock TO __READER_ROLE__;
GRANT SELECT (org_id, flow, step, status, started_at, latency_ms) ON product_mock.flow_run TO __READER_ROLE__;

-- Read-only by default and short timeouts as a floor under the per-call limits (the executor also
-- passes them at connection start).
ALTER ROLE __RO_ROLE__ NOINHERIT;
ALTER ROLE __RO_ROLE__ SET default_transaction_read_only = on;
ALTER ROLE __RO_ROLE__ SET statement_timeout = '15s';
ALTER ROLE __RO_ROLE__ SET idle_in_transaction_session_timeout = '30s';

GRANT __READER_ROLE__ TO __RO_ROLE__;
