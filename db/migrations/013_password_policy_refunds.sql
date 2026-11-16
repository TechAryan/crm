-- 013: Two-mechanism password reset policy, refunds/partial payments.

-- ---------- Password reset policy per tenant ----------
-- MECHANISM 1 (default, 'internal'): NO external dependency at all.
--   * A tenant admin can reset any user's password.
--   * A manager can reset passwords for users below them in the hierarchy.
--   * A logged-in user changes their own password.
--   * Reset produces either a one-time link or a temporary password the resetter passes on.
--   This is the default because requiring a customer to buy an email provider just to have
--   forgot-password is an unreasonable barrier to purchase.
--
-- MECHANISM 2 ('email'): self-serve "forgot password" via email, available only once the tenant
--   has connected an email provider. Switchable back to 'internal' with one setting change, so a
--   provider outage or a billing problem at their provider can never lock a customer out.
UPDATE tenants
SET settings = settings || jsonb_build_object(
  'passwordResetMode', COALESCE(settings->>'passwordResetMode', 'internal'),
  -- When true, a manager may reset passwords for their reports (not just tenant admins).
  'allowManagerPasswordReset', COALESCE(settings->'allowManagerPasswordReset', 'true'::jsonb)
)
WHERE settings->>'passwordResetMode' IS NULL;

-- ---------- Refunds and partial payments ----------
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS amount_refunded NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
-- A single link can receive several payments (installments) and several refunds, so events are
-- rows rather than columns on the link. This is also the audit trail if a customer disputes.
CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  payment_link_id UUID NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,            -- paid | partially_paid | refunded | partially_refunded | failed
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  provider_event_id TEXT,              -- for idempotency: the provider's own event id
  provider_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_events_link ON payment_events (tenant_id, payment_link_id, created_at DESC);
-- Providers redeliver; the same provider event must never be applied twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_id
  ON payment_events (payment_link_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

-- 'partially_paid' becomes a legal status now that installments are supported.
-- (status remains free-text so no constraint change is needed.)

DO $$
BEGIN
  EXECUTE 'ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE payment_events FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON payment_events';
  EXECUTE 'CREATE POLICY tenant_isolation ON payment_events USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_events TO crm_app;
GRANT USAGE, SELECT ON SEQUENCE payment_events_id_seq TO crm_app;
