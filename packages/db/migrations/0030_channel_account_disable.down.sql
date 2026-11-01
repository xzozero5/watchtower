-- Reverses 0030_channel_account_disable.sql. Accounts that were switched off become usable again.
ALTER TABLE channel_account DROP COLUMN disabled_at;
