-- 012: Host-admin users/teams/permissions + admin audit, self-serve password reset,
-- per-tenant IP allowlist, per-customer cost/revenue ledger, export jobs.

-- ---------- Host admin: teams + granular permissions ----------
-- So you can give sales / tech / PS people admin-panel access with only the rights they need,
-- instead of everyone being an owner.
CREATE TABLE IF NOT EXISTS host_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  -- Default permissions inherited by members; a member's own permissions are merged on top.
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE host_users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES host_teams(id);
ALTER TABLE host_users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE host_users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE host_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE host_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE host_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Promote the existing owner(s) to super admin so nobody is locked out by this migration.
UPDATE host_users SET is_super_admin = true WHERE role = 'owner';

-- Seed the teams you described. Permissions are additive booleans, checked server-side.
INSERT INTO host_teams (name, description, permissions) VALUES
  ('Sales', 'Create tenants, see billing and usage, cannot change technical settings',
   '{"viewTenants":true,"createTenants":true,"viewBilling":true,"manageBilling":true,"viewUsage":true}'::jsonb),
  ('Tech', 'Technical operations: limits, entitlements, UI variants, retention',
   '{"viewTenants":true,"manageLimits":true,"manageEntitlements":true,"manageUiVariants":true,"manageRetention":true,"viewUsage":true,"loginAsTenant":true}'::jsonb),
  ('Support', 'Read-only plus tenant impersonation for troubleshooting',
   '{"viewTenants":true,"viewUsage":true,"loginAsTenant":true}'::jsonb),
  ('Billing', 'Money only',
   '{"viewTenants":true,"viewBilling":true,"manageBilling":true}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ---------- Host admin password reset (self-serve forgot password) ----------
CREATE TABLE IF NOT EXISTS host_password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id UUID NOT NULL REFERENCES host_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,             -- sha256 of the token; the raw token is never stored
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_host_resets_token ON host_password_resets (token_hash);

-- ---------- Per-tenant IP allowlist ----------
-- Empty array = no restriction (the default). Stored on tenants so the auth path can read it
-- in the same query it already makes.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ip_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ip_allowlist_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------- Cost / revenue ledger per customer ----------
-- The point: know whether each customer is actually profitable, not just that revenue exists.
CREATE TABLE IF NOT EXISTS tenant_ledger (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  entry_type TEXT NOT NULL,             -- cost | revenue
  category TEXT NOT NULL,               -- hosting | database | storage | messaging | support | subscription | setup | other
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  period_start DATE,
  period_end DATE,
  description TEXT,
  -- 'manual' = someone typed it; 'auto' = derived from measured usage
  source TEXT NOT NULL DEFAULT 'manual',
  invoice_ref TEXT,
  is_paid BOOLEAN NOT NULL DEFAULT true, -- for revenue: has the money actually arrived?
  paid_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON tenant_ledger (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON tenant_ledger (entry_type, category);

-- Cost model: the rates used to auto-derive per-tenant cost from measured usage. One row,
-- editable from the admin panel, so "what does a GB cost us" lives in one place.
CREATE TABLE IF NOT EXISTS cost_model (
  id INT PRIMARY KEY DEFAULT 1,
  currency TEXT NOT NULL DEFAULT 'INR',
  -- fixed monthly infrastructure spend, apportioned across active tenants
  fixed_monthly_infra NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_per_gb_storage NUMERIC(10,4) NOT NULL DEFAULT 0,
  cost_per_million_api_calls NUMERIC(10,4) NOT NULL DEFAULT 0,
  cost_per_1k_messages NUMERIC(10,4) NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cost_model_single_row CHECK (id = 1)
);
INSERT INTO cost_model (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------- Export jobs (data handback on churn / compliance) ----------
CREATE TABLE IF NOT EXISTS export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  requested_by UUID,
  scope TEXT NOT NULL DEFAULT 'full',   -- full | leads | opportunities | activities
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant ON export_jobs (tenant_id, created_at DESC);

-- ---------- Tenant flags for demo/trial ----------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- ---------- WhatsApp own-device mode ----------
-- No migration needed: it lives in connectors.config as { mode: 'own_device' }, because it
-- needs no credentials at all — we just build a deep link the user's own WhatsApp opens.

-- ---------- RLS ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['export_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON export_jobs TO crm_app;
-- Ledger/cost model/teams are control-plane: host admin writes, app reads nothing.
GRANT SELECT ON cost_model TO crm_app;
