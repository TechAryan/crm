import { Router } from 'express';
import { withTenant, bypassRLS } from '../db.js';
import { err, sendError, randToken, normalizePhone } from '../util.js';
import { requireScope } from '../auth.js';
import { captureLead, postActivity } from '../services.js';
import { config } from '../config.js';

export const connectorsRouter = Router();       // authenticated management API
export const publicCaptureRouter = Router();      // unauthenticated inbound endpoints (forms, meta, whatsapp)

function requireManage(req: any) {
  if (!req.auth.perms.settings?.manageConnectors) throw err(403, 'FORBIDDEN', 'Missing settings permission: manageConnectors');
}

connectorsRouter.get('/', requireScope('connectors:read'), async (req, res) => {
  try {
    const rows = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT id, tenant_id, type, name, config, public_token, is_active, created_at FROM connectors ORDER BY created_at DESC`)).rows);
    res.json({ items: rows });
  } catch (e) { sendError(res, e); }
});

connectorsRouter.post('/', requireScope('connectors:write'), async (req, res) => {
  try {
    requireManage(req);
    const { type, name, config: cfg = {} } = req.body || {};
    if (!type || !name) throw err(400, 'MISSING_FIELDS', 'type, name required');
    if (!['whatsapp', 'meta', 'webform'].includes(type)) throw err(400, 'INVALID_TYPE', 'type must be whatsapp|meta|webform');
    const publicToken = randToken('conn_', 12);
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`INSERT INTO connectors (tenant_id, type, name, config, public_token) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.auth!.tenantId, type, name, JSON.stringify(cfg), publicToken])).rows[0]);
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

connectorsRouter.patch('/:id', requireScope('connectors:write'), async (req, res) => {
  try {
    requireManage(req);
    const { name, config: cfg, isActive } = req.body || {};
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`UPDATE connectors SET name=COALESCE($2,name), config=COALESCE($3,config), is_active=COALESCE($4,is_active) WHERE id=$1 RETURNING *`,
        [req.params.id, name, cfg ? JSON.stringify(cfg) : null, isActive])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Connector not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});

// ============================================================
// PUBLIC INBOUND ENDPOINTS — no auth (secured by public_token / provider verify tokens)
// ============================================================

// connectors is a tenant-RLS-protected table; the public capture endpoints don't know the
// tenant until they resolve the token, so this lookup must bypass RLS (indexed token lookup only).
async function findConnectorByToken(token: string, type?: string) {
  return bypassRLS(async c => {
    const q = type
      ? `SELECT * FROM connectors WHERE public_token=$1 AND type=$2 AND is_active`
      : `SELECT * FROM connectors WHERE public_token=$1 AND is_active`;
    const params = type ? [token, type] : [token];
    return (await c.query(q, params)).rows[0];
  });
}

