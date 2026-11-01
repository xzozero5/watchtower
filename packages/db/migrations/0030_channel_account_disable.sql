-- T-131: administrators register LINE Official Accounts and Gmail mailboxes by hand
-- (`/v1/admin/channel-accounts`) and can switch one off.
--   disabled_at: NULL = in use. Set = switched off: a LINE webhook for it is refused, a mailbox stops
--                syncing (`gmail_account_state.enabled` is cleared with it). The row stays because
--                tickets, inbound events and deliveries reference it (ON DELETE RESTRICT).
-- Whether a second LINE account may exist is NOT enforced here: the instance holds one LINE channel
-- secret (ADR-012), which the API checks when it creates one (and under an advisory lock).
-- Reversible: see 0030_channel_account_disable.down.sql.

ALTER TABLE channel_account ADD COLUMN disabled_at timestamptz;
