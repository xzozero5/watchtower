-- Reverts 0000_extensions. Fails (by design, no CASCADE) while a column still uses vector or a
-- trigram index still exists: roll those migrations back first.
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS vector;