// ---- Hosted lead-capture form page: GET /capture/v1/forms/:token/page ----
// A ready-made public form so customers without a website (astrologers, creators,
// small shops) can share a link and collect leads instantly.
publicCaptureRouter.get('/forms/:token/page', async (req, res) => {
  try {
    const conn = await findConnectorByToken(req.params.token, 'webform');
    if (!conn) return res.status(404).send('Form not found');
    const cfg = conn.config || {};
    // formFields: [{name (dest: firstName|email|phone|fields.mx_x), label, type, required, options[]}]
    const fields = Array.isArray(cfg.formFields) && cfg.formFields.length ? cfg.formFields : [
      { name: 'firstName', label: 'Your Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: false },
      { name: 'phone', label: 'Phone / WhatsApp', type: 'tel', required: true },
    ];
    const title = cfg.formTitle || conn.name || 'Get in touch';
    const subtitle = cfg.formSubtitle || "Fill in your details and we'll reach out shortly.";
    const thankYou = cfg.thankYou || 'Thank you! We have received your details and will contact you soon.';
    const color = cfg.color || '#4f46e5';
    const esc = (s: string) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

    const inputs = fields.map((f: any) => {
      const req_ = f.required ? 'required' : '';
      if (f.type === 'select' && Array.isArray(f.options)) {
        return `<label>${esc(f.label)}${f.required ? ' *' : ''}</label>
          <select name="${esc(f.name)}" ${req_}><option value="">Select…</option>${f.options.map((o: string) => `<option>${esc(o)}</option>`).join('')}</select>`;
      }
      if (f.type === 'textarea') {
        return `<label>${esc(f.label)}${f.required ? ' *' : ''}</label><textarea name="${esc(f.name)}" rows="3" ${req_}></textarea>`;
      }
      return `<label>${esc(f.label)}${f.required ? ' *' : ''}</label><input type="${esc(f.type || 'text')}" name="${esc(f.name)}" ${req_} />`;
    }).join('\n');

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6f8;margin:0;padding:24px;display:flex;justify-content:center}
  .card{background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:32px;max-width:440px;width:100%;box-shadow:0 1px 3px rgba(16,24,40,.08)}
  h1{font-size:20px;margin:0 0 6px}p.sub{color:#6b7280;font-size:14px;margin:0 0 20px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 5px}
  input,select,textarea{width:100%;padding:10px;border:1px solid #e3e6eb;border-radius:8px;font-size:14px;font-family:inherit;box-sizing:border-box}
  input:focus,select:focus,textarea:focus{outline:none;border-color:${esc(color)}}
  button{margin-top:20px;width:100%;padding:12px;background:${esc(color)};color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6}.ok{display:none;text-align:center;padding:24px 0}.ok h2{font-size:18px}
</style></head><body>
<div class="card">
  <form id="f">
    <h1>${esc(title)}</h1><p class="sub">${esc(subtitle)}</p>
    ${inputs}
    <button type="submit" id="b">Submit</button>
  </form>
  <div class="ok" id="ok"><h2>✓</h2><p>${esc(thankYou)}</p></div>
</div>
<script>
document.getElementById('f').addEventListener('submit', async function(e){
  e.preventDefault();
  var b=document.getElementById('b'); b.disabled=true; b.textContent='Submitting…';
  var data={}; new FormData(this).forEach(function(v,k){ data[k]=v; });
  try{
    var r=await fetch(location.pathname.replace(/\\/page$/,''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    if(!r.ok) throw new Error();
    document.getElementById('f').style.display='none';
    document.getElementById('ok').style.display='block';
  }catch(err){ b.disabled=false; b.textContent='Submit'; alert('Something went wrong — please try again.'); }
});
</script></body></html>`);
  } catch (e) { sendError(res, e); }
});

// ---- Website form capture: POST /capture/v1/forms/:token ----
publicCaptureRouter.post('/forms/:token', async (req, res) => {
  try {
    const conn = await findConnectorByToken(req.params.token, 'webform');
    if (!conn) throw err(404, 'NOT_FOUND', 'Unknown form endpoint');
    const map = conn.config?.fieldMap || {}; // {"name":"firstName","mobile":"phone", "utm_source":"utm.source"}
    const body = req.body || {};
    const payload: any = { fields: {}, utm: {}, source: conn.config?.source || 'Website', consent: true };
    const DIRECT_KEYS = new Set(['firstName', 'lastName', 'email', 'phone', 'subSource']);
    const assign = (destPath: string, val: any) => {
      if (destPath.startsWith('fields.')) payload.fields[destPath.slice(7)] = val;
      else if (destPath.startsWith('utm.')) payload.utm[destPath.slice(4)] = val;
      else if (DIRECT_KEYS.has(destPath)) payload[destPath] = val;
    };
    for (const [srcKey, destPath] of Object.entries(map) as [string, string][]) {
      if (body[srcKey] !== undefined) assign(destPath, body[srcKey]);
    }
    // hosted form pages (and integrations that already use our field names) post
    // destination-named keys directly — pass those through without needing a fieldMap
    for (const [k, v] of Object.entries(body)) {
      if (map[k] !== undefined || v === undefined || v === '') continue;
      if (DIRECT_KEYS.has(k) || k.startsWith('fields.')) assign(k, v);
    }
    if (conn.config?.defaultOwnerId) payload.ownerId = conn.config.defaultOwnerId;
    const out = await withTenant(conn.tenant_id, c => captureLead(c, conn.tenant_id, payload, { id: null, type: 'connector:webform' }));
    res.status(out.isCreated ? 201 : 200).json({ status: 'Success', leadId: out.lead.id });
  } catch (e) { sendError(res, e); }
});

// ---- Meta / Facebook Lead Ads webhook ----
// Verification handshake
publicCaptureRouter.get('/meta/:token', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken === config.metaVerifyToken) return res.status(200).send(challenge);
  res.status(403).send('Forbidden');
});
publicCaptureRouter.post('/meta/:token', async (req, res) => {
  try {
    const conn = await findConnectorByToken(req.params.token, 'meta');
    if (!conn) throw err(404, 'NOT_FOUND', 'Unknown connector');
    const entries = req.body?.entry || [];
    const formMap = conn.config?.formMap || {}; // {"full_name":"firstName","phone_number":"phone","email":"email"}
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const leadgenId = change.value?.leadgen_id;
        const fieldData: any[] = change.value?.field_data || [];
        const payload: any = { fields: {}, source: 'Meta', utm: { campaign: change.value?.campaign_name, adId: change.value?.ad_id } };
        for (const f of fieldData) {
          const dest = formMap[f.name];
          const val = f.values?.[0];
          if (!dest) { payload.fields[`mx_${f.name}`] = val; continue; }
          if (dest.startsWith('fields.')) payload.fields[dest.slice(7)] = val;
          else payload[dest] = val;
        }
        payload.fields.mx_meta_leadgen_id = leadgenId;
        await withTenant(conn.tenant_id, c => captureLead(c, conn.tenant_id, payload, { id: null, type: 'connector:meta' }));
      }
    }
    res.status(200).json({ status: 'Success' });
  } catch (e) { sendError(res, e); }
});

// ---- WhatsApp Business Cloud API webhook ----
publicCaptureRouter.get('/whatsapp/:token', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken === config.whatsappVerifyToken) return res.status(200).send(challenge);
  res.status(403).send('Forbidden');
});
publicCaptureRouter.post('/whatsapp/:token', async (req, res) => {
  try {
    const conn = await findConnectorByToken(req.params.token, 'whatsapp');
    if (!conn) throw err(404, 'NOT_FOUND', 'Unknown connector');
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];
        for (const msg of messages) {
          const phone = normalizePhone(msg.from);
          const text = msg.text?.body || `[${msg.type}]`;
          const profileName = change.value?.contacts?.[0]?.profile?.name;
          await withTenant(conn.tenant_id, async c => {
            const cap = await captureLead(c, conn.tenant_id, {
              phone: phone || undefined, firstName: profileName, source: 'WhatsApp', consent: true, searchBy: 'phone',
            }, { id: null, type: 'connector:whatsapp' });
            await postActivity(c, conn.tenant_id, {
              leadId: cap.lead.id, typeName: 'WhatsApp Message Received', note: text, performedBy: null,
            });
          });
        }
      }
    }
    res.status(200).json({ status: 'Success' });
  } catch (e) { sendError(res, e); }
});
