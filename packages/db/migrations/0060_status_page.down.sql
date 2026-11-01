-- Reverts 0060. Lossy on purpose: components, posts, maintenance windows, subscriptions and the record of
-- who was told what go away. Incidents and services are untouched.
DROP TABLE IF EXISTS status_notification;
DROP TABLE IF EXISTS status_subscription;
DROP TABLE IF EXISTS status_maintenance_component;
DROP TABLE IF EXISTS status_maintenance;
DROP TABLE IF EXISTS status_post_component;
DROP TABLE IF EXISTS status_post;
DROP TABLE IF EXISTS status_component;
