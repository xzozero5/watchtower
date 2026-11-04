DROP INDEX IF EXISTS notification_kind_created_idx;
DELETE FROM notification_preference WHERE kind LIKE 'ops.%';
DELETE FROM notification WHERE kind LIKE 'ops.%';
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated'));
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated'));
