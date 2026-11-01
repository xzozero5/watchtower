-- T-107a: the knowledge base (PRD R-4.1, R-4.2, section 7 data model).
--   kb_embedding_index: which model produced a set of vectors (provider, model id, dimensions).
--     Exactly one index is active; search embeds the query with it and only compares vectors of
--     the same index. Changing the embedding model means a new row, activating it, and re-embedding
--     the chunks (their embedding and embedding_index_id are replaced in place). Until a chunk is
--     re-embedded it is still found by keyword search.
--   kb_article: identity, visibility, status and two pointers into the versions: current_version_id
--     (the latest edit) and published_version_id (what search and customers see). Editing a
--     published article never changes what is live until a person with kb.approve publishes.
--   kb_article_version: one row per edit, immutable (append-only, like ticket_event and ai_run):
--     the application role has no UPDATE or DELETE and a trigger rejects them for everyone.
--     created_by has no foreign key on purpose, so removing a user can never touch history.
--   kb_article_org: the organizations that may see an article whose visibility is 'orgs'.
--   kb_chunk: a section-sized slice of one version with its embedding. Derived data: the worker
--     rebuilds it when a version is published, so it is not versioned history. `embedding` has no
--     fixed dimension (models differ); a trigger checks it against the dimensions of its index.
--     No ANN index yet [ASSUMED]: an exact scan filtered by visibility is fast enough for the
--     expected corpus (thousands of chunks) and keeps the visibility filter exact. Add an HNSW
--     index per active model (expression index on embedding::vector(N)) when the corpus grows.
--   Keyword search uses pg_trgm (word_similarity) on kb_chunk.text; it works on Thai because it
--     needs no word boundaries.
--   kb.read.customer: new permission, granted to the client role only: customer-facing search.
--   kb.publish.break_glass: granted to the head only: publish without a second person (the
--     break-glass columns of kb_article record it until another approver reviews it).
-- Articles are never deleted (deprecate instead): the application role has no DELETE on them.
-- Reversible: see 0015_kb.down.sql.

CREATE TABLE kb_embedding_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  -- Opaque model id from admin settings (mock-embedding for the offline mock).
  model text NOT NULL,
  dimensions integer NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT kb_embedding_index_provider_check CHECK (provider IN ('mock', 'anthropic', 'vertex')),
  CONSTRAINT kb_embedding_index_model_check CHECK (length(model) BETWEEN 1 AND 200),
  -- pgvector stores up to 16000 dimensions in a vector column.
  CONSTRAINT kb_embedding_index_dimensions_check CHECK (dimensions BETWEEN 1 AND 16000)
);
CREATE UNIQUE INDEX kb_embedding_index_model_key ON kb_embedding_index (provider, model, dimensions);
-- At most one active index.
CREATE UNIQUE INDEX kb_embedding_index_active_key ON kb_embedding_index (is_active) WHERE is_active;

