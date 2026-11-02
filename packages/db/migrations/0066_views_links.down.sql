-- Reverts 0066. Lossy on purpose: saved views and ticket links go away; tickets and their events are
-- untouched (the `ticket.linked` / `ticket.unlinked` events stay in the history).
DROP TABLE IF EXISTS ticket_link;
DROP TABLE IF EXISTS saved_view;
