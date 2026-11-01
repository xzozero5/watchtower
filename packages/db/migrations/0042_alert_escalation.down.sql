-- Reverts 0042. Lossy on purpose: the escalation log and the acknowledgment channel go away, and
-- notifications of the two alert kinds are deleted so the narrower CHECK can be restored.
DROP TABLE IF EXISTS alert_escalation;
ALTER TABLE alert DROP CONSTRAINT IF EXISTS alert_acked_via_state;
ALTER TABLE alert DROP CONSTRAINT IF EXISTS alert_acked_via_check;
ALTER TABLE alert DROP COLUMN IF EXISTS acked_via;
DELETE FROM notification_preference WHERE kind IN ('alert.fired', 'alert.escalated');
DELETE FROM notification WHERE kind IN ('alert.fired', 'alert.escalated');
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show'));
