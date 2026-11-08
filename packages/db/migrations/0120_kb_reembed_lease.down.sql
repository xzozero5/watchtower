-- Reverts 0120_kb_reembed_lease.sql.

REVOKE ALL ON kb_reembed_lease FROM watchtower_app;
DROP TABLE IF EXISTS kb_reembed_lease;
