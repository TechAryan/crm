-- 008: system user protection, manager hierarchy, tenant-level settings, additional phone,
-- system field-def rows, telephony system activity types.

-- ---------- tenants: tenant-wide behavioural settings ----------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{
  "defaultOwnerMode": "system",
  "defaultOwnerUserId": null,
  "defaultOwnerFieldRules": [],
  "cascadeOwnerToOpportunity": true,
  "cascadeOwnerToTask": true,
  "hierarchyVisibility": true,
  "phoneClickAction": "tel",
  "phoneClickUrlTemplate": null,
  "leadPropertiesLayout": ["phone", "additional_phone", "email", "owner", "source", "score"]
}'::jsonb;

-- ---------- users: system-user protection + manager hierarchy ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS additional_phone TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_manager'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users(id);
  END IF;
END $$;

-- ---------- leads: additional phone ----------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS additional_phone TEXT;

-- ---------- custom_field_defs: system field rows (built-in columns, renameable/hideable, not deletable) ----------
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS is_deletable BOOLEAN NOT NULL DEFAULT true;
-- system rows use plain (non mx_) schema names matching the real DB column, so the app can
-- look up "what label/visibility should I use for the built-in `phone` column" the same way
-- it already looks up custom fields.
