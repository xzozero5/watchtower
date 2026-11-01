-- T-200: the Phase 2 permission strings and their default grants, and the `internal` ticket channel.
--   [ASSUMED] matrix, in the style of PRD section 2.2 (po confirms):
--     agent: alert.read, alert.ack, dashboard.ops.read
--     lead:  the agent grants plus alert.manage, service.manage, investigate.adhoc, metric.read,
--            org.health.read
--     head:  everything lead has plus metric.manage
--     client and system: nothing
--   packages/shared/src/rbac.ts holds the same data; an integration test keeps them equal.
--
-- ticket.channel gains 'internal': a ticket the system or a person opens without a customer (usage
-- anomaly, alert follow-up). channel_account.type does NOT gain it: nothing is delivered on it.
-- Reversible: see 0040_phase2_permissions.down.sql.
INSERT INTO permissions (key, description) VALUES
  ('alert.read', 'View alerts and the service catalog'),
  ('alert.ack', 'Acknowledge an alert'),
  ('alert.manage', 'Snooze or resolve alerts by hand and manage escalation policies'),
  ('service.manage', 'Create and edit services in the catalog'),
  ('investigate.adhoc', 'Run an ad-hoc investigation query outside a ticket template'),
  ('metric.read', 'View product usage metrics'),
  ('metric.manage', 'Create and edit product usage metric definitions'),
  ('org.health.read', 'View the Client Health Score of an organization'),
  ('dashboard.ops.read', 'View the ops dashboard and the service status panel');

INSERT INTO role_permissions (role, permission) VALUES
  ('agent', 'alert.read'),
  ('agent', 'alert.ack'),
  ('agent', 'dashboard.ops.read'),
  ('lead', 'alert.read'),
  ('lead', 'alert.ack'),
  ('lead', 'dashboard.ops.read'),
  ('lead', 'alert.manage'),
  ('lead', 'service.manage'),
  ('lead', 'investigate.adhoc'),
  ('lead', 'metric.read'),
  ('lead', 'org.health.read'),
  ('head', 'alert.read'),
  ('head', 'alert.ack'),
  ('head', 'dashboard.ops.read'),
  ('head', 'alert.manage'),
  ('head', 'service.manage'),
  ('head', 'investigate.adhoc'),
  ('head', 'metric.read'),
  ('head', 'org.health.read'),
  ('head', 'metric.manage');

ALTER TABLE ticket DROP CONSTRAINT ticket_channel_check;
ALTER TABLE ticket ADD CONSTRAINT ticket_channel_check
  CHECK (channel IN ('gmail', 'line', 'portal', 'discord', 'webhook', 'internal'));
