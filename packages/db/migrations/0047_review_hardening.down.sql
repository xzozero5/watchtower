-- Reverts 0047: the audience snapshot is dropped (a resumed send would recompute the audience again) and
-- a Discord account may again be linked to more than one user.
DROP INDEX IF EXISTS users_discord_user_id_key;
ALTER TABLE incident_comm DROP CONSTRAINT incident_comm_human_sends;
ALTER TABLE incident_comm ADD CONSTRAINT incident_comm_human_sends CHECK (
  status = 'cancelled'
  OR (
    (status IN ('sending', 'sent')) = (sent_by IS NOT NULL AND confirmed_recipients IS NOT NULL)
    AND (status <> 'draft' OR (sent_by IS NULL AND confirmed_recipients IS NULL))
  )
);
ALTER TABLE incident_comm DROP COLUMN recipient_ticket_ids;
