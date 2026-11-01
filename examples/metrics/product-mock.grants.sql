-- The login the data tool uses on product_mock (T-203c). `__RO_ROLE__` is replaced by the role name
-- (compose: product_mock_ro; the tests: a throwaway name). The role is created by whoever runs this.
--
-- This is the real barrier of the PII allow-list (R-5.2): the role can read columns, not tables, and
-- the personal ones (display_name, contact_email, submitted_by) are left out, so no statement, however
-- it renames its columns, can return them. The allow-list in code is the second layer.

GRANT USAGE ON SCHEMA public TO __RO_ROLE__;
GRANT SELECT (id, plan, region, created_at) ON tenants TO __RO_ROLE__;
GRANT SELECT ON api_daily TO __RO_ROLE__;
GRANT SELECT (id, tenant_id, submitted_at, kind, status, duration_ms) ON jobs TO __RO_ROLE__;

-- Read-only by default for every session of the role, with a short statement time as a floor under
-- the per-call limit the client sets.
ALTER ROLE __RO_ROLE__ SET default_transaction_read_only = on;
ALTER ROLE __RO_ROLE__ SET statement_timeout = '15s';
ALTER ROLE __RO_ROLE__ SET idle_in_transaction_session_timeout = '30s';
