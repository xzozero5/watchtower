-- Reverts 0084. Lossy on purpose: the Gmail dispatch ledger of CSAT surveys and the three new settings
-- go away (a survey already sent stays sent; only the record of how it left is lost). Apply 0084 again to resume.
DROP TABLE IF EXISTS csat_email_dispatch;
DELETE FROM instance_setting WHERE key IN ('csat.enabled', 'csat.reminder_hours', 'csat.cooldown_days');
ALTER TABLE instance_setting DROP CONSTRAINT IF EXISTS instance_setting_csat_enabled_check;
ALTER TABLE instance_setting DROP CONSTRAINT IF EXISTS instance_setting_csat_reminder_check;
ALTER TABLE instance_setting DROP CONSTRAINT IF EXISTS instance_setting_csat_cooldown_check;
