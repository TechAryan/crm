-- 009: Automation engine, custom action buttons, tenant entitlements (paid feature gating),
-- API-sourced dropdown options, and channel-aware field write policy support.

-- ---------- Custom action buttons ----------
-- Admin-defined buttons that appear on lead/opportunity/activity detail pages and, on click,
-- make a server-side HTTP call built from record data via {{mail merge}} tokens.
CREATE TABLE IF NOT EXISTS custom_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  entity TEXT NOT NULL,                          -- lead | opportunity | activity
  placement TEXT NOT NULL DEFAULT 'detail_header', -- detail_header | detail_sidebar | list_row
  method TEXT NOT NULL DEFAULT 'POST',           -- GET | POST | PUT | PATCH | DELETE
  url_template TEXT NOT NULL,                    -- https://api.x.com/call?to={{lead.phone}}
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,    -- values may contain merge tokens
  body_template TEXT,                            -- raw string; merge tokens substituted then parsed
  confirm_text TEXT,                             -- if set, UI asks for confirmation first
  success_message TEXT,
  -- optional visibility condition, same {field, op, value} shape as distribution rules
  visible_when JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_permission TEXT,                      -- e.g. 'manageRoles'; null = any user who can view the record
  open_url_in_new_tab BOOLEAN NOT NULL DEFAULT false, -- if true, don't call server-side; just open merged URL
  sort_order INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, name)
);
CREATE INDEX IF NOT EXISTS idx_custom_actions_tenant ON custom_actions (tenant_id, entity) WHERE is_active;

-- ---------- Automation rules ----------
-- trigger: { entity, event, activityTypeId?, field?, toValue?, fromValue? }
--   entity: lead | opportunity | activity | task
--   event : created | updated | field_changed | stage_changed | deleted
-- conditions: [{ field, op, value }] evaluated against the record (after-state)
-- actions:  [{ type, ...config }]
--   type: update_lead | update_opportunity | create_task | create_activity |
--         create_opportunity | http_call | reassign_owner
CREATE TABLE IF NOT EXISTS automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger JSONB NOT NULL,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INT NOT NULL DEFAULT 100,
  -- loop protection: max times this rule may run against the same record
  max_executions_per_record INT NOT NULL DEFAULT 25,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant ON automation_rules (tenant_id) WHERE is_active;

-- Execution log — essential for debugging automations (per-step outcome, not just pass/fail).
CREATE TABLE IF NOT EXISTS automation_executions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id UUID,
  status TEXT NOT NULL,                          -- success | partial | failed | skipped
  trigger_event TEXT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{action, status, detail}]
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_exec_rule ON automation_executions (tenant_id, rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_exec_record ON automation_executions (tenant_id, entity, entity_id);

-- ---------- Outbound HTTP call log (custom actions + automation http_call) ----------
-- Every server-side outbound call is recorded: this is both an audit trail and the thing that
-- makes "why didn't my integration fire?" answerable.
CREATE TABLE IF NOT EXISTS outbound_calls (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  source TEXT NOT NULL,                          -- custom_action | automation | field_options
  source_id UUID,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request_body TEXT,
  response_code INT,
  response_body TEXT,
  error TEXT,
  duration_ms INT,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbound_calls_tenant ON outbound_calls (tenant_id, created_at DESC);

-- ---------- API-sourced dropdown options ----------
-- options_source: 'static' (use options JSONB) | 'api' (fetch from options_api config)
-- options_api: { url, method, headers, jsonPath, labelKey, valueKey, cacheTtlSeconds }
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS options_source TEXT NOT NULL DEFAULT 'static';
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS options_api JSONB;

-- ---------- Tenant entitlements (paid feature gating) ----------
-- Resolution order: tenant override (here) > plan features > registry default.
-- Paid connectors/features stay VISIBLE but locked in the UI, and are enforced server-side.
CREATE TABLE IF NOT EXISTS tenant_entitlements (
  tenant_id UUID NOT NULL,
  feature TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature)
);

-- ---------- RLS for the new tenant-scoped tables ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'custom_actions','automation_rules','automation_executions','outbound_calls'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_actions, automation_rules, automation_executions, outbound_calls TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE automation_executions_id_seq TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE outbound_calls_id_seq TO crm_app;
-- tenant_entitlements is control-plane (managed by host admin), read by the app: no RLS,
-- always queried with an explicit tenant_id filter via the control pool.
GRANT SELECT ON tenant_entitlements TO crm_app;
