-- Reverts 0031. Lossy on purpose: the CSAT survey ledger, the opt-outs and the delay setting go away.
-- The score already copied to ticket.csat_score stays; tickets are untouched.
DELETE FROM instance_setting WHERE key = 'csat.delay_minutes';
ALTER TABLE instance_setting DROP CONSTRAINT IF EXISTS instance_setting_csat_delay_check;
DROP TABLE IF EXISTS csat_org_opt_out;
DROP TABLE IF EXISTS csat_survey;
