-- T-137 (the `dev` role) and T-136 (a ticket filed by hand).
--   [ASSUMED] matrix, per the `po` decision (PRD section 2.2); packages/shared/src/rbac.ts holds the same
--   data and an integration test keeps them equal:
--     dev: ticket.read.masked, ticket.dev.work, investigate.run, auth.session.self
--     lead (and so head) also get ticket.dev.release.any, to free a ticket from a developer who is away.
--   users.role and role_permissions.role accept 'dev'. A dev is not a member of STAFF_ROLES in code:
--   tickets are never assigned to a dev; the person picks a ticket up in ticket.dev_owner_id, and
--   ticket.assignee_id stays the agent (AC-7).
--   ticket.channel gains 'phone', 'walk_in', 'chat', 'other' (T-136): where a person says a request came
--   from. channel_account.type does NOT gain them: nothing is delivered on them.
--   ticket_link (made by 0066 for duplicate and related links) gains the kinds incident and deploy
--   (T-137): a reference to a row that already exists; a dev cannot create either.
-- Reversible: see 0080_dev_role_manual_ticket.down.sql.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('agent', 'lead', 'head', 'dev', 'client', 'system'));
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('agent', 'lead', 'head', 'dev', 'client', 'system'));

INSERT INTO permissions (key, description) VALUES
  ('ticket.read.masked',
   'Read any ticket with personal data masked (email, phone, names, message text through the redactor)'),
  ('ticket.dev.work',
   'Developer work on a ticket: internal notes, open and waiting_on_dev, pick up as dev owner, link an incident or deploy'),
  ('ticket.dev.release.any', 'Let go of the dev owner of any ticket (a developer who is away)');

INSERT INTO role_permissions (role, permission) VALUES
  ('dev', 'ticket.read.masked'),
  ('dev', 'ticket.dev.work'),
  ('dev', 'investigate.run'),
  ('dev', 'auth.session.self'),
  ('lead', 'ticket.dev.release.any'),
  ('head', 'ticket.dev.release.any');

ALTER TABLE ticket DROP CONSTRAINT ticket_channel_check;
ALTER TABLE ticket ADD CONSTRAINT ticket_channel_check
  CHECK (channel IN ('gmail', 'line', 'portal', 'discord', 'webhook', 'phone', 'walk_in', 'chat', 'other', 'internal'));

ALTER TABLE ticket ADD COLUMN dev_owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX ticket_dev_owner_idx ON ticket (dev_owner_id, status) WHERE dev_owner_id IS NOT NULL;

-- ticket_link (0066, between two tickets) also holds a ticket's link to an incident or a deploy (T-137): one
-- row per link, `to_ticket_id` is empty for those and exactly one of `incident_id` / `deploy_id` is set.
-- `UPDATE` stays revoked: a link is made and removed, never edited.
ALTER TABLE ticket_link ADD COLUMN incident_id uuid REFERENCES incident (id) ON DELETE CASCADE;
ALTER TABLE ticket_link ADD COLUMN deploy_id uuid REFERENCES deploy (id) ON DELETE CASCADE;
ALTER TABLE ticket_link ALTER COLUMN to_ticket_id DROP NOT NULL;
ALTER TABLE ticket_link DROP CONSTRAINT ticket_link_kind_check;
ALTER TABLE ticket_link ADD CONSTRAINT ticket_link_kind_check
  CHECK (kind IN ('duplicate', 'related', 'incident', 'deploy'));
ALTER TABLE ticket_link DROP CONSTRAINT ticket_link_distinct_check;
ALTER TABLE ticket_link ADD CONSTRAINT ticket_link_distinct_check
  CHECK (to_ticket_id IS NULL OR from_ticket_id <> to_ticket_id);
ALTER TABLE ticket_link ADD CONSTRAINT ticket_link_target_check CHECK (
  (kind IN ('duplicate', 'related') AND to_ticket_id IS NOT NULL AND incident_id IS NULL AND deploy_id IS NULL)
  OR (kind = 'incident' AND incident_id IS NOT NULL AND to_ticket_id IS NULL AND deploy_id IS NULL)
  OR (kind = 'deploy' AND deploy_id IS NOT NULL AND to_ticket_id IS NULL AND incident_id IS NULL)
);
CREATE UNIQUE INDEX ticket_link_incident_key ON ticket_link (from_ticket_id, incident_id) WHERE incident_id IS NOT NULL;
CREATE UNIQUE INDEX ticket_link_deploy_key ON ticket_link (from_ticket_id, deploy_id) WHERE deploy_id IS NOT NULL;
