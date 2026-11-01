-- Reverts 0032. Lossy on purpose: notifications and preferences go away. Tickets and users are untouched.
DROP TABLE IF EXISTS notification_preference;
DROP TABLE IF EXISTS notification;
