-- T-175a: ai.budget.read lets a lead or a head read the AI spend and the model map (GET /v1/ai/budget,
-- GET /v1/ai/models) without also holding ai.autonomy.set (the right to change an intent's autonomy stage).
--   [ASSUMED] lead and head only, as before (they held ai.autonomy.set); packages/shared/src/rbac.ts has the
--   same data and an integration test keeps them equal. Reversible: see the .down.sql.
INSERT INTO permissions (key, description) VALUES
  ('ai.budget.read', 'Read the AI spend against its caps and which model each AI agent uses');

INSERT INTO role_permissions (role, permission) VALUES
  ('lead', 'ai.budget.read'),
  ('head', 'ai.budget.read');
