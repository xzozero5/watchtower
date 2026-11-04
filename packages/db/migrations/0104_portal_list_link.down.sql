-- Reverts 0104. Lossy on purpose: every "my requests" link already emailed stops working (they live 30
-- minutes anyway; customers ask again once the migration is applied again).
DROP TABLE IF EXISTS portal_list_link;
