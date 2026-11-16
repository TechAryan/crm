import { safeHttpCall } from './http.js';
import { decryptSecrets } from './crypto.js';
import { mergeString, mergeMap, mergeJsonBody } from './merge.js';
import { err } from './util.js';
export const PROVIDERS = {
    gupshup: {
        key: 'gupshup', label: 'Gupshup', channels: ['whatsapp', 'sms'],
        secretFields: [{ key: 'apiKey', label: 'API Key', hint: 'Gupshup dashboard → API key' }],
        configFields: [
            { key: 'source', label: 'Source number', hint: 'Your registered WhatsApp/SMS sender number' },
            { key: 'appName', label: 'App name', hint: 'Gupshup app name' },
        ],
        docsUrl: 'https://docs.gupshup.io/',
    },
    twilio: {
        key: 'twilio', label: 'Twilio', channels: ['sms', 'whatsapp'],
        secretFields: [
            { key: 'accountSid', label: 'Account SID' },
            { key: 'authToken', label: 'Auth Token' },
        ],
        configFields: [{ key: 'from', label: 'From number', hint: 'e.g. +14155551234, or whatsapp:+1415…' }],
        docsUrl: 'https://www.twilio.com/docs',
    },
    msg91: {
        key: 'msg91', label: 'MSG91', channels: ['sms', 'whatsapp', 'email'],
        secretFields: [{ key: 'authKey', label: 'Auth Key' }],
        configFields: [
            { key: 'senderId', label: 'Sender ID', hint: 'DLT-registered sender id (India)' },
            { key: 'templateId', label: 'Default template id', hint: 'Optional' },
        ],
        docsUrl: 'https://docs.msg91.com/',
    },
    sendgrid: {
        key: 'sendgrid', label: 'SendGrid', channels: ['email'],
        secretFields: [{ key: 'apiKey', label: 'API Key' }],
        configFields: [
            { key: 'fromEmail', label: 'From email', hint: 'Must be a verified sender in SendGrid' },
            { key: 'fromName', label: 'From name' },
        ],
        docsUrl: 'https://docs.sendgrid.com/',
    },
    resend: {
        key: 'resend', label: 'Resend', channels: ['email'],
        secretFields: [{ key: 'apiKey', label: 'API Key' }],
        configFields: [
            { key: 'fromEmail', label: 'From email', hint: 'Must be on a verified domain' },
            { key: 'fromName', label: 'From name' },
        ],
        docsUrl: 'https://resend.com/docs',
    },
    custom: {
        key: 'custom', label: 'Custom HTTP API', channels: ['email', 'sms', 'whatsapp'],
        secretFields: [
            { key: 'token', label: 'Token / API key', hint: 'Referenced in headers as {{secret.token}}' },
        ],
        configFields: [
            { key: 'url', label: 'Endpoint URL', hint: 'https only' },
            { key: 'method', label: 'HTTP method', hint: 'POST (default)' },
            { key: 'headersJson', label: 'Headers (JSON)', hint: 'May use {{secret.*}} tokens' },
            { key: 'bodyTemplate', label: 'Body template', hint: 'May use {{to}}, {{subject}}, {{body}}, {{secret.*}}' },
        ],
    },
};
/** Build the concrete HTTP request for a provider + message. */
function buildRequest(provider, cfg, secrets, msg) {
    const sctx = { secret: secrets, to: msg.to, subject: msg.subject || '', body: msg.body, config: cfg };
    switch (provider) {
        case 'gupshup': {
            if (msg.channel === 'whatsapp') {
                const params = new URLSearchParams({
                    channel: 'whatsapp', source: cfg.source || '', destination: msg.to,
                    message: JSON.stringify({ type: 'text', text: msg.body }),
                    'src.name': cfg.appName || '',
                });
                return {
                    url: 'https://api.gupshup.io/wa/api/v1/msg', method: 'POST',
                    headers: { apikey: secrets.apiKey || '', 'content-type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                };
            }
            const params = new URLSearchParams({
                method: 'SendMessage', userid: cfg.userId || '', password: secrets.apiKey || '',
                send_to: msg.to, msg: msg.body, msg_type: 'TEXT', auth_scheme: 'PLAIN',
            });
            return { url: 'https://enterprise.smsgupshup.com/GatewayAPI/rest', method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() };
        }
        case 'twilio': {
            const sid = secrets.accountSid || '';
            const params = new URLSearchParams({
                To: msg.channel === 'whatsapp' && !msg.to.startsWith('whatsapp:') ? `whatsapp:${msg.to}` : msg.to,
                From: cfg.from || '', Body: msg.body,
            });
            return {
                url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
                method: 'POST',
                headers: {
                    authorization: `Basic ${Buffer.from(`${sid}:${secrets.authToken || ''}`).toString('base64')}`,
                    'content-type': 'application/x-www-form-urlencoded',
                },
                body: params.toString(),
            };
        }
        case 'msg91': {
            if (msg.channel === 'email') {
                return {
                    url: 'https://control.msg91.com/api/v5/email/send', method: 'POST',
                    headers: { authkey: secrets.authKey || '', 'content-type': 'application/json' },
                    body: JSON.stringify({
                        to: [{ email: msg.to }],
                        from: { email: cfg.fromEmail || '', name: cfg.fromName || '' },
                        subject: msg.subject || '', body: msg.body,
                    }),
                };
            }
            return {
                url: 'https://control.msg91.com/api/v5/flow/', method: 'POST',
                headers: { authkey: secrets.authKey || '', 'content-type': 'application/json' },
                body: JSON.stringify({
                    template_id: msg.providerTemplateId || cfg.templateId || '',
                    sender: cfg.senderId || '',
                    recipients: [{ mobiles: msg.to, body: msg.body }],
                }),
            };
        }
        case 'sendgrid':
            return {
                url: 'https://api.sendgrid.com/v3/mail/send', method: 'POST',
                headers: { authorization: `Bearer ${secrets.apiKey || ''}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    personalizations: [{ to: [{ email: msg.to }] }],
                    from: { email: cfg.fromEmail || '', name: cfg.fromName || undefined },
                    subject: msg.subject || '(no subject)',
                    content: [{ type: 'text/html', value: msg.body }],
                }),
            };
        case 'resend':
            return {
                url: 'https://api.resend.com/emails', method: 'POST',
                headers: { authorization: `Bearer ${secrets.apiKey || ''}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    from: cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail,
                    to: [msg.to], subject: msg.subject || '(no subject)', html: msg.body,
                }),
            };
        case 'custom': {
            if (!cfg.url)
                throw err(400, 'CONNECTOR_MISCONFIGURED', 'Custom provider requires a url in config');
            let headers = {};
            if (cfg.headersJson) {
                try {
                    headers = mergeMap(JSON.parse(cfg.headersJson), sctx);
                }
                catch {
                    throw err(400, 'CONNECTOR_MISCONFIGURED', 'Custom provider headers must be valid JSON');
                }
            }
            const body = cfg.bodyTemplate ? mergeJsonBody(String(cfg.bodyTemplate), sctx) : JSON.stringify({ to: msg.to, subject: msg.subject, body: msg.body });
            return { url: mergeString(String(cfg.url), sctx), method: (cfg.method || 'POST').toUpperCase(), headers, body };
        }
        default:
            throw err(400, 'UNKNOWN_PROVIDER', `Unsupported messaging provider: ${provider}`);
    }
}
/** Pull a provider message id out of the response so replies/status can be correlated later. */
function extractMessageId(provider, body) {
    try {
        const j = JSON.parse(body);
        return j.messageId || j.message_id || j.sid || j.id ||
            (Array.isArray(j.data) ? j.data[0]?.id : null) || null;
    }
    catch {
        // Some providers (older Gupshup SMS) return plain text like "success | 91xxxx | id"
        const m = provider === 'gupshup' ? body.match(/\|\s*([0-9a-zA-Z-]+)\s*$/) : null;
        return m?.[1] || null;
    }
}
/**
 * Send one message through a tenant's connector and log the attempt.
 * Never throws for provider-side failures — the log row carries the error so a failed send
 * doesn't roll back the surrounding operation (e.g. an automation run).
 */
export async function sendMessage(client, tenantId, connectorId, msg, ctx = {}) {
    const conn = (await client.query(`SELECT * FROM connectors WHERE id=$1 AND is_active`, [connectorId])).rows[0];
    if (!conn)
        throw err(404, 'NOT_FOUND', 'Messaging connector not found or inactive');
    if (!conn.provider)
        throw err(400, 'CONNECTOR_MISCONFIGURED', 'Connector has no provider set');
    const def = PROVIDERS[conn.provider];
    if (!def)
        throw err(400, 'UNKNOWN_PROVIDER', `Unsupported provider: ${conn.provider}`);
    if (!def.channels.includes(msg.channel))
        throw err(400, 'CHANNEL_UNSUPPORTED', `${def.label} does not support ${msg.channel}`);
    if (!msg.to)
        throw err(400, 'MISSING_FIELDS', 'Recipient (to) is required');
    const secrets = decryptSecrets(conn.secrets_encrypted);
    const cfg = conn.config || {};
    let result;
    try {
        const rq = buildRequest(conn.provider, cfg, secrets, msg);
        const r = await safeHttpCall({ method: rq.method, url: rq.url, headers: rq.headers, body: rq.body, timeoutMs: 15_000 });
        result = {
            ok: r.ok, status: r.status, response: r.body.slice(0, 2000),
            providerMessageId: r.ok ? extractMessageId(conn.provider, r.body) : null,
            error: r.error,
        };
    }
    catch (e) {
        // Config/SSRF rejections land here — record them as a failed send rather than a 500.
        result = { ok: false, status: null, response: '', providerMessageId: null, error: e?.message || 'Send failed' };
    }
    await client.query(`INSERT INTO message_log (tenant_id, connector_id, channel, to_address, template_id, subject, body,
       status, provider_message_id, provider_response, error, lead_id, opportunity_id, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [tenantId, connectorId, msg.channel, msg.to, ctx.templateId || null, msg.subject || null,
        msg.body.slice(0, 4000), result.ok ? 'sent' : 'failed', result.providerMessageId,
        result.response, result.error, ctx.leadId || null, ctx.opportunityId || null, ctx.actorId || null]);
    await client.query(`UPDATE connectors SET last_used_at=now(), last_error=$2 WHERE id=$1`, [connectorId, result.ok ? null : result.error]);
    return result;
}
/** Pick a default connector for a channel when the caller didn't name one. */
export async function defaultConnectorFor(client, channel) {
    const row = (await client.query(`SELECT id FROM connectors WHERE channel=$1 AND is_active AND provider IS NOT NULL
     ORDER BY created_at LIMIT 1`, [channel])).rows[0];
    return row?.id || null;
}
