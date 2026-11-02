-- T-205d: the Client Health Score of an organization (PRD R-8.4). Reversible: 0063_org_health_snapshot.down.sql.
--
--   org_health_snapshot  one row per organization, UTC day and formula version. `components` holds, for each part
--                        of the score, whether it had enough data and what it contributed; the weights are part
--                        of the formula, which is identified by `formula_version` (a new weighting is a new
--                        version, and the old snapshots stay readable). `score` is NULL exactly when
--                        `status = 'insufficient_data'`: a score is never invented for an organization that has
--                        not been observed long enough (N5).
--                        There is no cross-organization column (no rank, percentile or average): a score says
--                        something about its own organization only.
--
-- Clock: `day` and created_at come from the database clock.

CREATE TABLE org_health_snapshot (
  org_id uuid NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  day date NOT NULL,
  formula_version integer NOT NULL,
  status text NOT NULL,
  score smallint,
  components jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, day, formula_version),
  CONSTRAINT org_health_snapshot_version_check CHECK (formula_version >= 1),
  CONSTRAINT org_health_snapshot_status_check CHECK (status IN ('scored', 'insufficient_data')),
  CONSTRAINT org_health_snapshot_score_check CHECK (
    (status = 'scored') = (score IS NOT NULL) AND (score IS NULL OR score BETWEEN 0 AND 100)
  ),
  CONSTRAINT org_health_snapshot_components_object CHECK (jsonb_typeof(components) = 'object')
);
CREATE INDEX org_health_snapshot_latest_idx ON org_health_snapshot (org_id, day DESC);
