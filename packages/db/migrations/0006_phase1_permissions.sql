-- T-123a: the Phase 1 permission strings and their default grants (no new tables).
--   [ASSUMED] matrix, in the style of PRD section 2.2 (po confirms):
--     agent: inbound.read, shift.note.write, handoff.ack
--     lead:  the agent grants plus view.share, ai.emergency_switch, csat.read, ai.run.read
--     head:  everything lead has plus outbox.manage
--     client and system: nothing
--   packages/shared/src/rbac.ts holds the same data; an integration test keeps them equal.
-- Reversible: see 0006_phase1_permissions.down.sql.
INSERT INTO permissions (key, description) VALUES
  ('inbound.read', 'View received messages, including mail that did not become a ticket'),
  ('outbox.manage', 'View and resend dead-lettered outbound messages'),
  ('view.share', 'Share a saved view with the team'),
  ('ai.emergency_switch', 'Use the emergency switch that sends every intent back to draft-only'),
  ('shift.note.write', 'Write shift notes'),
  ('handoff.ack', 'Acknowledge the items of a shift handoff'),
  ('csat.read', 'View CSAT responses'),
  ('ai.run.read', 'View AI run records: prompt version, model, tools and cost');

INSERT INTO role_permissions (role, permission) VALUES
  ('agent', 'inbound.read'),
  ('agent', 'shift.note.write'),
  ('agent', 'handoff.ack'),
  ('lead', 'inbound.read'),
  ('lead', 'shift.note.write'),
  ('lead', 'handoff.ack'),
  ('lead', 'view.share'),
  ('lead', 'ai.emergency_switch'),
  ('lead', 'csat.read'),
  ('lead', 'ai.run.read'),
  ('head', 'inbound.read'),
  ('head', 'shift.note.write'),
  ('head', 'handoff.ack'),
  ('head', 'view.share'),
  ('head', 'ai.emergency_switch'),
  ('head', 'csat.read'),
  ('head', 'ai.run.read'),
  ('head', 'outbox.manage');
