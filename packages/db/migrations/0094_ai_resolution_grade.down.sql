-- Reverts 0094. Lossy on purpose: the grades go away (the ai_run rows of the grader's calls stay).
DROP TABLE IF EXISTS ai_resolution_grade;
