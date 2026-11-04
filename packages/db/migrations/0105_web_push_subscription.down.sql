-- Reverts 0105. Lossy on purpose: every browser has to subscribe again. Notifications are untouched.
DROP TABLE IF EXISTS web_push_subscription;
