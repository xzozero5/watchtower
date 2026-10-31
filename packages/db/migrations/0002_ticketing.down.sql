-- Reverts 0002. Drops every ticket, message and event: use on a development database, or after
-- exporting. ticket_event is append-only for the application; dropping the table is the one way to
-- remove its rows, as with audit_log in 0001.
DELETE FROM permissions WHERE key IN ('queue.manage', 'intent.manage', 'workflow.manage');

-- Client users belong to organizations that are about to disappear, and up would not be able to
-- restore the users.org_id foreign key over dangling ids. Their sessions and tokens go with them
-- (ON DELETE CASCADE). Staff accounts are untouched.
DELETE FROM users WHERE role = 'client';

DROP TABLE IF EXISTS ticket_event CASCADE;
DROP TABLE IF EXISTS message;
DROP TABLE IF EXISTS ticket;
DROP FUNCTION IF EXISTS ticket_reject_parent_cycle();
DROP SEQUENCE IF EXISTS ticket_number_seq;
DROP TABLE IF EXISTS ticket_status_transition;
DROP TABLE IF EXISTS intent;
DROP TABLE IF EXISTS channel_account;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_id_fkey;
ALTER TABLE organization DROP CONSTRAINT IF EXISTS organization_primary_contact_fkey;
DROP TABLE IF EXISTS contact;
DROP TABLE IF EXISTS organization;
DROP TABLE IF EXISTS team_queue_member;
DROP TABLE IF EXISTS team_queue;
DROP TABLE IF EXISTS sla_policy;
DROP TABLE IF EXISTS business_calendar;

DROP FUNCTION IF EXISTS enforce_unique_array_elements();
DROP FUNCTION IF EXISTS is_normalized_text_array(text[]);
