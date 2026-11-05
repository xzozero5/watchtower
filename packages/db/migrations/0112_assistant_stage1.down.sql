-- Reverts 0112. Lossy on purpose: pinned memories and the evidence/path of old turns go away. role_permissions
-- rows go with the permission (ON DELETE CASCADE), including any grant a head added by hand for this string.
DELETE FROM permissions WHERE key = 'assistant.use';
ALTER TABLE assistant_message
  DROP CONSTRAINT assistant_message_path_check,
  DROP COLUMN path,
  DROP COLUMN evidence;
DROP TABLE assistant_memory;
