-- ADR-033 §5 (T-434c): KB re-embed durable lease, fencing and deduplication.
-- Reversible: see 0120_kb_reembed_lease.down.sql.

CREATE TABLE kb_reembed_lease (
  id text PRIMARY KEY,
  lease_token uuid NOT NULL,
  target_index_id uuid NOT NULL REFERENCES kb_embedding_index (id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  leased_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_until timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_reembed_lease TO watchtower_app;
