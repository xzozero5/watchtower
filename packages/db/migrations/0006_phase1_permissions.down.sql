-- Reverts 0006. role_permissions rows go with the permissions (ON DELETE CASCADE), including any
-- grant a head added by hand for these strings.
DELETE FROM permissions
 WHERE key IN (
   'inbound.read', 'outbox.manage', 'view.share', 'ai.emergency_switch',
   'shift.note.write', 'handoff.ack', 'csat.read', 'ai.run.read'
 );
