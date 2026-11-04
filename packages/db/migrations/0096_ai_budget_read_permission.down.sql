-- Reverts 0096. role_permissions rows go with the permission (ON DELETE CASCADE), including any grant a head
-- added by hand for this string.
DELETE FROM permissions WHERE key = 'ai.budget.read';