CREATE TABLE kb_article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  -- article | runbook (R-4.7: a runbook is an article type).
  kind text NOT NULL DEFAULT 'article',
  lang text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- internal: staff only. customer: every client. orgs: only the organizations in kb_article_org.
  visibility text NOT NULL DEFAULT 'internal',
  intent_tags text[] NOT NULL DEFAULT '{}',
  author_id uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewer_id uuid REFERENCES users (id) ON DELETE SET NULL,
  last_verified_at timestamptz,
  -- [{type: 'ticket'|'incident'|'commit'|'runbook'|'url', ref: text}] (R-4.1 linked sources).
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_version_id uuid NOT NULL,
  published_version_id uuid,
  published_at timestamptz,
  -- The version an author sent for review while the article is live (status stays 'published', so
  -- search keeps the live text). A normal publication of a newer version needs this to be that
  -- version; an edit after it makes it stale. Draft articles use status 'in_review' instead.
  review_version_id uuid,
  -- Break-glass publishing (po decision, segregation of duties): the head published without a
  -- second person, with a reason. The flag stays up until another approver reviews it. The reason is
  -- also in the audit log; it is kept here so the review queue can show it.
  break_glass_pending boolean NOT NULL DEFAULT false,
  break_glass_by uuid,
  break_glass_at timestamptz,
  break_glass_reason text,
  -- The version that went live break-glass, and the number of the version that was live before the
  -- FIRST break-glass of the pending window (0: none). A second break-glass while the flag is up
  -- keeps that number and adds its publisher to break_glass_publishers, so the range that needs a
  -- second pair of eyes only grows. break_glass_by is the latest publisher, break_glass_publishers
  -- is everybody who used break-glass in the window; none of them reviews it, nor does anybody who
  -- wrote a version after prev_version up to the break-glass one.
  break_glass_version_id uuid,
  break_glass_prev_version integer,
  break_glass_publishers uuid[] NOT NULL DEFAULT '{}',
  break_glass_reviewed_by uuid,
  break_glass_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_article_slug_check CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$'),
  CONSTRAINT kb_article_kind_check CHECK (kind IN ('article', 'runbook')),
  CONSTRAINT kb_article_lang_check CHECK (lang IN ('th', 'en')),
  CONSTRAINT kb_article_status_check CHECK (status IN ('draft', 'in_review', 'published', 'deprecated')),
  CONSTRAINT kb_article_visibility_check CHECK (visibility IN ('internal', 'customer', 'orgs')),
  CONSTRAINT kb_article_published_check CHECK (status <> 'published' OR published_version_id IS NOT NULL),
  CONSTRAINT kb_article_sources_check CHECK (jsonb_typeof(sources) = 'array'),
  CONSTRAINT kb_article_break_glass_check CHECK (
    NOT break_glass_pending OR (
      break_glass_by IS NOT NULL
      AND length(btrim(break_glass_reason)) > 0
      AND break_glass_version_id IS NOT NULL
      AND break_glass_prev_version IS NOT NULL
      AND break_glass_by = ANY (break_glass_publishers)
    )
  )
);
CREATE UNIQUE INDEX kb_article_slug_key ON kb_article (slug);
CREATE INDEX kb_article_status_idx ON kb_article (status, updated_at DESC);
CREATE INDEX kb_article_intent_tags_idx ON kb_article USING gin (intent_tags);
CREATE INDEX kb_article_break_glass_idx ON kb_article (break_glass_at) WHERE break_glass_pending;

CREATE TABLE kb_article_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES kb_article (id) ON DELETE RESTRICT,
  version integer NOT NULL,
  title text NOT NULL,
  body_md text NOT NULL,
  change_note text,
  -- sha256 (hex) of title and body: an edit that changes nothing is not a new version.
  content_hash text NOT NULL,
  -- No foreign key: history must survive the user (see the header).
  created_by uuid,
  -- True when an AI wrote the text (its created_by is null). Such a version never goes live by
  -- break-glass: it needs a normal publication by a person (owner decision, AI drafts).
  authored_by_ai boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_article_version_version_check CHECK (version >= 1),
  CONSTRAINT kb_article_version_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT kb_article_version_body_check CHECK (length(body_md) <= 200000),
  CONSTRAINT kb_article_version_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX kb_article_version_number_key ON kb_article_version (article_id, version);
-- Target of the composite foreign keys below: a pointer can only name a version of its own article.
CREATE UNIQUE INDEX kb_article_version_owner_key ON kb_article_version (id, article_id);

