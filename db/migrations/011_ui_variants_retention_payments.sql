-- 011: Named UI variants (branch/clone/rename), audit + API-log retention,
-- API request logging, payment links.

-- ---------- Named UI variants ----------
-- Replaces the simple integer ui_version with named, branchable variants so you can:
--   * keep "Classic" running for customers who don't want change,
--   * roll "2026 Refresh" out to those who opted in,
--   * branch a THIRD variant from Classic (not from the newest), tweak it, and move a few
--     customers onto that — without touching either existing group.
-- The integer column stays as a fallback/back-compat signal for older clients.
CREATE TABLE IF NOT EXISTS ui_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,              -- stable machine key the frontend switches on, e.g. 'classic'
  name TEXT NOT NULL,                    -- human label shown in the admin panel
  description TEXT,
  -- which variant this was branched from (lineage, so you can see UI3 came from UI1)
  parent_id UUID REFERENCES ui_variants(id),
  -- feature/layout flags for this variant; the frontend reads these to decide what to render
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | testing | released | deprecated
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ui_variants (key, name, description, status, is_default, config)
VALUES ('classic', 'Classic', 'The original interface. Safe default for existing customers.', 'released', true, '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ui_variant_id UUID REFERENCES ui_variants(id);
UPDATE tenants SET ui_variant_id = (SELECT id FROM ui_variants WHERE key='classic')
WHERE ui_variant_id IS NULL;

-- ---------- API request/response logging ----------
-- Default 7-day retention (configurable, and billable — see tenants.settings.retention).
-- Bodies are truncated and redacted before storage: this is a debugging aid, not a data lake,
-- and storing full request bodies forever would be both a cost and a privacy problem.
CREATE TABLE IF NOT EXISTS api_request_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INT,
  duration_ms INT,
  actor_id UUID,
  actor_type TEXT,
  api_key_id UUID,                       -- set when the caller was an integration
  ip TEXT,
  user_agent TEXT,
  request_body TEXT,                     -- redacted + truncated
  response_body TEXT,                    -- truncated; only kept for errors by default
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_log_tenant_time ON api_request_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_log_status ON api_request_log (tenant_id, status_code, created_at DESC);
-- Retention sweeps delete by age; this index keeps the purge cheap.
CREATE INDEX IF NOT EXISTS idx_api_log_created ON api_request_log (created_at);

-- ---------- Payment links ----------
-- The tenant connects THEIR OWN payment provider (Razorpay/Stripe/custom). We generate a link,
-- optionally send it via their messaging connector, and mark it paid from the provider webhook.
-- We never see or store card data — the link is hosted by the provider.
CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  connector_id UUID,
  lead_id UUID,
  opportunity_id UUID,
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  description TEXT,
  provider TEXT,                          -- razorpay | stripe | custom
  provider_link_id TEXT,                  -- provider's id, used to match webhooks
  url TEXT,                               -- the hosted checkout URL we hand to the customer
  status TEXT NOT NULL DEFAULT 'created', -- created | sent | paid | failed | expired | cancelled
  paid_at TIMESTAMPTZ,
  paid_amount NUMERIC(14,2),
  provider_payload JSONB,                 -- last webhook payload, for audit
  reference TEXT,                         -- our correlation id, echoed back by the provider
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_links_tenant ON payment_links (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_lead ON payment_links (tenant_id, lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_reference ON payment_links (reference) WHERE reference IS NOT NULL;
-- Webhook lookup happens BEFORE we know the tenant, so it must be indexed globally.
CREATE INDEX IF NOT EXISTS idx_payment_links_provider_id ON payment_links (provider_link_id) WHERE provider_link_id IS NOT NULL;

-- ---------- Retention defaults on tenants.settings ----------
-- Kept in settings (JSONB) so the host admin can raise limits per tenant as a paid upgrade.
--   recordAuditDays: null = keep forever (the compliance-sensitive trail)
--   settingsAuditDays: 7 default
--   apiLogDays: 7 default
UPDATE tenants
SET settings = settings || jsonb_build_object(
  'retention', COALESCE(settings->'retention', jsonb_build_object(
    'recordAuditDays', NULL,
    'settingsAuditDays', 7,
    'apiLogDays', 7,
    'messageLogDays', 90,
    'automationLogDays', 30,
    'outboundCallLogDays', 30
  ))
)
WHERE settings->'retention' IS NULL;

-- Audit log purge index (retention sweeps filter by tenant + age + category).
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_action ON audit_log (tenant_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_exec_created ON automation_executions (created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_calls_created ON outbound_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_message_log_created ON message_log (created_at);

-- ---------- RLS ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_request_log','payment_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_request_log, payment_links TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE api_request_log_id_seq TO crm_app;
-- ui_variants is control-plane (host admin manages it); the app only reads.
GRANT SELECT ON ui_variants TO crm_app;
