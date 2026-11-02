-- T-203b: one rate budget for every caller of a quota-limited API, and tool_execution partitioned (ARCH section 7).
--   1. rate_budget_window:  a sliding one-minute window in one-second slots, per resource (for
--                           example `logging:<project>`). A caller takes one unit with
--                           `acquire` (packages/domain): the sum of the last minute decides, under an
--                           advisory lock per resource, with the database clock, so every process
--                           shares one budget. `total` counts every caller, `ai` the AI's share
--                           (Logging allows 60 reads a minute a project, PRD R-5.1: we use at most 55,
--                           the AI at most 30, so a person keeps room to run the same query).
--   2. ensure_monthly_partitions gets a fourth argument, the columns the application may still UPDATE
--                           on an append-only partition (tool_execution is closed after it is written:
--                           status, error code, latency, result count).
--   3. tool_execution:      becomes a table partitioned by month, primary key (id, created_at).
-- Reversible: see 0067_rate_budget.down.sql.

-- 1. The window.
CREATE TABLE rate_budget_window (
  resource text NOT NULL,
  -- Start of the second, database clock.
  slot timestamptz NOT NULL,
  total integer NOT NULL DEFAULT 0,
  ai integer NOT NULL DEFAULT 0,
  PRIMARY KEY (resource, slot),
  CONSTRAINT rate_budget_window_counts_check CHECK (total >= 0 AND ai >= 0 AND ai <= total),
  CONSTRAINT rate_budget_window_resource_check CHECK (resource ~ '^[a-z][a-z0-9_]*:[A-Za-z0-9_.-]{1,100}$')
);

-- 2. The partition helper, with the columns that stay writable.
DROP FUNCTION ensure_monthly_partitions(regclass, integer, boolean);
CREATE FUNCTION ensure_monthly_partitions(
  parent regclass,
  months_ahead integer DEFAULT 3,
  append_only boolean DEFAULT false,
  updatable_columns text[] DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent_name text;
  month_start date;
  month_end date;
  part_name text;
  created integer := 0;
  i integer;
BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 36';
  END IF;
  SELECT c.relname INTO parent_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = parent AND c.relkind = 'p' AND n.nspname = 'public';
  IF parent_name IS NULL THEN
    RAISE EXCEPTION '% is not a partitioned table in schema public', parent;
  END IF;

  FOR i IN 0..months_ahead LOOP
    month_start := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i))::date;
    month_end := (month_start + make_interval(months => 1))::date;
    part_name := parent_name || '_p' || to_char(month_start, 'YYYYMM');
    IF to_regclass(format('public.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent_name,
        month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00'
      );
      IF append_only THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM watchtower_app, PUBLIC', part_name);
        IF updatable_columns IS NOT NULL THEN
          EXECUTE format(
            'GRANT UPDATE (%s) ON public.%I TO watchtower_app',
            (SELECT string_agg(quote_ident(c), ', ') FROM unnest(updatable_columns) AS c), part_name
          );
        END IF;
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()',
          part_name || '_reject_truncate', part_name
        );
      END IF;
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION ensure_monthly_partitions(regclass, integer, boolean, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_monthly_partitions(regclass, integer, boolean, text[]) TO watchtower_app;

-- 3. tool_execution, partitioned. The old table is renamed (with its indexes), the new one takes
-- its name, the rows are copied, the old one is dropped.
ALTER TABLE tool_execution RENAME TO tool_execution_old;
ALTER TABLE tool_execution_old RENAME CONSTRAINT tool_execution_pkey TO tool_execution_old_pkey;
ALTER INDEX tool_execution_ticket_idx RENAME TO tool_execution_old_ticket_idx;
ALTER INDEX tool_execution_tool_idx RENAME TO tool_execution_old_tool_idx;
ALTER INDEX tool_execution_run_idx RENAME TO tool_execution_old_run_idx;

CREATE TABLE tool_execution (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ticket_id uuid REFERENCES ticket (id) ON DELETE RESTRICT,
  run_key text NOT NULL,
  agent text NOT NULL,
  tool text NOT NULL,
  intent text,
  stage smallint,
  input_hash text NOT NULL,
  status text NOT NULL,
  error_code text,
  latency_ms integer,
  result_count integer,
  mock boolean NOT NULL DEFAULT false,
  -- A partitioned table's primary key must contain the partition key.
  PRIMARY KEY (id, created_at),
  CONSTRAINT tool_execution_status_check CHECK (status IN ('running', 'ok', 'error', 'denied')),
  CONSTRAINT tool_execution_name_check CHECK (tool ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT tool_execution_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tool_execution_finished_check CHECK ((status = 'running') = (finished_at IS NULL))
) PARTITION BY RANGE (created_at);

CREATE INDEX tool_execution_ticket_idx ON tool_execution (ticket_id, created_at DESC);
CREATE INDEX tool_execution_tool_idx ON tool_execution (tool, created_at DESC);
CREATE INDEX tool_execution_run_idx ON tool_execution (run_key);

CREATE TABLE tool_execution_default PARTITION OF tool_execution DEFAULT;
CREATE TRIGGER tool_execution_default_reject_truncate
  BEFORE TRUNCATE ON tool_execution_default
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Same rights as before: the application writes a row, then closes it. It cannot rewrite who, what or
-- when, and cannot delete. (Rights on the parent are not inherited by partitions: each gets its own.)
REVOKE UPDATE, DELETE, TRUNCATE ON tool_execution, tool_execution_default FROM watchtower_app, PUBLIC;
GRANT UPDATE (status, error_code, finished_at, latency_ms, result_count)
  ON tool_execution, tool_execution_default TO watchtower_app;

SELECT ensure_monthly_partitions(
  'tool_execution', 12, true,
  ARRAY['status', 'error_code', 'finished_at', 'latency_ms', 'result_count']
);

INSERT INTO tool_execution (id, created_at, finished_at, ticket_id, run_key, agent, tool, intent, stage,
                            input_hash, status, error_code, latency_ms, result_count, mock)
SELECT id, created_at, finished_at, ticket_id, run_key, agent, tool, intent, stage,
       input_hash, status, error_code, latency_ms, result_count, mock
FROM tool_execution_old;

DROP TABLE tool_execution_old;
