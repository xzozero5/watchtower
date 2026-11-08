-- ADR-033 (T-434b): KB vectors multi-index and atomic index switching.
-- 1. Create kb_chunk_embedding table for multi-index vector persistence per chunk.
-- 2. Add finite and dimension checking trigger on kb_chunk_embedding.
-- 3. Create kb_version_chunk_manifest for chunk set completion tracking (supports empty articles).
-- 4. Add chunk_set_fingerprint to kb_chunk with safe backfill.
-- 5. Backfill existing vectors from kb_chunk into kb_chunk_embedding preserving chunk IDs.
-- Reversible: see 0119_kb_chunk_embeddings.down.sql.

CREATE TABLE kb_chunk_embedding (
  chunk_id uuid NOT NULL REFERENCES kb_chunk (id) ON DELETE CASCADE,
  index_id uuid NOT NULL REFERENCES kb_embedding_index (id) ON DELETE RESTRICT,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, index_id)
);
CREATE INDEX kb_chunk_embedding_index_idx ON kb_chunk_embedding (index_id);

CREATE FUNCTION kb_chunk_embedding_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected integer;
  str text;
BEGIN
  SELECT dimensions INTO expected FROM kb_embedding_index WHERE id = NEW.index_id;
  IF expected IS NULL OR vector_dims(NEW.embedding) <> expected THEN
    RAISE EXCEPTION 'kb_chunk_embedding has % dimensions, its index says %',
      vector_dims(NEW.embedding), coalesce(expected::text, 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;
  str := NEW.embedding::text;
  IF str ~* 'nan|infinity' THEN
    RAISE EXCEPTION 'kb_chunk_embedding must contain only finite numbers'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kb_chunk_embedding_check
  BEFORE INSERT OR UPDATE OF embedding, index_id ON kb_chunk_embedding
  FOR EACH ROW EXECUTE FUNCTION kb_chunk_embedding_check();

CREATE TABLE kb_version_chunk_manifest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES kb_article (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES kb_article_version (id) ON DELETE CASCADE,
  chunk_set_fingerprint text NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  completed_index_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_version_chunk_manifest_count_check CHECK (chunk_count >= 0)
);
CREATE UNIQUE INDEX kb_version_chunk_manifest_version_key ON kb_version_chunk_manifest (version_id, chunk_set_fingerprint);
CREATE INDEX kb_version_chunk_manifest_article_idx ON kb_version_chunk_manifest (article_id);

-- Add chunk_set_fingerprint to kb_chunk with backward-compatible default
ALTER TABLE kb_chunk ADD COLUMN chunk_set_fingerprint text NOT NULL DEFAULT '';

-- Deterministic backfill of chunk_set_fingerprint for existing rows
UPDATE kb_chunk c
   SET chunk_set_fingerprint = coalesce(
         (SELECT encode(sha256(convert_to('v1:' || v.content_hash, 'utf8')), 'hex')
            FROM kb_article_version v WHERE v.id = c.version_id),
         encode(sha256(convert_to(c.article_id::text || ':' || c.version_id::text, 'utf8')), 'hex')
       )
 WHERE c.chunk_set_fingerprint = '';

CREATE INDEX kb_chunk_fingerprint_idx ON kb_chunk (version_id, chunk_set_fingerprint);

-- Backfill manifests for existing chunks
INSERT INTO kb_version_chunk_manifest (article_id, version_id, chunk_set_fingerprint, chunk_count, completed_index_ids)
SELECT c.article_id,
       c.version_id,
       c.chunk_set_fingerprint,
       count(*)::integer AS chunk_count,
       coalesce(array_agg(DISTINCT c.embedding_index_id) FILTER (WHERE c.embedding_index_id IS NOT NULL), '{}') AS completed_index_ids
  FROM kb_chunk c
 GROUP BY c.article_id, c.version_id, c.chunk_set_fingerprint
ON CONFLICT (version_id, chunk_set_fingerprint) DO NOTHING;

-- Backfill existing vectors from kb_chunk into kb_chunk_embedding
INSERT INTO kb_chunk_embedding (chunk_id, index_id, embedding, created_at, updated_at)
SELECT id, embedding_index_id, embedding, created_at, created_at
  FROM kb_chunk
 WHERE embedding IS NOT NULL AND embedding_index_id IS NOT NULL
ON CONFLICT (chunk_id, index_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_chunk_embedding TO watchtower_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON kb_version_chunk_manifest TO watchtower_app;
