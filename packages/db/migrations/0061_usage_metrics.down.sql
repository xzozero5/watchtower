-- Reverts 0061. Lossy on purpose: metric definitions and every cached point (all monthly partitions) go away.
-- The product data they were read from is untouched.
DROP TABLE IF EXISTS usage_metric_point CASCADE;
DROP TABLE IF EXISTS usage_metric_def;
DROP FUNCTION IF EXISTS usage_dims_valid(text[]);
