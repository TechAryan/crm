-- ============================================================
-- 001: Control plane (provider-level, NOT tenant-scoped)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,             -- starter | pro | enterprise
  name TEXT NOT NULL,
  max_users INT NOT NULL DEFAULT 10,
  api_daily_quota INT NOT NULL DEFAULT 50000,
  api_rate_per_sec INT NOT NULL DEFAULT 10,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,             -- short unique tenant id e.g. t-8FK2Q
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE NOT NULL,
  plan_id UUID REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended | deleted
  is_test BOOLEAN NOT NULL DEFAULT false,
  branding JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {logoUrl, primaryColor, appName}
  region TEXT NOT NULL DEFAULT 'in',
  partner_id UUID,                       -- reseller who owns this tenant
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_email TEXT,
  branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS host_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'support',  -- owner | support | billing | partner
  partner_id UUID REFERENCES partners(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS host_audit_log (
  id BIGSERIAL PRIMARY KEY,
  host_user_id UUID,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_usage_daily (
  tenant_id UUID NOT NULL,
  day DATE NOT NULL,
  calls INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
