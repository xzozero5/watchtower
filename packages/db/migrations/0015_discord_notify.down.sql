-- Reverts 0015. Lossy on purpose: the Discord notification ledger goes away. Tickets are untouched.
DROP TABLE IF EXISTS discord_notification;
