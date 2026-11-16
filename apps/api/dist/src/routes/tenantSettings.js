import { Router } from 'express';
import { control, withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { audit } from '../audit.js';
import { RETENTION_DEFAULTS } from '../retention.js';
export const tenantSettingsRouter = Router();
const DEFAULTS = {
    defaultOwnerMode: 'system', // 'system' | 'user' | 'field'
    defaultOwnerUserId: null,
    defaultOwnerFieldRules: [],
    cascadeOwnerToOpportunity: true,
    cascadeOwnerToTask: true,
    hierarchyVisibility: true,
    phoneClickAction: 'tel', // 'tel' | 'url_template'
    phoneClickUrlTemplate: null,
    leadPropertiesLayout: ['phone', 'additional_phone', 'email', 'owner', 'source', 'score'],
    // 'realtime' assigns on capture; 'scheduled' leaves leads unowned for a daily sweep
    // (some teams prefer the whole day's leads divided evenly each morning).
    distributionMode: 'realtime', // 'realtime' | 'scheduled'
    distributionRunHour: 9, // UTC hour for the scheduled sweep
    lastDistributionRun: null,
    // Log retention. Tenants can SEE this but only the host admin can raise it (longer history
    // costs us storage, so it's a paid upgrade) — enforced below.
    retention: RETENTION_DEFAULTS,
    // 'internal' = admin/manager performs resets (no email provider needed — the default, so a
    // customer never has to buy an email service just to recover a password).
    // 'email'    = self-serve "forgot password" by email; requires a connected email connector.
    // Switchable back to 'internal' instantly if their provider fails or their billing lapses.
    passwordResetMode: 'internal', // 'internal' | 'email'
    allowManagerPasswordReset: true, // may a manager reset for their reports?
};
/** Keys a tenant admin may never change themselves — these are commercial levers. */
const HOST_ONLY_KEYS = new Set(['retention']);
function requireManage(req) {
    if (!req.auth.perms.settings?.manageRoles)
        throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
}
tenantSettingsRouter.get('/', async (req, res) => {
    try {
        const row = (await control(c => c.query(`SELECT settings FROM tenants WHERE id=$1`, [req.auth.tenantId]))).rows[0];
        res.json({ ...DEFAULTS, ...(row?.settings || {}) });
    }
    catch (e) {
        sendError(res, e);
    }
});
tenantSettingsRouter.patch('/', async (req, res) => {
    try {
        requireManage(req);
        const body = req.body || {};
        const allowedKeys = Object.keys(DEFAULTS);
        const patch = {};
        for (const k of allowedKeys)
            if (k in body)
                patch[k] = body[k];
        // Retention is a billable limit: a tenant raising it themselves would be raising our costs.
        for (const k of Object.keys(patch)) {
            if (HOST_ONLY_KEYS.has(k))
                throw err(403, 'HOST_MANAGED_SETTING', `"${k}" can only be changed by your account manager. Contact us to adjust it.`);
        }
        if (patch.defaultOwnerMode && !['system', 'user', 'field'].includes(patch.defaultOwnerMode))
            throw err(400, 'INVALID_VALUE', 'defaultOwnerMode must be system|user|field');
        if (patch.phoneClickAction && !['tel', 'url_template'].includes(patch.phoneClickAction))
            throw err(400, 'INVALID_VALUE', 'phoneClickAction must be tel|url_template');
        if (patch.phoneClickAction === 'url_template' && !patch.phoneClickUrlTemplate && !('phoneClickUrlTemplate' in body))
            throw err(400, 'MISSING_FIELDS', 'phoneClickUrlTemplate required when phoneClickAction is url_template');
        if (patch.defaultOwnerFieldRules && !Array.isArray(patch.defaultOwnerFieldRules))
            throw err(400, 'INVALID_VALUE', 'defaultOwnerFieldRules must be an array');
        if (patch.leadPropertiesLayout && !Array.isArray(patch.leadPropertiesLayout))
            throw err(400, 'INVALID_VALUE', 'leadPropertiesLayout must be an array');
        if (patch.distributionMode && !['realtime', 'scheduled'].includes(patch.distributionMode))
            throw err(400, 'INVALID_VALUE', 'distributionMode must be realtime|scheduled');
        if (patch.passwordResetMode) {
            if (!['internal', 'email'].includes(patch.passwordResetMode))
                throw err(400, 'INVALID_VALUE', 'passwordResetMode must be internal|email');
            // Refuse to switch to email mode without a working email connector — otherwise users
            // would click "forgot password" and silently receive nothing.
            if (patch.passwordResetMode === 'email') {
                const hasConnector = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT 1 FROM connectors WHERE channel='email' AND is_active AND provider IS NOT NULL LIMIT 1`)).rowCount);
                if (!hasConnector)
                    throw err(400, 'NO_EMAIL_CONNECTOR', 'Connect an active email provider under Settings > Messaging before enabling email-based password reset.');
            }
        }
        if (patch.distributionRunHour !== undefined && patch.distributionRunHour !== null &&
            (!Number.isInteger(patch.distributionRunHour) || patch.distributionRunHour < 0 || patch.distributionRunHour > 23))
            throw err(400, 'INVALID_VALUE', 'distributionRunHour must be an integer 0-23 (UTC)');
        // Capture the before-state so the audit trail records what actually changed, not just that
        // "settings were updated" — "who changed what, when" is the whole point of settings audit.
        const before = (await control(c => c.query(`SELECT settings FROM tenants WHERE id=$1`, [req.auth.tenantId]))).rows[0]?.settings || {};
        const row = (await control(c => c.query(`UPDATE tenants SET settings = settings || $2::jsonb, updated_at=now() WHERE id=$1 RETURNING settings`, [req.auth.tenantId, JSON.stringify(patch)]))).rows[0];
        // Only the keys that actually changed, so the log stays readable.
        const changed = {};
        for (const k of Object.keys(patch)) {
            if (JSON.stringify(before[k]) !== JSON.stringify(patch[k]))
                changed[k] = { from: before[k] ?? null, to: patch[k] };
        }
        if (Object.keys(changed).length) {
            await withTenant(req.auth.tenantId, c => audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'settings.updated', 'settings', null, before, { changed }));
        }
        res.json({ ...DEFAULTS, ...(row?.settings || {}) });
    }
    catch (e) {
        sendError(res, e);
    }
});
