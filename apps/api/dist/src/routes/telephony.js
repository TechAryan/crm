import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError, normalizePhone } from '../util.js';
import { requireFeature } from '../entitlements.js';
import { requireScope } from '../auth.js';
import { publishToUser, addSubscriber, pendingEvents, markDelivered, subscriberCount } from '../realtime.js';
import { applyFieldMask, loadPermissions } from '../permissions.js';
/**
 * Telephony connector — inbound screen-pop + agent event stream.
 *
 * The customer keeps whatever dialer they already use (Ameyo, Exotel, Knowlarity, Twilio…).
 * On an inbound call their system calls POST /v1/telephony/call-started with the caller's
 * number (or a leadId/opportunityId) plus a locator for the agent who took the call. We resolve
 * the agent and push a screen-pop to that ONE agent's browser — not to everyone logged in.
 *
 * Agent locator: any unique user field. `agentField` + `agentValue`, where agentField may be a
 * built-in (id | email | phone) or the schema name of a user custom field marked unique
 * (e.g. mx_agent_extension). This is why user fields support is_unique.
 *
 * Two modes, chosen per connector:
 *   navigate — open the matching record in the agent's browser
 *   popup    — show a card with connector-configured fields + the lead's opportunities and links
 */
export const telephonyRouter = Router();
export const eventsRouter = Router();
// ---------------------------------------------------------------------------
// Agent event stream (SSE). Any authenticated user subscribes to their OWN stream;
// scoping comes from the session, never from query params.
// ---------------------------------------------------------------------------
eventsRouter.get('/stream', async (req, res) => {
    try {
        const { tenantId, userId } = req.auth;
        const cleanup = addSubscriber(tenantId, userId, res);
        // Replay anything that arrived while this user had no open connection (e.g. a call that
        // came in during a page reload), so a screen-pop isn't lost to a race.
        try {
            for (const ev of await pendingEvents(tenantId, userId)) {
                res.write(`event: ${ev.kind}\n`);
                res.write(`data: ${JSON.stringify({ ...ev.data, eventId: ev.eventId, replayed: true })}\n\n`);
            }
        }
        catch (e) {
            console.error('pending event replay failed', e);
        }
        req.on('close', cleanup);
        req.on('error', cleanup);
    }
    catch (e) {
        // Headers may already be sent for a stream; only send JSON if not.
        if (!res.headersSent)
            sendError(res, e);
        else
            try {
                res.end();
            }
            catch { /* closed */ }
    }
});
eventsRouter.post('/ack/:eventId', async (req, res) => {
    try {
        await markDelivered(req.auth.tenantId, req.params.eventId);
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
eventsRouter.get('/status', async (req, res) => {
    try {
        res.json({
            connected: subscriberCount(req.auth.tenantId, req.auth.userId) > 0,
            connections: subscriberCount(req.auth.tenantId, req.auth.userId),
        });
    }
    catch (e) {
        sendError(res, e);
    }
});
// ---------------------------------------------------------------------------
// Inbound call -> screen-pop
// ---------------------------------------------------------------------------
const BUILTIN_AGENT_FIELDS = new Set(['id', 'userId', 'email', 'phone']);
/** Resolve the agent by a unique user field. Ambiguity is an error, never a guess. */
async function resolveAgent(c, agentField, agentValue) {
    if (BUILTIN_AGENT_FIELDS.has(agentField)) {
        const col = agentField === 'userId' || agentField === 'id' ? 'id' : agentField;
        if (col === 'id') {
            // Guard against a malformed uuid producing a DB error rather than a clean 404.
            if (!/^[0-9a-f-]{36}$/i.test(agentValue))
                throw err(400, 'INVALID_AGENT', 'agentValue is not a valid user id');
            return (await c.query(`SELECT * FROM users WHERE id=$1 AND is_active`, [agentValue])).rows[0];
        }
        const rows = (await c.query(`SELECT * FROM users WHERE lower(${col})=lower($1) AND is_active`, [agentValue])).rows;
        if (rows.length > 1)
            throw err(409, 'AMBIGUOUS_AGENT', `More than one active user has ${agentField}='${agentValue}'`);
        return rows[0];
    }
    // Custom user field — must exist and be marked unique, otherwise "which agent" is undefined.
    const def = (await c.query(`SELECT schema_name, is_unique FROM custom_field_defs WHERE entity='user' AND schema_name=$1 AND is_active`, [agentField])).rows[0];
    if (!def)
        throw err(400, 'UNKNOWN_AGENT_FIELD', `No active user field named '${agentField}'`);
    if (!def.is_unique)
        throw err(400, 'AGENT_FIELD_NOT_UNIQUE', `User field '${agentField}' is not marked unique, so it cannot identify a single agent. Mark it unique in Settings > User Fields.`);
    const rows = (await c.query(`SELECT * FROM users WHERE fields->>$1 = $2 AND is_active`, [agentField, String(agentValue)])).rows;
    if (rows.length > 1)
        throw err(409, 'AMBIGUOUS_AGENT', `More than one active user has ${agentField}='${agentValue}'`);
    return rows[0];
}
telephonyRouter.post('/call-started', requireScope('leads:read'), requireFeature('telephony'), async (req, res) => {
    try {
        // The caller must itself be allowed to read leads: this endpoint returns matched lead data
        // (and pushes it to an agent), so without this check an API key with no lead permission
        // could use it to probe which phone numbers exist in the CRM.
        if (!req.auth.perms.lead?.view)
            throw err(403, 'FORBIDDEN', 'No permission to view leads');
        const { phone, leadId, opportunityId, agentField = 'email', agentValue, direction = 'inbound', callId, connectorId, } = req.body || {};
        if (!phone && !leadId && !opportunityId)
            throw err(400, 'MISSING_FIELDS', 'Provide phone, leadId, or opportunityId');
        if (!agentValue)
            throw err(400, 'MISSING_FIELDS', 'agentValue is required so we know whose screen to pop (with agentField, default "email")');
        const out = await withTenant(req.auth.tenantId, async (c) => {
            const agent = await resolveAgent(c, agentField, agentValue);
            if (!agent)
                throw err(404, 'AGENT_NOT_FOUND', `No active user matched ${agentField}='${agentValue}'`);
            // Connector config decides the mode and which fields the popup shows.
            let cfg = {};
            if (connectorId) {
                const conn = (await c.query(`SELECT config FROM connectors WHERE id=$1 AND channel='telephony' AND is_active`, [connectorId])).rows[0];
                cfg = conn?.config || {};
            }
            else {
                const conn = (await c.query(`SELECT config FROM connectors WHERE channel='telephony' AND is_active ORDER BY created_at LIMIT 1`)).rows[0];
                cfg = conn?.config || {};
            }
            const mode = cfg.screenPopMode === 'popup' ? 'popup' : 'navigate';
            const popupFields = Array.isArray(cfg.popupFields) && cfg.popupFields.length
                ? cfg.popupFields
                : ['first_name', 'last_name', 'phone', 'email', 'stage', 'owner'];
            // ---- Match the record ----
            let lead = null, opportunity = null, ambiguous = false;
            let candidates;
            if (opportunityId) {
                opportunity = (await c.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [opportunityId])).rows[0];
                if (opportunity?.lead_id)
                    lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [opportunity.lead_id])).rows[0];
            }
            else if (leadId) {
                lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [leadId])).rows[0];
            }
            else if (phone) {
                const norm = normalizePhone(phone);
                // Match on either phone column. Trailing-digits match handles country-code differences
                // between what the dialer reports and what's stored.
                const rows = (await c.query(`SELECT * FROM leads
           WHERE deleted_at IS NULL AND (phone = $1 OR additional_phone = $1
              OR right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = right(regexp_replace($1, '\\D', '', 'g'), 10))
           ORDER BY updated_at DESC LIMIT 5`, [norm])).rows;
                if (rows.length === 1)
                    lead = rows[0];
                else if (rows.length > 1) {
                    // Never guess in front of a live caller — offer a chooser instead.
                    ambiguous = true;
                    lead = null;
                    candidates = rows.map((r) => ({
                        id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email || r.phone,
                        phone: r.phone, email: r.email,
                    }));
                }
            }
            // Respect the agent's own field-level security: resolve the permission sets that apply to
            // this agent and mask anything they aren't allowed to see, so a screen-pop can't become a
            // side channel around field-level security.
            const agentPerms = await loadPermissions(c, agent.id, agent.role_id);
            const maskedLead = lead ? applyFieldMask(lead, agentPerms.lead.fieldRules?.hidden || []) : null;
            let opportunities = [];
            if (lead) {
                opportunities = (await c.query(`SELECT id, name, stage, status, amount, currency FROM opportunities
           WHERE lead_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`, [lead.id])).rows;
            }
            const payload = {
                mode,
                direction,
                callId: callId || null,
                phone: phone || null,
                matched: !!(lead || opportunity),
                ambiguous,
                candidates,
                lead: maskedLead ? {
                    id: maskedLead.id, first_name: maskedLead.first_name, last_name: maskedLead.last_name,
                    email: maskedLead.email, phone: maskedLead.phone, additional_phone: maskedLead.additional_phone,
                    stage_id: maskedLead.stage_id, owner_id: maskedLead.owner_id, score: maskedLead.score,
                    fields: maskedLead.fields, lead_number: maskedLead.lead_number,
                } : null,
                opportunity: opportunity ? {
                    id: opportunity.id, name: opportunity.name, stage: opportunity.stage,
                    status: opportunity.status, amount: opportunity.amount,
                } : null,
                opportunities,
                popupFields,
                // Where the UI should send the agent.
                navigateTo: opportunity ? `/opportunities/${opportunity.id}` : lead ? `/leads/${lead.id}` : null,
            };
            const pub = await publishToUser(req.auth.tenantId, agent.id, 'screenpop', payload);
            return {
                agentId: agent.id,
                matched: payload.matched,
                ambiguous,
                mode,
                eventId: pub.eventId,
                deliveredLive: pub.liveDelivery,
                navigateTo: payload.navigateTo,
            };
        });
        res.status(200).json({ status: 'Success', ...out });
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Convenience: resolve a caller number to a lead without pushing an event.
 * Useful for dialers that render their own UI and just need the CRM context.
 */
telephonyRouter.get('/lookup', requireScope('leads:read'), requireFeature('telephony'), async (req, res) => {
    try {
        if (!req.auth.perms.lead?.view)
            throw err(403, 'FORBIDDEN', 'No permission to view leads');
        const phone = normalizePhone(String(req.query.phone || ''));
        if (!phone)
            throw err(400, 'MISSING_FIELDS', 'phone query param required');
        const rows = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT id, first_name, last_name, email, phone, stage_id, owner_id, score FROM leads
       WHERE deleted_at IS NULL AND (phone=$1 OR additional_phone=$1
         OR right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = right(regexp_replace($1, '\\D', '', 'g'), 10))
       ORDER BY updated_at DESC LIMIT 5`, [phone])).rows);
        res.json({ items: rows, count: rows.length });
    }
    catch (e) {
        sendError(res, e);
    }
});
