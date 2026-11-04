DELETE FROM notification_preference WHERE kind = 'ticket.escalation_requested';
DELETE FROM notification WHERE kind = 'ticket.escalation_requested';
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead', 'autonomy.rollback'));
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead', 'autonomy.rollback'));
