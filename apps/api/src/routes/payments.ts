import { Router } from 'express';
import crypto from 'node:crypto';
import { withTenant, bypassRLS } from '../db.js';
import { err, sendError, randToken } from '../util.js';
import { audit } from '../audit.js';
import { requireFeature } from '../entitlements.js';
import { safeHttpCall } from '../http.js';
import { encryptSecrets, decryptSecrets, maskSecrets, encryptionAvailable } from '../crypto.js';
import { mergeString, buildMergeContext } from '../merge.js';
import { sendMessage, defaultConnectorFor, type Channel } from '../messaging.js';
import { runAutomations } from '../automation.js';
import { resolveVisibleOwnerIds } from '../permissions.js';

/**
 * Payments — the tenant connects THEIR OWN payment provider and we generate hosted checkout
 * links from a lead or opportunity.
 *
 * SCOPE DECISION: we never touch card data. The link is hosted by the provider (Razorpay /
 * Stripe / anything with an HTTP API), so PCI scope stays with them. We store the link, its
 * status, and the webhook payload — nothing sensitive.
 *
 * FLOW
 *   1. Admin connects their provider once (keys encrypted at rest).
 *   2. From a lead/opportunity: create a payment link (amount, description).
 *   3. Optionally send it immediately via their messaging connector using a template
 *      containing {{payment.url}} — so "email/WhatsApp the bill" is one click.
 *   4. The provider calls our public webhook when paid; we mark it paid, log an activity,
 *      optionally move the opportunity stage, and fire automation.
 */
export const paymentsRouter = Router();
export const paymentWebhookRouter = Router();   // public, no auth (verified by signature/token)

export const PAYMENT_PROVIDERS: Record<string, any> = {
  razorpay: {
    key: 'razorpay', label: 'Razorpay',
    secretFields: [
      { key: 'keyId', label: 'Key ID' },
      { key: 'keySecret', label: 'Key Secret' },
      { key: 'webhookSecret', label: 'Webhook Secret', hint: 'From Razorpay webhook settings — used to verify callbacks' },
    ],
    configFields: [{ key: 'currency', label: 'Default currency', hint: 'INR' }],
    docsUrl: 'https://razorpay.com/docs/api/payment-links/',
  },
  stripe: {
    key: 'stripe', label: 'Stripe',
    secretFields: [
      { key: 'secretKey', label: 'Secret Key' },
      { key: 'webhookSecret', label: 'Webhook Signing Secret' },
    ],
    configFields: [{ key: 'currency', label: 'Default currency', hint: 'inr / usd' }],
    docsUrl: 'https://stripe.com/docs/api/payment_links',
  },
  custom: {
    key: 'custom', label: 'Custom / Static link',
    secretFields: [{ key: 'token', label: 'Token (optional)', hint: 'Available as {{secret.token}}' }],
    configFields: [
      { key: 'mode', label: 'Mode', hint: 'api = call an endpoint to create a link; static = build a URL from a template' },
      { key: 'url', label: 'API endpoint or static URL template' },
      { key: 'method', label: 'HTTP method (api mode)', hint: 'POST' },
      { key: 'headersJson', label: 'Headers JSON (api mode)' },
      { key: 'bodyTemplate', label: 'Body template (api mode)' },
      { key: 'linkJsonPath', label: 'Where the link is in the response', hint: 'e.g. data.short_url' },
      { key: 'webhookToken', label: 'Webhook shared token', hint: 'Required to accept callbacks' },
    ],
  },
};

function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageConnectors && !req.auth.perms.settings?.manageRoles)
    throw err(403, 'FORBIDDEN', 'Missing settings permission: manageConnectors');
}

