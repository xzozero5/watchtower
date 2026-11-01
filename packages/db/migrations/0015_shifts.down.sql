-- Reverts 0015. Lossy on purpose: rosters, clock records, handoffs and shift notes go away. A queue
-- on `load_balanced` or `stay_with_last_handler` becomes `round_robin`, the nearest mode the older
-- CHECK accepts. Apply the migration again to resume.
DROP TABLE IF EXISTS shift_note_read;
DROP TABLE IF EXISTS shift_note;
DROP TABLE IF EXISTS handoff_item;
DROP TABLE IF EXISTS handoff;
DROP TABLE IF EXISTS shift_session;
DROP TABLE IF EXISTS roster_entry;
DROP TABLE IF EXISTS shift_definition;

UPDATE team_queue SET assignment_mode = 'round_robin'
 WHERE assignment_mode IN ('load_balanced', 'stay_with_last_handler');
ALTER TABLE team_queue DROP CONSTRAINT team_queue_mode_check;
ALTER TABLE team_queue ADD CONSTRAINT team_queue_mode_check CHECK (assignment_mode IN ('manual', 'round_robin'));
