-- Reverses 0093_status_subscription_bounces.sql. Lossy on purpose: the bounce counts and the suppression marks go
-- away; a suppressed address stays `unsubscribed` and can ask to subscribe again.
ALTER TABLE status_subscription DROP CONSTRAINT IF EXISTS status_subscription_bounce_check;
ALTER TABLE status_subscription DROP COLUMN suppressed_at;
ALTER TABLE status_subscription DROP COLUMN bounce_count;
