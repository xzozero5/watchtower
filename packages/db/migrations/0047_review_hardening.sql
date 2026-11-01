-- T-202 security review fixes. Reversible: 0047_review_hardening.down.sql.
--
--   incident_comm.recipient_ticket_ids  the audience the person confirmed, kept at that moment. A send that is
--                                       resumed uses these tickets and no others, so a ticket linked after the
--                                       confirmation never gets the update unconfirmed. The CHECK now ties the
--                                       list to the count that was confirmed, not just "a sender exists".
--                                       Added NOT VALID: updates written before this migration (a snapshot they
--                                       never kept) are left as they are; every new write is checked.
--   users.discord_user_id               unique among the people who have one. The interactions endpoint maps a
--                                       Discord account to a user by this column; two users with the same id
--                                       could have had the press attributed to the wrong one, with the wrong
--                                       rights. If this fails on an existing database, two users share an id:
--                                       fix the data (clear one) and apply again.

ALTER TABLE incident_comm ADD COLUMN recipient_ticket_ids uuid[];
UPDATE incident_comm c
   SET recipient_ticket_ids = COALESCE(
     (SELECT array_agg(d.ticket_id) FROM incident_comm_delivery d WHERE d.comm_id = c.id), '{}')
 WHERE c.status IN ('sending', 'sent');

ALTER TABLE incident_comm DROP CONSTRAINT incident_comm_human_sends;
ALTER TABLE incident_comm ADD CONSTRAINT incident_comm_human_sends CHECK (
  status = 'cancelled'
  OR (
    (status IN ('sending', 'sent')) = (
      sent_by IS NOT NULL AND confirmed_recipients IS NOT NULL AND recipient_ticket_ids IS NOT NULL
      AND cardinality(recipient_ticket_ids) = confirmed_recipients
    )
    AND (status <> 'draft' OR (sent_by IS NULL AND confirmed_recipients IS NULL AND recipient_ticket_ids IS NULL))
  )
) NOT VALID;

CREATE UNIQUE INDEX users_discord_user_id_key ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;
