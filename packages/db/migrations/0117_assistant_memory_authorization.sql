-- ADR-034: legacy rows remain unknown; never infer their old authorization.
ALTER TABLE assistant_memory ADD COLUMN "authorization" jsonb;
