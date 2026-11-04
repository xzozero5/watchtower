-- Reverts 0109: the replay results and the reported model id are dropped (the gate then has no replay, which
-- suspends auto-send: the safe direction).
DROP FUNCTION public.record_replay_result(uuid, uuid, text, text, text, integer, integer, uuid, integer, integer, boolean, boolean);
DROP TABLE ai_replay_result;
ALTER TABLE ai_run DROP CONSTRAINT ai_run_response_model_check;
ALTER TABLE ai_run DROP COLUMN response_model;
DELETE FROM instance_setting WHERE key = 'autosend.sampling';
ALTER TABLE instance_setting DROP CONSTRAINT instance_setting_autosend_sampling_check;
