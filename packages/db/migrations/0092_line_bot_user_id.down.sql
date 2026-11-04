-- Reverses 0092_line_bot_user_id.sql. The api then accepts a webhook whatever its `destination` says.
ALTER TABLE channel_account DROP CONSTRAINT IF EXISTS channel_account_line_bot_user_id_check;
ALTER TABLE channel_account DROP COLUMN line_bot_user_id;
