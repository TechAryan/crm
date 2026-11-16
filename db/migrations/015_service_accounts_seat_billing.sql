-- 015: distinguish service accounts from people, so seat billing can be enforced correctly.
--
-- BACKGROUND
-- `plans.max_users` was sold against from the first plan definition but never enforced: a tenant
-- on a 10-seat plan could create 500 users. Enforcing it requires answering "which users consume
-- a paid seat?", and the existing `users.is_system` flag could not answer it.
--
-- `is_system` means "cannot be deleted or deactivated". It is true for BOTH:
--   * the tenant Admin — a real person, the business owner, who must consume a seat; and
--   * the per-tenant System user (<tenant-code>@nextcrm.com) — a placeholder used as the default
--     owner of unassigned records. Nobody logs in as it. It must NOT consume a seat.
--
-- Counting `NOT is_system` gave every customer a free admin seat. Counting all users would bill
-- them for a robot. Neither is defensible to a customer, so the two concepts are separated here:
-- `is_system` stays "undeletable", and `is_service_account` means "not a person, never billed".
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the System user is identified by its System role, which provisioning creates per
-- tenant. Matching on the role rather than the email pattern keeps this correct even if the
-- address format changes later.
UPDATE users u
   SET is_service_account = true
  FROM roles r
 WHERE u.role_id = r.id
   AND r.name = 'System'
   AND r.is_system = true
   AND u.is_service_account = false;

-- Seat counts run on every user creation, so keep them cheap.
CREATE INDEX IF NOT EXISTS idx_users_tenant_billable
  ON users (tenant_id)
  WHERE is_active AND is_service_account = false;
