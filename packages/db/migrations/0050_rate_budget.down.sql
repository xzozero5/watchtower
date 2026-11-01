-- Reverts 0050. No tool_execution row is lost: they are copied back into a plain table. The rate
-- window is a counter of the last minute, so dropping it loses nothing that matters.
ALTER TABLE tool_execution RENAME TO tool_execution_part;
ALTER TABLE tool_execution_part RENAME CONSTRAINT tool_execution_pkey TO tool_execution_part_pkey;
ALTER INDEX tool_execution_ticket_idx RENAME TO tool_execution_part_ticket_idx;
ALTER INDEX tool_execution_tool_idx RENAME TO tool_execution_part_tool_idx;
ALTER INDEX tool_execution_run_idx RENAME TO tool_execution_part_run_idx;

CREATE TABLE tool_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  CONSTRAINT tool_execution_status_check CHECK (status IN ('running', 'ok', 'error', 'denied')),
  CONSTRAINT tool_execution_name_check CHECK (tool ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT tool_execution_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tool_execution_finished_check CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX tool_execution_ticket_idx ON tool_execution (ticket_id, created_at DESC);
CREATE INDEX tool_execution_tool_idx ON tool_execution (tool, created_at DESC);
CREATE INDEX tool_execution_run_idx ON tool_execution (run_key);
REVOKE UPDATE, DELETE, TRUNCATE ON tool_execution FROM watchtower_app, PUBLIC;
GRANT UPDATE (status, error_code, finished_at, latency_ms, result_count) ON tool_execution TO watchtower_app;

INSERT INTO tool_execution (id, created_at, finished_at, ticket_id, run_key, agent, tool, intent, stage,
                            input_hash, status, error_code, latency_ms, result_count, mock)
SELECT id, created_at, finished_at, ticket_id, run_key, agent, tool, intent, stage,
       input_hash, status, error_code, latency_ms, result_count, mock
FROM tool_execution_part;

DROP TABLE tool_execution_part;
DROP TABLE rate_budget_window;

-- The three-argument helper of migration 0001.
DROP FUNCTION ensure_monthly_partitions(regclass, integer, boolean, text[]);
CREATE FUNCTION ensure_monthly_partitions(
  parent regclass,
  months_ahead integer DEFAULT 3,
  append_only boolean DEFAULT false
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

REVOKE ALL ON FUNCTION ensure_monthly_partitions(regclass, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_monthly_partitions(regclass, integer, boolean) TO watchtower_app;
