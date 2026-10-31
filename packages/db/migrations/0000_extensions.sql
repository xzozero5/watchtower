-- Extensions the data model relies on (PRD section 7): pgvector for embeddings, pg_trgm for Thai
-- full-text search (docs/04-ARCHITECTURE.md section 7).
-- Needs a role allowed to create extensions (the compose postgres user, or cloudsqlsuperuser).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
