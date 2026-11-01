-- Reverts 0013. Lossy on purpose: every article, every version, the chunks and the embedding
-- index registry go away (the version history is immutable while the migration is applied, so the
-- only way to remove it is this rollback). role_permissions rows go with the permission.
DELETE FROM permissions WHERE key IN ('kb.read.customer', 'kb.publish.break_glass');

DROP TABLE IF EXISTS kb_chunk;
DROP FUNCTION IF EXISTS kb_chunk_check_embedding();
DROP TABLE IF EXISTS kb_article_org;
-- The article and version tables reference each other, so they go in one statement. The reject
-- trigger on versions is dropped with the table (DROP TABLE is not a row mutation).
DROP TABLE IF EXISTS kb_article, kb_article_version;
DROP TABLE IF EXISTS kb_embedding_index;
