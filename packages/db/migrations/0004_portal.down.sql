-- Reverts 0004. Lossy on purpose: every tracking link already emailed stops working (customers ask
-- for a new one by email once the migration is applied again).
DROP TABLE IF EXISTS portal_access_token;
