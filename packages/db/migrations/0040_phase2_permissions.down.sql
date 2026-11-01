-- Reverts 0040. role_permissions rows go with the permissions (ON DELETE CASCADE), including any
-- grant a head added by hand for these strings. Refuses to run while an internal ticket exists:
-- the old channel check would reject it, and the data is not ours to delete.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ticket WHERE channel = 'internal') THEN
    RAISE EXCEPTION 'cannot revert 0040: tickets with channel internal exist';
  END IF;
END $$;

ALTER TABLE ticket DROP CONSTRAINT ticket_channel_check;
ALTER TABLE ticket ADD CONSTRAINT ticket_channel_check
  CHECK (channel IN ('gmail', 'line', 'portal', 'discord', 'webhook'));

DELETE FROM permissions
 WHERE key IN (
   'alert.read', 'alert.ack', 'alert.manage', 'service.manage', 'investigate.adhoc',
   'metric.read', 'metric.manage', 'org.health.read', 'dashboard.ops.read'
 );
