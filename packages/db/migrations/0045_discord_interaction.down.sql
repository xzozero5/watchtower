-- Reverts 0045. Lossy on purpose: the record of handled interaction ids goes away, so a replay of an
-- old interaction would be handled again (acknowledging an alert twice is harmless: the first press wins).
DROP TABLE IF EXISTS discord_interaction;
