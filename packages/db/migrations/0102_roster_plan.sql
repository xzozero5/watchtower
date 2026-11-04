-- T-305e (PRD R-7.2): the roster planner's drafts. A plan is made by the deterministic solver from a snapshot of
-- its inputs (people, leave, coverage, rules, the shifts already standing, recent fairness); the planned shifts are
-- kept as a list until a lead or head applies them (writing roster_entry through the roster service, audited) or
-- discards the plan. The AI only writes an explanation of a plan; it never changes the entries.
-- Reversible: see 0102_roster_plan.down.sql.

CREATE TABLE roster_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- First local date of the planned week.
  week_start date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- Everything the solver and the re-check need (people, shifts, rules, coverage, fixed shifts, history).
  inputs jsonb NOT NULL,
  -- The planned shifts: [{ "userId", "shiftId", "workDate" }].
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- complete | no_solution | unproven, and how many nodes the search used.
  solver_status text NOT NULL,
  solver_nodes integer NOT NULL DEFAULT 0,
  -- The AI explanation of the plan as it was when written; cleared by a hand edit.
  explanation text,
  explanation_locale text,
  explanation_prompt_version integer,
  explanation_run_id uuid,
  explanation_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  applied_by uuid REFERENCES users (id) ON DELETE SET NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roster_plan_status_check CHECK (status IN ('draft', 'applied', 'discarded')),
  CONSTRAINT roster_plan_solver_check CHECK (solver_status IN ('complete', 'no_solution', 'unproven')),
  CONSTRAINT roster_plan_entries_check CHECK (jsonb_typeof(entries) = 'array'),
  CONSTRAINT roster_plan_explanation_check CHECK (
    (explanation IS NULL) = (explanation_locale IS NULL)
    AND (explanation_locale IS NULL OR explanation_locale IN ('th', 'en'))
  ),
  CONSTRAINT roster_plan_applied_check CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);
CREATE INDEX roster_plan_week_idx ON roster_plan (week_start DESC, created_at DESC);
