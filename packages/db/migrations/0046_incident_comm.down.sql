-- Reverts 0046. Lossy on purpose: the drafted and sent updates and their per-ticket delivery records go
-- away. The messages already sent to customers are ordinary ticket messages and stay.
DROP TABLE IF EXISTS incident_comm_delivery;
DROP TABLE IF EXISTS incident_comm;
