-- T-304d/e (ADR-025): what the stage 3 runtime needs from the schema, and nothing that opens a door.
--
--   1. outbound_delivery_channel_check: 'portal' besides gmail and line. The first round of automatic replies
--      goes by Gmail and the portal (owner decision 5). The database trigger of 0096
--      (outbound_delivery_ai_auto_guard) is what keeps every other origin off the portal: it refuses an ai_auto
--      row on any channel but gmail / portal, and a person's reply on the portal never makes a delivery (it is
--      shown at once). A portal delivery has no route (nothing is called outside; the dispatcher marks the
--      message delivered), which outbound_delivery_route_check already allows (route IS NULL).
--   2. notification kind 'autonomy.rollback': the system moved an intent from stage 3 back to 2, told to the heads.
--   3. instance_setting 'autosend.disclosure': the notice added to an automatic reply (ADR-025 section 8). On by
--      default (owner decision 3); a head edits it through the api (the application can only change `value`).
--
-- Reversible: 0106_autosend_runtime.down.sql. It RAISES while a portal delivery exists.

-- 1.
ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_channel_check;
ALTER TABLE outbound_delivery ADD CONSTRAINT outbound_delivery_channel_check
  CHECK (channel IN ('gmail', 'line', 'portal'));
-- Only an automatic reply is held on the portal. (Not a replacement for the trigger: a second wall.)
ALTER TABLE outbound_delivery ADD CONSTRAINT outbound_delivery_portal_auto_only
  CHECK (channel <> 'portal' OR origin = 'ai_auto');

-- 2.
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead', 'autonomy.rollback'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated',
                  'ops.smtp_auth_failed', 'ops.upload_quota_global', 'ops.outbox_dead', 'autonomy.rollback'));

-- 3.
ALTER TABLE instance_setting ADD CONSTRAINT instance_setting_autosend_disclosure_check CHECK (
  key <> 'autosend.disclosure'
  OR (
    jsonb_typeof(value) = 'object'
    AND jsonb_typeof(value -> 'enabled') = 'boolean'
    AND jsonb_typeof(value #> '{text,th}') = 'string'
    AND jsonb_typeof(value #> '{text,en}') = 'string'
    AND length(btrim(value #>> '{text,th}')) BETWEEN 1 AND 400
    AND length(btrim(value #>> '{text,en}')) BETWEEN 1 AND 400
  )
);
INSERT INTO instance_setting (key, value) VALUES (
  'autosend.disclosure',
  jsonb_build_object(
    'enabled', true,
    'text', jsonb_build_object(
      'th', 'ข้อความนี้ส่งโดยระบบอัตโนมัติ (AI) หากต้องการคุยกับเจ้าหน้าที่ ตอบกลับข้อความนี้ได้เลย',
      'en', 'This reply was sent automatically by our AI assistant. If you would like to speak to a person, just reply to this message.'
    )
  )
);
