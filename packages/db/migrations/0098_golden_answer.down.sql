-- Reverts 0098. Lossy on purpose: the golden answers go away. The permission rows go with them.
DROP TABLE IF EXISTS golden_answer;
DELETE FROM role_permissions WHERE permission = 'ai.golden.manage';
DELETE FROM permissions WHERE key = 'ai.golden.manage';
