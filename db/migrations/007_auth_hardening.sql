-- 007: forced password change, TOTP 2FA, admin-generated set-password links

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[];

CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (tenant_id, user_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE password_resets FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON password_resets';
  EXECUTE 'CREATE POLICY tenant_isolation ON password_resets USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())';
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO crm_app;