function atPath(obj: any, path?: string): any {
  if (!path) return obj;
  let cur = obj;
  for (const p of path.split('.')) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

// ---------------------------------------------------------------------------
// Connector management
// ---------------------------------------------------------------------------
paymentsRouter.get('/providers', (_req, res) => {
  res.json({ items: Object.values(PAYMENT_PROVIDERS), encryptionReady: encryptionAvailable() });
});

paymentsRouter.get('/connectors', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(
      `SELECT id, name, provider, config, is_active, last_error, last_used_at, created_at,
              (secrets_encrypted IS NOT NULL) AS has_credentials
       FROM connectors WHERE channel='payment' ORDER BY created_at DESC`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

paymentsRouter.post('/connectors', requireFeature('payments'), async (req, res) => {
  try {
    requireManage(req);
    const { name, provider, config = {}, secrets = {} } = req.body || {};
    if (!name || !provider) throw err(400, 'MISSING_FIELDS', 'name and provider required');
    if (!PAYMENT_PROVIDERS[provider]) throw err(400, 'UNKNOWN_PROVIDER', `Unknown payment provider: ${provider}`);
    if (!encryptionAvailable())
      throw err(500, 'ENCRYPTION_NOT_CONFIGURED', 'CREDENTIALS_KEY is not configured, so payment credentials cannot be stored securely.');

    const row = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(
        `INSERT INTO connectors (tenant_id, type, name, provider, channel, config, secrets_encrypted)
         VALUES ($1,'payment',$2,$3,'payment',$4,$5)
         RETURNING id, name, provider, config, is_active, created_at`,
        [req.auth!.tenantId, name, provider, JSON.stringify(config),
         Object.keys(secrets).length ? encryptSecrets(secrets) : null]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType,
        'connector.created', 'connector', r.rows[0].id, null, { name, provider, channel: 'payment' });
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

paymentsRouter.get('/connectors/:id/credentials', async (req, res) => {
  try {
    requireManage(req);
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT secrets_encrypted FROM connectors WHERE id=$1 AND channel='payment'`, [req.params.id])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Connector not found');
    res.json({ masked: maskSecrets(decryptSecrets(row.secrets_encrypted)) });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Create a payment link (from a lead or opportunity)
// ---------------------------------------------------------------------------
paymentsRouter.post('/links', requireFeature('payments'), async (req, res) => {
  try {
    const { connectorId, leadId, opportunityId, amount, currency, description,
            sendVia, templateId, to } = req.body || {};
    if (!amount || Number(amount) <= 0) throw err(400, 'INVALID_VALUE', 'A positive amount is required');
    if (!leadId && !opportunityId) throw err(400, 'MISSING_FIELDS', 'leadId or opportunityId required');
    if (!req.auth!.perms.lead?.view) throw err(403, 'FORBIDDEN', 'No permission to view leads');

    const out = await withTenant(req.auth!.tenantId, async c => {
      // Resolve the record and verify the caller can actually see it — otherwise this endpoint
      // would leak record data (and let someone bill a customer they can't access).
      let lead: any = null, opp: any = null;
      if (opportunityId) {
        opp = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [opportunityId])).rows[0];
        if (!opp) throw err(404, 'NOT_FOUND', 'Opportunity not found');
      }
      const targetLeadId = leadId || opp?.lead_id;
      lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [targetLeadId])).rows[0];
      if (!lead) throw err(404, 'NOT_FOUND', 'Lead not found');
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, req.auth!.perms.lead.view);
      if (visibleIds !== null && !(lead.owner_id && visibleIds.includes(lead.owner_id)))
        throw err(403, 'FORBIDDEN', 'Not your lead');

      const cid = connectorId || (await c.query(
        `SELECT id FROM connectors WHERE channel='payment' AND is_active ORDER BY created_at LIMIT 1`)).rows[0]?.id;
      if (!cid) throw err(400, 'NO_CONNECTOR', 'No active payment connector configured (Settings > Payments).');
      const conn = (await c.query(`SELECT * FROM connectors WHERE id=$1 AND channel='payment' AND is_active`, [cid])).rows[0];
      if (!conn) throw err(404, 'NOT_FOUND', 'Payment connector not found');

      const secrets = decryptSecrets(conn.secrets_encrypted);
      const cfg = conn.config || {};
      const cur = currency || cfg.currency || 'INR';
      // Our correlation id, echoed to the provider so webhooks can be matched back.
      const reference = randToken('pl_', 10);
      const desc = description || `Payment for ${lead.first_name || 'lead'}`;

      let url: string | null = null, providerLinkId: string | null = null;
      let providerError: string | null = null;

      if (conn.provider === 'razorpay') {
        const r = await safeHttpCall({
          method: 'POST', url: 'https://api.razorpay.com/v1/payment_links',
          headers: {
            authorization: `Basic ${Buffer.from(`${secrets.keyId || ''}:${secrets.keySecret || ''}`).toString('base64')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            amount: Math.round(Number(amount) * 100),   // Razorpay expects the minor unit
            currency: cur, description: desc, reference_id: reference,
            customer: {
              name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || undefined,
              email: lead.email || undefined, contact: lead.phone || undefined,
            },
            notify: { sms: false, email: false },       // we control delivery ourselves
            reminder_enable: false,
          }),
        });
        if (r.ok) {
          try { const j = JSON.parse(r.body); url = j.short_url; providerLinkId = j.id; }
          catch { providerError = 'Could not parse Razorpay response'; }
        } else providerError = r.error;

      } else if (conn.provider === 'stripe') {
        // Stripe payment links need a price; a hosted Checkout Session is the simpler
        // equivalent for an ad-hoc amount.
        const form = new URLSearchParams({
          'mode': 'payment',
          'line_items[0][price_data][currency]': String(cur).toLowerCase(),
          'line_items[0][price_data][unit_amount]': String(Math.round(Number(amount) * 100)),
          'line_items[0][price_data][product_data][name]': desc,
          'line_items[0][quantity]': '1',
          'client_reference_id': reference,
          'success_url': cfg.successUrl || 'https://example.com/paid',
        });
        if (lead.email) form.set('customer_email', lead.email);
        const r = await safeHttpCall({
          method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions',
          headers: {
            authorization: `Bearer ${secrets.secretKey || ''}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });
        if (r.ok) {
          try { const j = JSON.parse(r.body); url = j.url; providerLinkId = j.id; }
          catch { providerError = 'Could not parse Stripe response'; }
        } else providerError = r.error;

      } else {
        // custom: either call the tenant's endpoint, or build a static URL from a template.
        const ctx = {
          ...(await buildMergeContext(c, 'lead', lead)),
          amount: String(amount), currency: cur, description: desc, reference,
          secret: secrets,
        };
        if ((cfg.mode || 'static') === 'api') {
          if (!cfg.url) throw err(400, 'CONNECTOR_MISCONFIGURED', 'Custom payment connector needs a url');
          let headers: Record<string, string> = {};
          if (cfg.headersJson) {
            try { headers = JSON.parse(mergeString(String(cfg.headersJson), ctx)); }
            catch { throw err(400, 'CONNECTOR_MISCONFIGURED', 'Custom payment headers must be valid JSON'); }
          }
          const r = await safeHttpCall({
            method: (cfg.method || 'POST').toUpperCase(),
            url: mergeString(String(cfg.url), ctx), headers,
            body: cfg.bodyTemplate ? mergeString(String(cfg.bodyTemplate), ctx) : null,
          });
          if (r.ok) {
            try {
              const j = JSON.parse(r.body);
              url = atPath(j, cfg.linkJsonPath) || j.url || j.short_url || j.link;
              providerLinkId = j.id || j.reference_id || null;
            } catch { providerError = 'Could not parse payment provider response'; }
          } else providerError = r.error;
        } else {
          if (!cfg.url) throw err(400, 'CONNECTOR_MISCONFIGURED', 'Static payment link needs a url template');
          url = mergeString(String(cfg.url), ctx);
        }
      }

      const row = (await c.query(
        `INSERT INTO payment_links (tenant_id, connector_id, lead_id, opportunity_id, amount, currency,
           description, provider, provider_link_id, url, status, reference, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [req.auth!.tenantId, cid, lead.id, opportunityId || null, amount, cur, desc,
         conn.provider, providerLinkId, url, url ? 'created' : 'failed', reference, req.auth!.userId])).rows[0];

      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType,
        'payment_link.created', 'payment_link', row.id, null, { amount, currency: cur, leadId: lead.id });

      if (!url) throw err(502, 'PAYMENT_LINK_FAILED', `Could not create the payment link: ${providerError || 'unknown provider error'}`);

      // Optionally send it right away through the tenant's messaging connector.
      let sendResult: any = null;
      if (sendVia) {
        const channel = sendVia as Channel;
        const msgConn = await defaultConnectorFor(c, channel);
        if (!msgConn) {
          sendResult = { ok: false, error: `No active ${channel} connector configured` };
        } else {
          let subject: string | undefined, body: string;
          if (templateId) {
            const tpl = (await c.query(`SELECT * FROM message_templates WHERE id=$1 AND is_active`, [templateId])).rows[0];
            if (!tpl) throw err(404, 'NOT_FOUND', 'Message template not found');
            subject = tpl.subject; body = tpl.body;
          } else {
            subject = `Payment request: ${cur} ${amount}`;
            body = `Hi {{lead.first_name}}, please complete your payment of ${cur} ${amount} here: {{payment.url}}`;
          }
          // {{payment.*}} tokens are what make "attach the link to a template" work.
          const ctx = await buildMergeContext(c, 'lead', lead, {
            payment: { url, amount: String(amount), currency: cur, description: desc, reference },
          });
          const recipient = to || (channel === 'email' ? lead.email : lead.phone);
          if (!recipient) {
            sendResult = { ok: false, error: `Lead has no ${channel === 'email' ? 'email' : 'phone'}` };
          } else {
            const r = await sendMessage(c, req.auth!.tenantId, msgConn, {
              channel, to: recipient,
              subject: subject ? mergeString(subject, ctx) : undefined,
              body: mergeString(body, ctx),
            }, { leadId: lead.id, opportunityId: opportunityId || null, actorId: req.auth!.userId });
            sendResult = { ok: r.ok, error: r.error };
            if (r.ok) await c.query(`UPDATE payment_links SET status='sent', updated_at=now() WHERE id=$1`, [row.id]);
          }
        }
      }

      return { id: row.id, url, reference, provider: conn.provider, status: sendResult?.ok ? 'sent' : 'created', send: sendResult };
    });

    res.status(201).json({ result: 'Success', ...out });
  } catch (e) { sendError(res, e); }
});

paymentsRouter.get('/links', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses = ['1=1'];
      if (req.query.leadId) { params.push(req.query.leadId); clauses.push(`lead_id=$${params.length}`); }
      if (req.query.status) { params.push(req.query.status); clauses.push(`status=$${params.length}`); }
      const limit = Math.min(200, parseInt(String(req.query.limit || '50')));
      params.push(limit);
      return (await c.query(
        `SELECT id, lead_id, opportunity_id, amount, currency, description, provider, url, status,
                paid_at, paid_amount, reference, created_at
         FROM payment_links WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params)).rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

/** Full event history for one link — the audit trail if a customer disputes a charge. */
paymentsRouter.get('/links/:id/events', async (req, res) => {
  try {
    const out = await withTenant(req.auth!.tenantId, async c => {
      const link = (await c.query(
        `SELECT id, amount, currency, paid_amount, amount_refunded, status, paid_at, refunded_at
         FROM payment_links WHERE id=$1`, [req.params.id])).rows[0];
      if (!link) throw err(404, 'NOT_FOUND', 'Payment link not found');
      const events = (await c.query(
        `SELECT id, event_type, amount, currency, provider_event_id, created_at
         FROM payment_events WHERE payment_link_id=$1 ORDER BY id`, [req.params.id])).rows;
      const net = Number(link.paid_amount || 0) - Number(link.amount_refunded || 0);
      return {
        link, events,
        netPaid: net,
        amountDue: Math.max(0, Number(link.amount) - net),
        isFullyPaid: net >= Number(link.amount),
      };
    });
    res.json(out);
  } catch (e) { sendError(res, e); }
});

/**
 * Record a refund initiated OUTSIDE the CRM (e.g. someone refunded in the Razorpay dashboard).
 * Keeps our numbers correct even when the action didn't start here — otherwise the CRM slowly
 * drifts away from reality, which is worse than not tracking refunds at all.
 */
paymentsRouter.post('/links/:id/record-refund', requireFeature('payments'), async (req, res) => {
  try {
    if (!req.auth!.perms.settings?.manageRoles && !req.auth!.perms.opportunity?.edit)
      throw err(403, 'FORBIDDEN', 'You do not have permission to record refunds');
    const { amount, note } = req.body || {};
    if (!amount || Number(amount) <= 0) throw err(400, 'INVALID_VALUE', 'A positive refund amount is required');

    const out = await withTenant(req.auth!.tenantId, async c => {
      const link = (await c.query(`SELECT * FROM payment_links WHERE id=$1`, [req.params.id])).rows[0];
      if (!link) throw err(404, 'NOT_FOUND', 'Payment link not found');
      const alreadyRefunded = Number(link.amount_refunded || 0);
      const paidTotal = Number(link.paid_amount || 0);
      if (alreadyRefunded + Number(amount) > paidTotal)
        throw err(400, 'REFUND_EXCEEDS_PAID',
          `Cannot refund ${amount}: only ${(paidTotal - alreadyRefunded).toFixed(2)} of this payment remains refundable`);

      await c.query(
        `INSERT INTO payment_events (tenant_id, payment_link_id, event_type, amount, currency, provider_payload)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.auth!.tenantId, link.id,
         alreadyRefunded + Number(amount) >= paidTotal ? 'refunded' : 'partially_refunded',
         amount, link.currency, JSON.stringify({ manual: true, note: note || null, by: req.auth!.userId })]);

      const refundTotal = alreadyRefunded + Number(amount);
      const net = paidTotal - refundTotal;
      const status = net <= 0 ? 'refunded' : 'partially_refunded';
      const after = (await c.query(
        `UPDATE payment_links SET amount_refunded=$2, refunded_at=now(), status=$3, updated_at=now()
         WHERE id=$1 RETURNING *`, [link.id, refundTotal, status])).rows[0];

      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType,
        'payment_link.refund_recorded', 'payment_link', link.id, link, after);
      return { status, netPaid: net, amountRefunded: refundTotal };
    });
    res.json({ result: 'Success', ...out });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Public webhook: provider -> us, "this link was paid"
