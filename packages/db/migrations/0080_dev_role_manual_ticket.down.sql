-- Reverts 0080. Refuses to run while the data it would orphan exists: a dev user, a ticket on one of the
-- manual channels, a dev owner on a ticket, or a link of a ticket to an incident or a deploy. That data is
-- not ours to delete or rewrite.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role = 'dev') THEN
    RAISE EXCEPTION 'cannot revert 0080: users with role dev exist';
  END IF;
  IF EXISTS (SELECT 1 FROM ticket WHERE channel IN ('phone', 'walk_in', 'chat', 'other')) THEN
    RAISE EXCEPTION 'cannot revert 0080: tickets on a manual channel exist';
  END IF;
  IF EXISTS (SELECT 1 FROM ticket WHERE dev_owner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot revert 0080: tickets with a dev owner exist';
  END IF;
  IF EXISTS (SELECT 1 FROM ticket_link WHERE kind IN ('incident', 'deploy')) THEN
    RAISE EXCEPTION 'cannot revert 0080: links to an incident or a deploy exist';
  END IF;
END $$;

DROP INDEX ticket_link_deploy_key;
DROP INDEX ticket_link_incident_key;
ALTER TABLE ticket_link DROP CONSTRAINT ticket_link_target_check;
ALTER TABLE ticket_link DROP CONSTRAINT ticket_link_distinct_check;
ALTER TABLE ticket_link ADD CONSTRAINT ticket_link_distinct_check CHECK (from_ticket_id <> to_ticket_id);
ALTER TABLE ticket_link DROP CONSTRAINT ticket_link_kind_check;
ALTER TABLE ticket_link ADD CONSTRAINT ticket_link_kind_check CHECK (kind IN ('duplicate', 'related'));
ALTER TABLE ticket_link ALTER COLUMN to_ticket_id SET NOT NULL;
ALTER TABLE ticket_link DROP COLUMN deploy_id;
ALTER TABLE ticket_link DROP COLUMN incident_id;

DROP INDEX ticket_dev_owner_idx;
ALTER TABLE ticket DROP COLUMN dev_owner_id;

ALTER TABLE ticket DROP CONSTRAINT ticket_channel_check;
ALTER TABLE ticket ADD CONSTRAINT ticket_channel_check
  CHECK (channel IN ('gmail', 'line', 'portal', 'discord', 'webhook', 'internal'));

DELETE FROM permissions WHERE key IN ('ticket.read.masked', 'ticket.dev.work', 'ticket.dev.release.any');
DELETE FROM role_permissions WHERE role = 'dev';

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('agent', 'lead', 'head', 'client', 'system'));
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('agent', 'lead', 'head', 'client', 'system'));
