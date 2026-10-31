-- Reverts 0001. Dropping audit_log drops its partitions and triggers with it: this is the one way
-- to remove audit data, and it is a deliberate owner action on a development database.
-- The group role watchtower_app is cluster-wide and may serve other databases, so it is kept.
DROP FUNCTION IF EXISTS ensure_monthly_partitions(regclass, integer, boolean);
DROP TABLE IF EXISTS audit_log CASCADE;
DROP FUNCTION IF EXISTS reject_mutation();
DROP TABLE IF EXISTS magic_link_tokens;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS users;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM watchtower_app;