// ---------------------------------------------------------------------------
/**
 * POST /payments/webhook/:reference   (public)
 *
 * Verification: Razorpay/Stripe sign the payload; for `custom` we require a shared token. The
 * payment link row is looked up by our own reference, which is how we resolve the tenant before
 * RLS context exists — hence bypassRLS for that single indexed lookup only.
 */
paymentWebhookRouter.post('/webhook/:reference', async (req, res) => {
  try {
    const reference = req.params.reference;
    const link = await bypassRLS(c => c.query(
      `SELECT pl.*, c.provider AS conn_provider, c.secrets_encrypted, c.config AS conn_config
       FROM payment_links pl LEFT JOIN connectors c ON c.id = pl.connector_id
       WHERE pl.reference=$1`, [reference]).then(r => r.rows[0]));
    // Always 200 to a webhook we can't match: providers retry aggressively on non-2xx, and an
    // unknown reference is not something a retry will fix.
    if (!link) return res.status(200).json({ status: 'ignored', reason: 'unknown reference' });

    const secrets = decryptSecrets(link.secrets_encrypted);
    // Providers sign the EXACT bytes they sent, so we must verify against the raw body captured
    // by the express.json `verify` hook — re-serialising with JSON.stringify would change
    // key order/whitespace and break every signature.
    const raw = (req as any).rawBody ?? JSON.stringify(req.body || {});
    let verified = false;

    /** Constant-time compare that won't throw on length mismatch. */
    const safeEqual = (a: string, b: string) => {
      const ab = Buffer.from(a), bb = Buffer.from(b);
      return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
    };

    if (link.conn_provider === 'razorpay') {
      const sig = req.header('x-razorpay-signature') || '';
      const expected = crypto.createHmac('sha256', secrets.webhookSecret || '').update(raw).digest('hex');
      verified = !!sig && safeEqual(sig, expected);

    } else if (link.conn_provider === 'stripe') {
      // Stripe sends: Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]
      // The signed payload is `${t}.${rawBody}`. Timestamp is checked to prevent replay.
      const header = req.header('stripe-signature') || '';
      const parts = header.split(',').map(p => p.trim());
      const t = parts.find(p => p.startsWith('t='))?.slice(2) || '';
      const sigs = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
      if (t && sigs.length && secrets.webhookSecret) {
        const expected = crypto.createHmac('sha256', secrets.webhookSecret)
          .update(`${t}.${raw}`).digest('hex');
        const sigOk = sigs.some(s => safeEqual(s, expected));
        // Reject anything older than 5 minutes — the standard replay window.
        const ageOk = Math.abs(Date.now() / 1000 - Number(t)) < 300;
        verified = sigOk && ageOk;
      }
    } else {
      const token = req.query.token || req.header('x-webhook-token');
      const expected = (link.conn_config || {}).webhookToken || secrets.token;
      verified = !!expected && token === expected;
    }

    if (!verified) return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature/token did not verify' } });

    // Classify the event. Refunds and partial payments are first-class: installment plans and
    // cancellations are normal in the target verticals (education fees, jewellery orders), so
    // treating every callback as "paid or failed" would quietly produce wrong numbers.
    const body: any = req.body || {};
    const event = String(body.event || body.type || '');
    const statusStr = String(body.status || '');
    const isRefund = /refund/i.test(event) || /refund/i.test(statusStr);
    const paid = !isRefund && (
      /paid|captured|succeeded|completed|success/i.test(event) ||
      /paid|captured|succeeded/i.test(statusStr));

    // Amount, in major units. Providers report minor units (paise/cents).
    const rawAmount =
      body.payload?.refund?.entity?.amount ??
      body.payload?.payment?.entity?.amount ??
      body.data?.object?.amount_refunded ??
      body.data?.object?.amount_total ??
      body.amount;
    const eventAmount = rawAmount != null ? Number(rawAmount) / 100 : Number(link.amount);

    // Idempotency key. The provider's own event id is ideal, because one link legitimately
    // receives several events (installment 1, installment 2, refund) and they must all apply.
    //
    // Not every provider sends one, so we fall back to a hash of the exact payload bytes:
    // identical bytes mean a redelivery, which must be ignored. Two genuinely separate
    // installments always differ (timestamp, payment id), so this is safe in practice — the only
    // theoretical collision is a provider sending byte-identical payloads for two distinct
    // payments, which no real provider does.
    const providerEventId =
      body.payload?.refund?.entity?.id ?? body.payload?.payment?.entity?.id ??
      body.data?.object?.id ?? body.id ??
      `sha:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;

    await withTenant(link.tenant_id, async c => {
      // Idempotency by provider event id, not by link status — a redelivered "installment 1"
      // must be ignored while a genuinely new "installment 2" must still be applied.
      if (providerEventId) {
        const dup = await c.query(
          `SELECT 1 FROM payment_events WHERE payment_link_id=$1 AND provider_event_id=$2`,
          [link.id, providerEventId]);
        if (dup.rowCount) return;
      }

      const eventType = isRefund
        ? (eventAmount < Number(link.paid_amount || link.amount) ? 'partially_refunded' : 'refunded')
        : paid
          ? (eventAmount < Number(link.amount) ? 'partially_paid' : 'paid')
          : 'failed';

      await c.query(
        `INSERT INTO payment_events (tenant_id, payment_link_id, event_type, amount, currency, provider_event_id, provider_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [link.tenant_id, link.id, eventType, eventAmount, link.currency, providerEventId, JSON.stringify(body)]);

      // Recompute totals from the event log, so the link's state is always derivable and a
      // missed/duplicated callback can't leave a permanently wrong balance.
      const totals = (await c.query(
        `SELECT
           COALESCE(SUM(CASE WHEN event_type IN ('paid','partially_paid') THEN amount END),0) AS paid_total,
           COALESCE(SUM(CASE WHEN event_type IN ('refunded','partially_refunded') THEN amount END),0) AS refund_total
         FROM payment_events WHERE payment_link_id=$1`, [link.id])).rows[0];
      const paidTotal = Number(totals.paid_total);
      const refundTotal = Number(totals.refund_total);
      const net = paidTotal - refundTotal;
      const due = Number(link.amount);

      const newStatus =
        refundTotal > 0 && net <= 0 ? 'refunded'
        : refundTotal > 0 ? 'partially_refunded'
        : net >= due ? 'paid'
        : net > 0 ? 'partially_paid'
        : eventType === 'failed' ? 'failed'
        : link.status;

      const after = (await c.query(
        // Explicit ::numeric casts: $4 is used both as a column value and in a comparison, and
        // without them Postgres deduces conflicting types for the same parameter.
        `UPDATE payment_links SET status=$2,
           paid_at = CASE WHEN $2 IN ('paid','partially_paid') AND paid_at IS NULL THEN now() ELSE paid_at END,
           paid_amount=$3::numeric, amount_refunded=$4::numeric,
           refunded_at = CASE WHEN $4::numeric > 0 THEN now() ELSE refunded_at END,
           provider_payload=$5, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [link.id, newStatus, paidTotal, refundTotal, JSON.stringify(body)])).rows[0];

      await audit(c, link.tenant_id, null, 'connector:payment',
        `payment_link.${eventType}`, 'payment_link', link.id, { status: link.status }, after);

      // Log refunds on the timeline too — sales needs to see money going back out.
      if (isRefund && link.lead_id) {
        const at = (await c.query(`SELECT id FROM activity_types WHERE name='Note Added' AND is_active`)).rows[0];
        if (at) {
          await c.query(
            `INSERT INTO activities (tenant_id, lead_id, opportunity_id, activity_type_id, note, fields)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [link.tenant_id, link.lead_id, link.opportunity_id, at.id,
             `Refund processed: ${link.currency} ${eventAmount} (net paid now ${link.currency} ${net})`,
             JSON.stringify({ reference: link.reference, eventType })]);
        }
      }

      if (paid && link.lead_id) {
        // Log it on the record timeline so sales sees the payment without leaving the CRM.
        const at = (await c.query(`SELECT id FROM activity_types WHERE name='Payment Received' AND is_active`)).rows[0]
          || (await c.query(`SELECT id FROM activity_types WHERE name='Note Added' AND is_active`)).rows[0];
        if (at) {
          await c.query(
            `INSERT INTO activities (tenant_id, lead_id, opportunity_id, activity_type_id, note, fields)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [link.tenant_id, link.lead_id, link.opportunity_id, at.id,
             net >= due
               ? `Payment received: ${link.currency} ${eventAmount} (fully paid)`
               : `Part payment received: ${link.currency} ${eventAmount} — ${link.currency} ${(due - net).toFixed(2)} still due`,
             JSON.stringify({ reference: link.reference, provider: link.conn_provider, netPaid: net, due })]);
        }

        const lead = (await c.query(`SELECT * FROM leads WHERE id=$1`, [link.lead_id])).rows[0];
        if (lead) {
          // Let automation react ("when payment received -> move stage, notify owner, ...").
          await runAutomations(c, link.tenant_id, {
            entity: 'lead', event: 'updated', record: lead, actorType: 'connector:payment',
            changedFields: ['payment_status'],
          });
        }
      }
    });

    res.status(200).json({ status: 'Success' });
  } catch (e) { sendError(res, e); }
});
