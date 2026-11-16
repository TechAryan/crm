-- ============================================================
-- 002: Tenant-scoped tables (every table has tenant_id + RLS)
-- ============================================================

-- ---------- Users, roles, permissions ----------
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  record_scope TEXT NOT NULL DEFAULT 'own',   -- own | team | all
  is_system BOOLEAN NOT NULL DEFAULT false,   -- seeded roles
  ui_policy JSONB NOT NULL DEFAULT '{}'::jsonb, -- {hiddenTabs:[], hiddenSections:[], hiddenFields:[]}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- permissions JSON shape:
-- { "lead": {"view":"all","create":true,"edit":"own","delete":false,"import":true,"export":false,
--            "fieldRules":{"hidden":["mx_budget"],"readonly":[]}},
--   "activity": {...}, "opportunity": {...}, "task": {...}, "user": {...},
--   "settings": {"manageFields":true,"manageRoles":false,"manageAutomation":false,
--                "manageWebhooks":false,"manageConnectors":false,"manageDistribution":false},
--   "reports": {"view": true} }
CREATE TABLE IF NOT EXISTS permission_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  manager_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role_id UUID REFERENCES roles(id),
  team_id UUID REFERENCES teams(id),
  manager_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_checked_in BOOLEAN NOT NULL DEFAULT true,   -- availability for routing
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS user_permission_sets (
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_set_id UUID NOT NULL REFERENCES permission_sets(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, permission_set_id)
);

CREATE TABLE IF NOT EXISTS role_permission_sets (
  tenant_id UUID NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_set_id UUID NOT NULL REFERENCES permission_sets(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_set_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  key_id TEXT UNIQUE NOT NULL,            -- public part: nx_k_...
  secret_hash TEXT NOT NULL,              -- hashed secret
  scopes TEXT[] NOT NULL DEFAULT '{}',    -- leads:read, leads:write, leads:delete, ...
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Customization metadata ----------
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entity TEXT NOT NULL,                   -- lead | opportunity | activity_type:<uuid> | task
  schema_name TEXT NOT NULL,              -- mx_city_tier (immutable)
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,               -- text|textarea|number|currency|email|phone|url|date|datetime|boolean|dropdown|multiselect
  options JSONB,                          -- ["A","B"] for dropdowns
  is_mandatory BOOLEAN NOT NULL DEFAULT false,
  is_unique BOOLEAN NOT NULL DEFAULT false,
  section TEXT DEFAULT 'Details',
  sort_order INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, schema_name)
);

CREATE TABLE IF NOT EXISTS lead_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_active_stage BOOLEAN NOT NULL DEFAULT true,  -- Active vs Inactive class
  sort_order INT NOT NULL DEFAULT 100,
  is_default BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS lead_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS activity_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  direction INT NOT NULL DEFAULT 0,       -- 0 inbound | 1 outbound
  score INT NOT NULL DEFAULT 0,           -- contributes to lead score (+/-)
  is_system BOOLEAN NOT NULL DEFAULT false,
  allow_attachments BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS opportunity_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  stages JSONB NOT NULL DEFAULT '[{"name":"Qualification","status":"Open"},{"name":"Proposal","status":"Open"},{"name":"Negotiation","status":"Open"},{"name":"Closed Won","status":"Won"},{"name":"Closed Lost","status":"Lost"}]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);

-- ---------- Core CRM entities ----------
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  lead_number BIGINT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  stage_id UUID REFERENCES lead_stages(id),
  source_id UUID REFERENCES lead_sources(id),
  sub_source TEXT,
  owner_id UUID REFERENCES users(id),
  score INT NOT NULL DEFAULT 0,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,   -- custom field values keyed by schema_name
  utm JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_number)
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_email ON leads (tenant_id, lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_owner ON leads (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads (tenant_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_fields_gin ON leads USING gin (fields);

CREATE SEQUENCE IF NOT EXISTS lead_number_seq;  -- per-tenant numbering handled in app via MAX+1 under advisory lock; global seq fallback

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  opportunity_id UUID,
  activity_type_id UUID NOT NULL REFERENCES activity_types(id),
  note TEXT,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  activity_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  performed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_lead ON activities (tenant_id, lead_id, activity_time DESC);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_type ON activities (tenant_id, activity_type_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  opportunity_type_id UUID NOT NULL REFERENCES opportunity_types(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',    -- Open | Won | Lost
  stage TEXT NOT NULL,
  amount NUMERIC(14,2) DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  expected_close DATE,
  owner_id UUID REFERENCES users(id),
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opps_tenant_lead ON opportunities (tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_opps_tenant_status ON opportunities (tenant_id, status, stage);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  kind TEXT NOT NULL DEFAULT 'todo',      -- todo | appointment
  name TEXT NOT NULL,
  description TEXT,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id),
  due_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open',    -- open | done | cancelled
  completed_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_owner ON tasks (tenant_id, owner_id, status, due_at);

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Distribution ----------
CREATE TABLE IF NOT EXISTS distribution_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100,      -- lower = evaluated first
  is_active BOOLEAN NOT NULL DEFAULT true,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{"field":"fields.mx_city","op":"eq","value":"Mumbai"}, {"field":"source","op":"in","value":["WhatsApp"]}]
  strategy TEXT NOT NULL DEFAULT 'round_robin', -- fixed_user | fixed_team | round_robin | weighted_round_robin | least_open
  strategy_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- fixed_user: {userId} | round_robin: {userIds:[...]} | weighted: {weights:{userId:3,...}} | least_open: {userIds:[...]}
  rr_cursor INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Webhooks (outbound) ----------
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,                 -- lead.created, lead.stage_changed, activity.created, ...
  secret TEXT NOT NULL,                   -- HMAC key
  custom_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"changedField":"mx_city"}
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_response_code INT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_pending ON webhook_deliveries (status, next_attempt_at) WHERE status = 'pending';

-- ---------- Connectors ----------
CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  type TEXT NOT NULL,                     -- whatsapp | meta | webform
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- webform: {formId, fieldMap:{...}, defaultOwnerId} ; whatsapp: {phoneNumberId, token} ; meta: {pageId, formMap}
  public_token TEXT UNIQUE,               -- for inbound URLs
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Imports ----------
CREATE TABLE IF NOT EXISTS import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'processing', -- processing | done | failed
  total_rows INT DEFAULT 0,
  created_count INT DEFAULT 0,
  updated_count INT DEFAULT 0,
  error_count INT DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{row:2, error:"..."}]
  dedupe_mode TEXT NOT NULL DEFAULT 'update', -- skip | update | create
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Audit ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor_id UUID,
  actor_type TEXT NOT NULL DEFAULT 'user',   -- user | api_key | system | host_admin
  action TEXT NOT NULL,                      -- lead.created, lead.updated, ...
  entity TEXT NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_entity ON audit_log (tenant_id, entity, entity_id);
