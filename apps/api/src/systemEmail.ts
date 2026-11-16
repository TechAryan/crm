import type pg from 'pg';
import { control, withTenant } from './db.js';
import { safeHttpCall } from './http.js';
import { decryptSecrets } from './crypto.js';
import { config } from './config.js';

/**
 * System email — password resets, invitations, alerts.
 *
 * COST STRATEGY (this is the whole point of the design): we send system email through, in order:
 *
 *   1. The TENANT'S OWN email connector, if they've configured one.
 *      Cost to us: zero. Their provider, their quota, their sender identity — and their users
 *      get mail from their own domain, which is better for deliverability anyway.
 *
 *   2. A HOST-LEVEL provider, if configured (SYSTEM_EMAIL_* env vars).
 *      Needed for host-admin resets (no tenant context) and as a fallback for tenants who
 *      haven't connected anything. Resend's free tier is 3,000 emails/month — comfortably
 *      more than password resets for early customers, so this stays ₹0 in practice.
 *
 *   3. Nothing configured -> we return the reset link to the caller so an admin can pass it on
 *      manually. Never a hard failure: a customer must never be locked out because email isn't
 *      wired up yet.
 *
 * This ordering means the product works from day one at zero cost, and gets better (not more
 * expensive) as customers connect their own providers.
 */

export interface SystemEmailResult {
  sent: boolean;
  via: 'tenant_connector' | 'host_provider' | 'none';
  error?: string;
  /** Returned when nothing could send, so the UI can show the link for manual delivery. */
  fallbackLink?: string;
}

/** Host-level provider config, from env. Optional by design. */
function hostProvider() {
  const provider = process.env.SYSTEM_EMAIL_PROVIDER || '';   // resend | sendgrid
  const apiKey = process.env.SYSTEM_EMAIL_API_KEY || '';
  const from = process.env.SYSTEM_EMAIL_FROM || '';
  if (!provider || !apiKey || !from) return null;
  return { provider, apiKey, from, fromName: process.env.SYSTEM_EMAIL_FROM_NAME || 'NexCRM' };
}

export function hostEmailConfigured(): boolean { return hostProvider() !== null; }

async function sendViaHost(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  const hp = hostProvider();
  if (!hp) return { ok: false, error: 'No host email provider configured' };

  if (hp.provider === 'resend') {
    const r = await safeHttpCall({
      method: 'POST', url: 'https://api.resend.com/emails',
      headers: { authorization: `Bearer ${hp.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${hp.fromName} <${hp.from}>`, to: [to], subject, html }),
    });
    return { ok: r.ok, error: r.error || undefined };
  }
  if (hp.provider === 'sendgrid') {
    const r = await safeHttpCall({
      method: 'POST', url: 'https://api.sendgrid.com/v3/mail/send',
      headers: { authorization: `Bearer ${hp.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: hp.from, name: hp.fromName },
        subject, content: [{ type: 'text/html', value: html }],
      }),
    });
    return { ok: r.ok, error: r.error || undefined };
  }
  return { ok: false, error: `Unsupported system email provider: ${hp.provider}` };
}

/** Send using a tenant's own configured email connector (zero cost to us). */
async function sendViaTenantConnector(
  client: pg.PoolClient, tenantId: string, to: string, subject: string, html: string
): Promise<{ ok: boolean; error?: string }> {
  const conn = (await client.query(
    `SELECT * FROM connectors WHERE channel='email' AND is_active AND provider IS NOT NULL
     ORDER BY created_at LIMIT 1`)).rows[0];
  if (!conn) return { ok: false, error: 'No tenant email connector' };
  try {
    const { sendMessage } = await import('./messaging.js');
    const r = await sendMessage(client, tenantId, conn.id, { channel: 'email', to, subject, body: html });
    return { ok: r.ok, error: r.error || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Tenant connector send failed' };
  }
}

/**
 * Deliver a system email. `tenantId` null means host-level (admin) mail, which can only use the
 * host provider. Never throws — callers get a result they can surface.
 */
export async function sendSystemEmail(opts: {
  tenantId: string | null;
  to: string;
  subject: string;
  html: string;
  fallbackLink?: string;
}): Promise<SystemEmailResult> {
  // 1. Tenant's own provider first — free for us, better deliverability for them.
  if (opts.tenantId) {
    try {
      const r = await withTenant(opts.tenantId, c =>
        sendViaTenantConnector(c, opts.tenantId!, opts.to, opts.subject, opts.html));
      if (r.ok) return { sent: true, via: 'tenant_connector' };
    } catch (e) { /* fall through to the host provider */ }
  }

  // 2. Host provider.
  if (hostEmailConfigured()) {
    const r = await sendViaHost(opts.to, opts.subject, opts.html);
    if (r.ok) return { sent: true, via: 'host_provider' };
    return { sent: false, via: 'none', error: r.error, fallbackLink: opts.fallbackLink };
  }

  // 3. Nothing configured — hand the link back rather than locking anyone out.
  return {
    sent: false, via: 'none',
    error: 'No email provider configured (connect one in Settings > Messaging, or set SYSTEM_EMAIL_* on the server)',
    fallbackLink: opts.fallbackLink,
  };
}

/** Minimal, dependency-free HTML email. Kept plain so it renders everywhere. */
export function resetEmailHtml(opts: { name?: string; link: string; expiresHours: number; appName?: string }): string {
  const app = opts.appName || 'your CRM';
  const esc = (s: string) => String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6f8;padding:24px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:28px">
    <h2 style="margin:0 0 8px;font-size:18px">Reset your password</h2>
    <p style="color:#4b5563;font-size:14px;line-height:1.5">
      ${opts.name ? `Hi ${esc(opts.name)},` : 'Hi,'} we received a request to reset your ${esc(app)} password.
      This link is valid for ${opts.expiresHours} hours and can be used once.
    </p>
    <p style="margin:22px 0">
      <a href="${esc(opts.link)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;font-size:14px;display:inline-block">Set a new password</a>
    </p>
    <p style="color:#6b7280;font-size:12px;line-height:1.5">
      If the button doesn't work, paste this into your browser:<br>
      <span style="word-break:break-all">${esc(opts.link)}</span>
    </p>
    <p style="color:#6b7280;font-size:12px;margin-top:20px">
      If you didn't request this, you can safely ignore this email — your password won't change.
    </p>
  </div></body></html>`;
}
