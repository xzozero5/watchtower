-- T-114a C-8: the LINE bot user id of a channel account.
--   line_bot_user_id: the `destination` LINE puts in every webhook body (the bot's own user id, "U" and
--                     32 hex characters). The api records it from the first webhook whose signature
--                     verifies, and from then on refuses a webhook for this account whose
--                     `destination` differs: a second Official Account that shares the channel secret
--                     (or a copied webhook URL) cannot write into this account's inbox. NULL = not seen
--                     yet. It is an identifier, not a credential.
-- Reversible: see 0092_line_bot_user_id.down.sql.

ALTER TABLE channel_account ADD COLUMN line_bot_user_id text;
ALTER TABLE channel_account ADD CONSTRAINT channel_account_line_bot_user_id_check CHECK (
  line_bot_user_id IS NULL OR (type = 'line' AND length(line_bot_user_id) BETWEEN 1 AND 64)
);
