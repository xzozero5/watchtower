-- Reverts 0114. Lossy on purpose: the ratings go away (they are a measure, not a record; the audit log keeps who rated what).
DROP TABLE IF EXISTS assistant_feedback;
