-- T-176: three notification kinds about the system itself (the mail server refused our login, the
-- instance-wide upload cap is full, outbox rows were given up on). Sent to heads, at most once an
-- hour per kind (the domain decides; the database only knows the kinds).
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead'));
-- The hourly check reads "latest notification of this kind".
CREATE INDEX IF NOT EXISTS notification_kind_created_idx ON notification (kind, created_at DESC);
