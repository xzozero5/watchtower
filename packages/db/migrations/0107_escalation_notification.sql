-- T-303f: a notification kind for "a procedure asked a lead or head to look at this ticket" (ADR-026 section 10).
-- Keeps 'autonomy.rollback' from 0106 (stage 3): each of these migrations replaces the whole list (merge 2026-11-04).
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'ticket.escalation_requested', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead', 'autonomy.rollback'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'ticket.escalation_requested', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead', 'autonomy.rollback'));
