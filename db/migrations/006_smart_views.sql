-- 006: Saved "Smart Views" (per-user or shared saved filters + column sets for a grid)

CREATE TABLE IF NOT EXISTS smart_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entity TEXT NOT NULL,                 -- lead | opportunity (which grid it applies to)
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '[]'::jsonb,   -- same shape as leads list ?filters
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ordered array of column keys
  is_shared BOOLEAN NOT NULL DEFAULT false,     -- visible to the whole tenant vs just owner
  owner_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, name, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_smart_views_tenant ON smart_views (tenant_id, entity);

-- RLS: tenant isolation (visibility of shared-vs-own enforced in app layer)
DO $$
BEGIN
  EXECUTE 'ALTER TABLE smart_views ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE smart_views FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON smart_views';
  EXECUTE 'CREATE POLICY tenant_isolation ON smart_views USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())';
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON smart_views TO crm_app;
