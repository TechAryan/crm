-- 010: Per-tenant API rate limiting & quota, realtime/telephony support, provider connectors
-- with encrypted credentials, messaging templates + log, embedded widgets, per-tenant UI version.

-- ---------- Per-tenant API limits (overrides the plan) ----------
-- Plans already carry api_rate_per_sec / api_daily_quota but nothing enforced them.
-- These per-tenant overrides are what the host admin panel raises when a customer pays for more.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_rate_override INT;      -- calls per burst window
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_burst_seconds INT;      -- window size, default 5
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_daily_quota_override INT;

-- ---------- Per-tenant UI version (safe UI rollout) ----------
-- Lets us ship a new UI to a test tenant, then opt customers in one at a time while
-- everyone else keeps the current view. Never fork code per tenant — switch on this instead.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ui_version INT NOT NULL DEFAULT 1;

-- ---------- Burst rate buckets (multi-process safe) ----------
-- A single atomic UPSERT per request keeps counting correct across API instances, which an
-- in-memory limiter cannot do. Old rows are swept periodically.
CREATE TABLE IF NOT EXISTS api_rate_buckets (
  tenant_id UUID NOT NULL,
  window_start BIGINT NOT NULL,          -- epoch seconds, floored to the window size
  calls INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_buckets_window ON api_rate_buckets (window_start);

-- ---------- Provider connectors: encrypted credentials ----------
-- Customers bring their OWN third-party accounts (Gupshup, Twilio, Razorpay, an SMTP relay,
-- their own Meta app). We store those credentials encrypted (AES-256-GCM) and never return
-- them in API responses.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS secrets_encrypted TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS provider TEXT;      -- gupshup | twilio | smtp_http | razorpay | custom | ameyo | exotel …
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS channel TEXT;       -- email | sms | whatsapp | telephony | payment | leadsync
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- ---------- Message templates (mail-merge bodies for email/SMS/WhatsApp) ----------
CREATE TABLE IF NOT EXISTS message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,                  -- email | sms | whatsapp
  subject TEXT,                           -- email only
  body TEXT NOT NULL,                     -- supports {{merge.tokens}}
  provider_template_id TEXT,              -- WhatsApp requires pre-approved template ids
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- ---------- Message log (what was sent, to whom, and what the provider said) ----------
CREATE TABLE IF NOT EXISTS message_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  connector_id UUID,
  channel TEXT NOT NULL,
  to_address TEXT NOT NULL,
  template_id UUID,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
  provider_message_id TEXT,
  provider_response TEXT,
  error TEXT,
  lead_id UUID,
  opportunity_id UUID,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_log_tenant ON message_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_log_lead ON message_log (tenant_id, lead_id);

-- ---------- Embedded widgets (iframe / custom HTML) ----------
-- The escape hatch for per-tenant UI: point at any third-party page (landing page builder,
-- BI dashboard, internal tool) or paste sanitized HTML, and place it on a record page or in
-- the main menu. Merge tokens in the URL pass record context through.
CREATE TABLE IF NOT EXISTS embedded_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'iframe',    -- iframe | html
  placement TEXT NOT NULL,                -- lead_tab | lead_sidebar | opportunity_tab | opportunity_sidebar | main_menu | dashboard
  url_template TEXT,                      -- for kind=iframe; supports merge tokens
  html_content TEXT,                      -- for kind=html; sanitized before render
  height INT NOT NULL DEFAULT 520,
  icon TEXT,
  required_permission TEXT,
  sort_order INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_widgets_tenant ON embedded_widgets (tenant_id, placement) WHERE is_active;

-- ---------- Screen-pop events (telephony) ----------
-- Persisted so a call that arrives while the agent has no open session isn't lost, and so
-- delivery is auditable. Realtime push happens via Postgres NOTIFY; this is the record.
CREATE TABLE IF NOT EXISTS realtime_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL,                     -- screenpop | notification
  payload JSONB NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_realtime_events_user ON realtime_events (tenant_id, user_id, created_at DESC);

-- ---------- Performance indexes for the hot query paths ----------
-- These matter at 100k+ leads per tenant; without them the list/filter/report paths degrade
-- into sequential scans.
CREATE INDEX IF NOT EXISTS idx_leads_tenant_owner ON leads (tenant_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads (tenant_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_email_lower ON leads (tenant_id, lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_fields_gin ON leads USING gin (fields);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities (tenant_id, lead_id, activity_time DESC);
CREATE INDEX IF NOT EXISTS idx_activities_performer ON activities (tenant_id, performed_by);
CREATE INDEX IF NOT EXISTS idx_opportunities_lead ON opportunities (tenant_id, lead_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities (tenant_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks (tenant_id, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_lead ON tasks (tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (tenant_id, entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users (tenant_id, manager_id);

-- ---------- RLS for the new tenant-scoped tables ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates','message_log','embedded_widgets','realtime_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON message_templates, message_log, embedded_widgets, realtime_events TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE message_log_id_seq TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE realtime_events_id_seq TO crm_app;
-- Control-plane tables the app must touch for quota accounting.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_rate_buckets TO crm_app;
GRANT SELECT, INSERT, UPDATE ON api_usage_daily TO crm_app;
