import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { audit } from '../audit.js';
import { PROVIDERS, sendMessage, defaultConnectorFor, type Channel } from '../messaging.js';
import { encryptSecrets, maskSecrets, decryptSecrets, encryptionAvailable } from '../crypto.js';
import { mergeString, buildMergeContext, availableTokens } from '../merge.js';
import { resolveVisibleOwnerIds } from '../permissions.js';

/**
 * Messaging: provider connectors (the tenant's own accounts), templates, and sending.
 * Credentials are encrypted at rest and never returned — only masked previews.
 */
export const messagingRouter = Router();

function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageConnectors && !req.auth.perms.settings?.manageRoles)
    throw err(403, 'FORBIDDEN', 'Missing settings permission: manageConnectors');
}

// ---------- Provider catalogue (drives the connector setup UI) ----------
messagingRouter.get('/providers', (_req, res) => {
  res.json({ items: Object.values(PROVIDERS), encryptionReady: encryptionAvailable() });
});

// ---------- Connectors ----------
messagingRouter.get('/connectors', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => (await c.query(
      `SELECT id, name, provider, channel, config, is_active, last_error, last_used_at, created_at,
              (secrets_encrypted IS NOT NULL) AS has_credentials
       FROM connectors WHERE channel = ANY($1) ORDER BY created_at DESC`,
      [['email', 'sms', 'whatsapp']])).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

messagingRouter.post('/connectors', async (req, res) => {
  try {
    requireManage(req);
    const { name, provider, channel, config = {}, secrets = {} } = req.body || {};
    if (!name || !provider || !channel) throw err(400, 'MISSING_FIELDS', 'name, provider, channel required');
    const def = PROVIDERS[provider];
    if (!def) throw err(400, 'UNKNOWN_PROVIDER', `Unknown provider: ${provider}`);
    if (!def.channels.includes(channel)) throw err(400, 'CHANNEL_UNSUPPORTED', `${def.label} does not support ${channel}`);
    if (!encryptionAvailable())
      throw err(500, 'ENCRYPTION_NOT_CONFIGURED', 'CREDENTIALS_KEY is not configured on the server, so provider credentials cannot be stored securely.');

    const encrypted = Object.keys(secrets).length ? encryptSecrets(secrets) : null;
    const row = await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(
        `INSERT INTO connectors (tenant_id, type, name, provider, channel, config, secrets_encrypted)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, name, provider, channel, config, is_active, created_at`,
        [req.auth!.tenantId, 'messaging', name, provider, channel, JSON.stringify(config), encrypted]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType,
        'connector.created', 'connector', r.rows[0].id, null, { name, provider, channel });
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

messagingRouter.patch('/connectors/:id', async (req, res) => {
  try {
    requireManage(req);
    const { name, config, secrets, isActive } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c => {
      const cur = (await c.query(`SELECT * FROM connectors WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) return null;
      // Merge new secrets over existing ones so a partial update doesn't wipe credentials.
      let encrypted = cur.secrets_encrypted;
      if (secrets && Object.keys(secrets).length) {
        const existing = cur.secrets_encrypted ? decryptSecrets(cur.secrets_encrypted) : {};
        encrypted = encryptSecrets({ ...existing, ...secrets });
      }
      const r = await c.query(
        `UPDATE connectors SET name=COALESCE($2,name), config=COALESCE($3,config),
           secrets_encrypted=$4, is_active=COALESCE($5,is_active)
         WHERE id=$1 RETURNING id, name, provider, channel, config, is_active`,
        [req.params.id, name, config ? JSON.stringify(config) : null, encrypted, isActive]);
      return r.rows[0];
    });
    if (!row) throw err(404, 'NOT_FOUND', 'Connector not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

/** Masked credential preview — enough to recognise which key is stored, never the value. */
messagingRouter.get('/connectors/:id/credentials', async (req, res) => {
  try {
    requireManage(req);
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT secrets_encrypted FROM connectors WHERE id=$1`, [req.params.id])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Connector not found');
    res.json({ masked: maskSecrets(decryptSecrets(row.secrets_encrypted)) });
  } catch (e) { sendError(res, e); }
});

messagingRouter.delete('/connectors/:id', async (req, res) => {
  try {
    requireManage(req);
    await withTenant(req.auth!.tenantId, async c => {
      const cur = (await c.query(`SELECT id FROM connectors WHERE id=$1`, [req.params.id])).rows[0];
      if (!cur) throw err(404, 'NOT_FOUND', 'Connector not found');
      await c.query(`DELETE FROM connectors WHERE id=$1`, [req.params.id]);
      await audit(c, req.auth!.tenantId, req.auth!.userId, req.auth!.actorType, 'connector.deleted', 'connector', req.params.id, cur, null);
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---------- Templates ----------
messagingRouter.get('/templates', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      let sql = `SELECT * FROM message_templates WHERE is_active`;
      if (req.query.channel) { params.push(req.query.channel); sql += ` AND channel=$${params.length}`; }
      sql += ` ORDER BY name`;
      return (await c.query(sql, params)).rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

messagingRouter.get('/templates/tokens/:entity', async (req, res) => {
  try {
    if (!['lead', 'opportunity', 'activity'].includes(req.params.entity))
      throw err(400, 'INVALID_ENTITY', 'entity must be lead|opportunity|activity');
    const items = await withTenant(req.auth!.tenantId, c => availableTokens(c, req.params.entity as any));
    res.json({ items });
  } catch (e) { sendError(res, e); }
});

messagingRouter.post('/templates', async (req, res) => {
  try {
    requireManage(req);
    const { name, channel, subject, body, providerTemplateId } = req.body || {};
    if (!name || !channel || !body) throw err(400, 'MISSING_FIELDS', 'name, channel, body required');
    if (!['email', 'sms', 'whatsapp'].includes(channel)) throw err(400, 'INVALID_VALUE', 'channel must be email|sms|whatsapp');
    const row = await withTenant(req.auth!.tenantId, async c => (await c.query(
      `INSERT INTO message_templates (tenant_id, name, channel, subject, body, provider_template_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.auth!.tenantId, name, channel, subject || null, body, providerTemplateId || null, req.auth!.userId])).rows[0]);
    res.status(201).json(row);
  } catch (e) {
    if ((e as any)?.code === '23505') return sendError(res, err(409, 'TEMPLATE_EXISTS', 'A template with this name already exists'));
    sendError(res, e);
  }
});

messagingRouter.patch('/templates/:id', async (req, res) => {
  try {
    requireManage(req);
    const { name, subject, body, providerTemplateId, isActive } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c => (await c.query(
      `UPDATE message_templates SET name=COALESCE($2,name), subject=COALESCE($3,subject),
         body=COALESCE($4,body), provider_template_id=COALESCE($5,provider_template_id),
         is_active=COALESCE($6,is_active) WHERE id=$1 RETURNING *`,
      [req.params.id, name, subject, body, providerTemplateId, isActive])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Template not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

messagingRouter.delete('/templates/:id', async (req, res) => {
  try {
    requireManage(req);
    await withTenant(req.auth!.tenantId, c => c.query(`DELETE FROM message_templates WHERE id=$1`, [req.params.id]));
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});

// ---------- Send ----------
/**
 * Send a message about a record. Either pass a templateId (merged against the record) or an
 * explicit subject/body. Recipient defaults to the lead's email/phone for the channel.
 */
messagingRouter.post('/send', async (req, res) => {
  try {
    const { channel, connectorId, templateId, to, subject, body, leadId, opportunityId } = req.body || {};
    if (!channel || !['email', 'sms', 'whatsapp'].includes(channel))
      throw err(400, 'INVALID_VALUE', 'channel must be email|sms|whatsapp');
    if (!templateId && !body) throw err(400, 'MISSING_FIELDS', 'Provide either templateId or body');
    if (!leadId && !to) throw err(400, 'MISSING_FIELDS', 'Provide leadId (to resolve the recipient) or an explicit "to"');

    // Sending on a record requires permission to edit that record's activity trail.
    if (!req.auth!.perms.activity?.create)
      throw err(403, 'FORBIDDEN', 'No permission to log activity on records');

    const out = await withTenant(req.auth!.tenantId, async c => {
      const cid = connectorId || await defaultConnectorFor(c, channel as Channel);
      if (!cid) throw err(400, 'NO_CONNECTOR', `No active ${channel} connector configured. Add one in Settings > Messaging.`);

      let lead: any = null;
      if (leadId) {
        lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [leadId])).rows[0];
        if (!lead) throw err(404, 'NOT_FOUND', 'Lead not found');
      }

      let finalSubject = subject, finalBody = body, tpl: any = null;
      if (templateId) {
        tpl = (await c.query(`SELECT * FROM message_templates WHERE id=$1 AND is_active`, [templateId])).rows[0];
        if (!tpl) throw err(404, 'NOT_FOUND', 'Template not found');
        finalSubject = tpl.subject; finalBody = tpl.body;
      }

      if (lead) {
        const me = (await c.query(`SELECT first_name, last_name, email FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
        const ctx = await buildMergeContext(c, 'lead', lead, {
          user: me ? { name: `${me.first_name || ''} ${me.last_name || ''}`.trim(), email: me.email } : {},
        });
        if (finalSubject) finalSubject = mergeString(finalSubject, ctx);
        finalBody = mergeString(finalBody, ctx);
      }

      const recipient = to || (channel === 'email' ? lead?.email : lead?.phone);
      if (!recipient) throw err(400, 'NO_RECIPIENT', `The lead has no ${channel === 'email' ? 'email address' : 'phone number'}`);

      const result = await sendMessage(c, req.auth!.tenantId, cid, {
        channel: channel as Channel, to: recipient, subject: finalSubject, body: finalBody,
        providerTemplateId: tpl?.provider_template_id,
      }, { leadId: leadId || null, opportunityId: opportunityId || null, templateId: templateId || null, actorId: req.auth!.userId });

      // Log a CRM activity so the conversation shows up on the record timeline.
      if (lead && result.ok) {
        const typeName = channel === 'email' ? 'Email Sent' : channel === 'whatsapp' ? 'WhatsApp Message Sent' : 'SMS Sent';
        const at = (await c.query(`SELECT id FROM activity_types WHERE name=$1 AND is_active`, [typeName])).rows[0];
        if (at) {
          await c.query(
            `INSERT INTO activities (tenant_id, lead_id, opportunity_id, activity_type_id, note, performed_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [req.auth!.tenantId, lead.id, opportunityId || null, at.id,
             `${channel} to ${recipient}: ${String(finalBody).slice(0, 200)}`, req.auth!.userId]);
        }
      }
      return result;
    });

    res.status(out.ok ? 200 : 502).json({
      status: out.ok ? 'Success' : 'Failed',
      providerMessageId: out.providerMessageId,
      error: out.error,
    });
  } catch (e) { sendError(res, e); }
});

/**
 * "Own device" WhatsApp — the zero-cost option.
 *
 * If a tenant doesn't want a paid WhatsApp Business provider, they choose "send from my own
 * WhatsApp" on the connector. Instead of us sending anything, we return a deep link that opens
 * THEIR WhatsApp (app if installed, web otherwise) with the recipient's number and the template
 * already filled in — they just press send.
 *
 * Costs us nothing, costs them nothing, needs no Meta approval, and works from day one. The
 * trade-offs are honest and worth stating to customers: it's manual (a human presses send), it
 * can't be used by automation, and there's no delivery receipt — so we log it as "prepared",
 * not "sent".
 */
messagingRouter.post('/whatsapp/prepare', async (req, res) => {
  try {
    const { leadId, opportunityId, templateId, body, to, phoneField } = req.body || {};
    if (!leadId) throw err(400, 'MISSING_FIELDS', 'leadId required');
    if (!templateId && !body) throw err(400, 'MISSING_FIELDS', 'Provide templateId or body');
    if (!req.auth!.perms.lead?.view) throw err(403, 'FORBIDDEN', 'No permission to view leads');

    const out = await withTenant(req.auth!.tenantId, async c => {
      const lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [leadId])).rows[0];
      if (!lead) throw err(404, 'NOT_FOUND', 'Lead not found');
      const visibleIds = await resolveVisibleOwnerIds(c, req.auth!.tenantId, req.auth!.userId, req.auth!.perms.lead.view);
      if (visibleIds !== null && !(lead.owner_id && visibleIds.includes(lead.owner_id)))
        throw err(403, 'FORBIDDEN', 'Not your lead');

      let text = body;
      if (templateId) {
        const tpl = (await c.query(`SELECT * FROM message_templates WHERE id=$1 AND is_active`, [templateId])).rows[0];
        if (!tpl) throw err(404, 'NOT_FOUND', 'Template not found');
        text = tpl.body;
      }

      const me = (await c.query(`SELECT first_name, last_name, email FROM users WHERE id=$1`, [req.auth!.userId])).rows[0];
      const ctx = await buildMergeContext(c, 'lead', lead, {
        user: me ? { name: `${me.first_name || ''} ${me.last_name || ''}`.trim(), email: me.email } : {},
      });
      const merged = mergeString(String(text), ctx);

      // Recipient: explicit > a chosen custom phone field > primary > additional.
      const raw = to
        || (phoneField ? (lead.fields?.[phoneField] ?? (lead as any)[phoneField]) : null)
        || lead.phone || lead.additional_phone;
      if (!raw) throw err(400, 'NO_RECIPIENT', 'This lead has no phone number to message');

      // wa.me needs digits only, no +, no spaces.
      const digits = String(raw).replace(/\D/g, '');
      if (digits.length < 8) throw err(400, 'INVALID_PHONE', `'${raw}' doesn't look like a dialable number`);

      const waUrl = `https://wa.me/${digits}?text=${encodeURIComponent(merged)}`;
      // whatsapp:// opens the desktop/mobile app directly; the client tries this first and
      // falls back to wa.me, which itself falls back to WhatsApp Web.
      const appUrl = `whatsapp://send?phone=${digits}&text=${encodeURIComponent(merged)}`;

      // Logged as 'prepared' — we genuinely don't know whether the human pressed send.
      await c.query(
        `INSERT INTO message_log (tenant_id, channel, to_address, template_id, body, status, lead_id, opportunity_id, actor_id)
         VALUES ($1,'whatsapp',$2,$3,$4,'prepared',$5,$6,$7)`,
        [req.auth!.tenantId, digits, templateId || null, merged.slice(0, 4000),
         leadId, opportunityId || null, req.auth!.userId]);

      return { url: waUrl, appUrl, to: digits, text: merged, mode: 'own_device' };
    });

    res.json({ result: 'Success', ...out });
  } catch (e) { sendError(res, e); }
});

// ---------- Message log ----------
messagingRouter.get('/log', async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c => {
      const params: any[] = [];
      const clauses = ['1=1'];
      if (req.query.leadId) { params.push(req.query.leadId); clauses.push(`lead_id=$${params.length}`); }
      if (req.query.channel) { params.push(req.query.channel); clauses.push(`channel=$${params.length}`); }
      if (req.query.status) { params.push(req.query.status); clauses.push(`status=$${params.length}`); }
      const limit = Math.min(200, parseInt(String(req.query.limit || '50')));
      params.push(limit);
      return (await c.query(
        `SELECT id, channel, to_address, subject, status, provider_message_id, error, lead_id, created_at
         FROM message_log WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`, params)).rows;
    });
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});