ALTER TABLE kb_article
  -- Both pointers are deferred so an article and its first version can be inserted in either order
  -- in one transaction (the seed writes a published article in one go).
  ADD CONSTRAINT kb_article_current_version_fkey
    FOREIGN KEY (current_version_id, id) REFERENCES kb_article_version (id, article_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT kb_article_published_version_fkey
    FOREIGN KEY (published_version_id, id) REFERENCES kb_article_version (id, article_id)
    DEFERRABLE INITIALLY DEFERRED,
  -- These two are only set to versions that already exist, so they need no deferral.
  ADD CONSTRAINT kb_article_review_version_fkey
    FOREIGN KEY (review_version_id, id) REFERENCES kb_article_version (id, article_id),
  ADD CONSTRAINT kb_article_break_glass_version_fkey
    FOREIGN KEY (break_glass_version_id, id) REFERENCES kb_article_version (id, article_id);

CREATE TRIGGER kb_article_version_reject_update_delete
  BEFORE UPDATE OR DELETE ON kb_article_version
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER kb_article_version_reject_truncate
  BEFORE TRUNCATE ON kb_article_version
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON kb_article_version FROM watchtower_app, PUBLIC;
REVOKE DELETE, TRUNCATE ON kb_article FROM watchtower_app, PUBLIC;

CREATE TABLE kb_article_org (
  article_id uuid NOT NULL REFERENCES kb_article (id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, org_id)
);
CREATE INDEX kb_article_org_org_idx ON kb_article_org (org_id);

CREATE TABLE kb_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES kb_article (id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  -- Position in the version, from 0.
  ordinal integer NOT NULL,
  -- Heading path of the section, for citations down to section level (R-4.2): "Reset > Steps".
  section text NOT NULL DEFAULT '',
  text text NOT NULL,
  -- Offsets of the chunk in body_md (UTF-16 code units), to highlight the cited passage.
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  embedding vector,
  embedding_index_id uuid REFERENCES kb_embedding_index (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_chunk_version_fkey FOREIGN KEY (version_id, article_id)
    REFERENCES kb_article_version (id, article_id) ON DELETE RESTRICT,
  CONSTRAINT kb_chunk_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT kb_chunk_range_check CHECK (char_start >= 0 AND char_end >= char_start),
  CONSTRAINT kb_chunk_text_check CHECK (length(text) > 0),
  CONSTRAINT kb_chunk_embedding_pair_check CHECK ((embedding IS NULL) = (embedding_index_id IS NULL))
);
CREATE UNIQUE INDEX kb_chunk_position_key ON kb_chunk (version_id, ordinal);
CREATE INDEX kb_chunk_article_idx ON kb_chunk (article_id);
CREATE INDEX kb_chunk_index_idx ON kb_chunk (embedding_index_id) WHERE embedding_index_id IS NOT NULL;
CREATE INDEX kb_chunk_text_trgm_idx ON kb_chunk USING gin (text gin_trgm_ops);

-- Break-glass bookkeeping cannot be edited around the domain. The break-glass columns change in
-- exactly two ways:
--   1. A real break-glass publication: the article is published, the live version really changes
--      to the newest version (which is also the break-glass version and the latest one), nobody
--      has reviewed it, the publisher exists, no version in the range is AI-authored, and a flag
--      that was already up keeps its prev_version and only adds the publisher (with a later time).
--   2. A review that clears the flag: the reviewer exists, is not any publisher of the window, and
--      wrote none of the text that went live (every version after prev_version up to the
--      break-glass one). Nothing else in the record changes with it.
-- Anything else that touches these columns (while the flag is up, after a review, or on an article
-- that never had one) is refused, so a reason or a publisher cannot be rewritten later.
CREATE FUNCTION kb_article_guard_break_glass() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  live_number integer;
  newest_number integer;
  old_live_number integer;
  expected_prev integer;
  expected_publishers uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.break_glass_pending OR NEW.break_glass_by IS NOT NULL OR NEW.break_glass_at IS NOT NULL
       OR NEW.break_glass_reason IS NOT NULL OR NEW.break_glass_version_id IS NOT NULL
       OR NEW.break_glass_prev_version IS NOT NULL OR cardinality(NEW.break_glass_publishers) > 0
       OR NEW.break_glass_reviewed_by IS NOT NULL OR NEW.break_glass_reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new article carries no break-glass record'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.break_glass_pending IS NOT DISTINCT FROM OLD.break_glass_pending
     AND NEW.break_glass_by IS NOT DISTINCT FROM OLD.break_glass_by
     AND NEW.break_glass_at IS NOT DISTINCT FROM OLD.break_glass_at
     AND NEW.break_glass_reason IS NOT DISTINCT FROM OLD.break_glass_reason
     AND NEW.break_glass_version_id IS NOT DISTINCT FROM OLD.break_glass_version_id
     AND NEW.break_glass_prev_version IS NOT DISTINCT FROM OLD.break_glass_prev_version
     AND NEW.break_glass_publishers IS NOT DISTINCT FROM OLD.break_glass_publishers
     AND NEW.break_glass_reviewed_by IS NOT DISTINCT FROM OLD.break_glass_reviewed_by
     AND NEW.break_glass_reviewed_at IS NOT DISTINCT FROM OLD.break_glass_reviewed_at THEN
    RETURN NEW;
  END IF;

  IF NEW.break_glass_pending THEN
    -- 1. A real break-glass publication.
    IF NEW.status <> 'published' OR NEW.published_version_id IS NULL
       OR NEW.published_version_id IS NOT DISTINCT FROM OLD.published_version_id
       OR NEW.break_glass_version_id IS DISTINCT FROM NEW.published_version_id
       OR NEW.current_version_id IS DISTINCT FROM NEW.published_version_id THEN
      RAISE EXCEPTION 'a break-glass record is written only by a publication that changes the live version to the latest one'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT version INTO live_number FROM kb_article_version WHERE id = NEW.published_version_id;
    SELECT max(version) INTO newest_number FROM kb_article_version WHERE article_id = NEW.id;
    IF live_number IS NULL OR live_number <> newest_number THEN
      RAISE EXCEPTION 'a break-glass publication puts the newest version live'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.break_glass_by IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.break_glass_by) THEN
      RAISE EXCEPTION 'a break-glass publisher is a user'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.break_glass_at IS NULL OR NEW.break_glass_reviewed_by IS NOT NULL
       OR NEW.break_glass_reviewed_at IS NOT NULL
       OR (OLD.break_glass_pending AND NEW.break_glass_at <= OLD.break_glass_at) THEN
      RAISE EXCEPTION 'a break-glass publication is new and not yet reviewed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.break_glass_pending THEN
      -- A second one while the first waits: the range and the publishers only grow.
      expected_prev := OLD.break_glass_prev_version;
      expected_publishers := OLD.break_glass_publishers;
      IF NOT (NEW.break_glass_by = ANY (expected_publishers)) THEN
        expected_publishers := expected_publishers || NEW.break_glass_by;
      END IF;
    ELSE
      SELECT version INTO old_live_number FROM kb_article_version WHERE id = OLD.published_version_id;
      expected_prev := coalesce(old_live_number, 0);
      expected_publishers := ARRAY[NEW.break_glass_by];
    END IF;
    IF NEW.break_glass_prev_version IS DISTINCT FROM expected_prev
       OR NEW.break_glass_publishers IS DISTINCT FROM expected_publishers THEN
      RAISE EXCEPTION 'a break-glass publication keeps the earlier range and publishers of the flag'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM kb_article_version
      WHERE article_id = NEW.id AND version > expected_prev AND version <= live_number
        AND authored_by_ai
    ) THEN
      RAISE EXCEPTION 'text written by an AI does not go live by break-glass'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.break_glass_pending THEN
    -- 2. A review that clears the flag.
    IF NEW.break_glass_reviewed_by IS NULL OR NEW.break_glass_reviewed_at IS NULL
       OR NEW.break_glass_reviewed_by = OLD.break_glass_by
       OR NEW.break_glass_reviewed_by = ANY (OLD.break_glass_publishers) THEN
      RAISE EXCEPTION 'a break-glass flag is cleared by a review from somebody else than its publishers'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.break_glass_reviewed_by) THEN
      RAISE EXCEPTION 'a break-glass review is made by a user'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM kb_article_version written
      JOIN kb_article_version live ON live.id = OLD.break_glass_version_id
      WHERE written.article_id = OLD.id
        AND written.version > coalesce(OLD.break_glass_prev_version, 0)
        AND written.version <= live.version
        AND written.created_by = NEW.break_glass_reviewed_by
    ) THEN
      RAISE EXCEPTION 'a break-glass flag is not cleared by somebody who wrote the text that went live'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.break_glass_by IS DISTINCT FROM OLD.break_glass_by
       OR NEW.break_glass_at IS DISTINCT FROM OLD.break_glass_at
       OR NEW.break_glass_version_id IS DISTINCT FROM OLD.break_glass_version_id
       OR NEW.break_glass_prev_version IS DISTINCT FROM OLD.break_glass_prev_version
       OR NEW.break_glass_publishers IS DISTINCT FROM OLD.break_glass_publishers
       OR NEW.break_glass_reason IS DISTINCT FROM OLD.break_glass_reason THEN
      RAISE EXCEPTION 'break-glass history cannot change while it is reviewed'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'break-glass history is frozen once reviewed; only a new break-glass publication replaces it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER kb_article_guard_break_glass
  BEFORE INSERT OR UPDATE ON kb_article
  FOR EACH ROW EXECUTE FUNCTION kb_article_guard_break_glass();

-- A vector must have the dimensions its index says; a mismatch would make every distance fail.
CREATE FUNCTION kb_chunk_check_embedding() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected integer;
BEGIN
  IF NEW.embedding IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT dimensions INTO expected FROM kb_embedding_index WHERE id = NEW.embedding_index_id;
  IF expected IS NULL OR vector_dims(NEW.embedding) <> expected THEN
    RAISE EXCEPTION 'kb_chunk embedding has % dimensions, its index says %',
      vector_dims(NEW.embedding), coalesce(expected::text, 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER kb_chunk_check_embedding
  BEFORE INSERT OR UPDATE OF embedding, embedding_index_id ON kb_chunk
  FOR EACH ROW EXECUTE FUNCTION kb_chunk_check_embedding();

-- Customer-facing search: the client role may search customer-visible articles of its organization.
INSERT INTO permissions (key, description) VALUES
  ('kb.read.customer', 'Search the customer-visible knowledge base (client)'),
  ('kb.publish.break_glass', 'Publish a knowledge base article without a second person, with a reason (head)');
INSERT INTO role_permissions (role, permission) VALUES
  ('client', 'kb.read.customer'),
  ('head', 'kb.publish.break_glass');
