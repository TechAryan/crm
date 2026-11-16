-- 005: file storage (for file/audio custom fields) + custom forms engine

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  data BYTEA NOT NULL,             -- stored in Postgres for simplicity; migrate to S3 at scale
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_tenant ON files (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  entity TEXT NOT NULL,            -- lead | opportunity  (where the form appears)
  definition JSONB NOT NULL DEFAULT '{"sections":[]}'::jsonb,
  -- definition: { sections: [{ title, items: [
  --   {kind:'subheading', text} |
  --   {kind:'field', source:'lead'|'opportunity'|'activity', schemaName, label, required,
  --    showIf?: {field, op:'eq'|'neq'|'notEmpty', value}} ] }],
  --   valueRules: [{ if:{field, op:'eq', value}, set:{field, value} }] }
  on_submit JSONB NOT NULL DEFAULT '{"action":"update_lead"}'::jsonb,
  -- on_submit: { action: 'update_lead'|'update_opportunity'|'post_activity', activityTypeId? }
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- RLS for the new tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['files','forms'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON files, forms TO crm_app;
