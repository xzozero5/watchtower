-- Reverts 0106. It refuses while a portal delivery exists (an old schema cannot hold one, and a finished one is a
-- record of a message that reached a customer). The rollback notifications and the disclosure setting are dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM outbound_delivery WHERE channel = 'portal') THEN
    RAISE EXCEPTION 'migration 0106 down: portal deliveries exist; they are a record of what reached customers and cannot be converted'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

DELETE FROM instance_setting WHERE key = 'autosend.disclosure';
ALTER TABLE instance_setting DROP CONSTRAINT instance_setting_autosend_disclosure_check;

DELETE FROM notification_preference WHERE kind = 'autonomy.rollback';
DELETE FROM notification WHERE kind = 'autonomy.rollback';
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead'));
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead'));

ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_portal_auto_only;
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_channel_check;
ALTER TABLE outbound_delivery ADD CONSTRAINT outbound_delivery_channel_check CHECK (channel IN ('gmail', 'line'));
