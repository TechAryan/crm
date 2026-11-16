-- 004: custom fields on users (LSQ-style User Fields)
ALTER TABLE users ADD COLUMN IF NOT EXISTS fields JSONB NOT NULL DEFAULT '{}'::jsonb;
