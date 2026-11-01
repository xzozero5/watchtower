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

-- The functions a statement could use to loosen its own limits or to hold a connection (a lead's
-- statement runs as the reader, which has no EXECUTE on them). The executor itself needs none: it
-- sets its limits with SET LOCAL.
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_until(timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_cancel_backend(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_terminate_backend(integer, bigint) FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO __READER_ROLE__;
GRANT SELECT (id, plan, region, created_at) ON tenants TO __READER_ROLE__;
GRANT SELECT ON api_daily TO __READER_ROLE__;
GRANT SELECT (id, tenant_id, submitted_at, kind, status, duration_ms) ON jobs TO __READER_ROLE__;

-- Read-only by default and short timeouts as a floor under the per-call limits (the executor also
-- passes them at connection start).
ALTER ROLE __RO_ROLE__ NOINHERIT;
ALTER ROLE __RO_ROLE__ SET default_transaction_read_only = on;
ALTER ROLE __RO_ROLE__ SET statement_timeout = '15s';
ALTER ROLE __RO_ROLE__ SET idle_in_transaction_session_timeout = '30s';

GRANT __READER_ROLE__ TO __RO_ROLE__;
