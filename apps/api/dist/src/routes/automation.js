import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { audit } from '../audit.js';
import { requireFeature } from '../entitlements.js';
import { availableTokens } from '../merge.js';
export const automationRouter = Router();
function requireManage(req) {
    if (!req.auth.perms.settings?.manageAutomation && !req.auth.perms.settings?.manageRoles)
        throw err(403, 'FORBIDDEN', 'Missing settings permission: manageAutomation');
}
const ENTITIES = ['lead', 'opportunity', 'activity', 'task'];
const EVENTS = ['created', 'updated', 'field_changed', 'stage_changed', 'deleted'];
const ACTION_TYPES = ['update_lead', 'update_opportunity', 'create_opportunity', 'create_task', 'create_activity', 'reassign_owner', 'http_call', 'send_message'];
function validateRule(body) {
    const { name, trigger, actions } = body || {};
    if (!name)
        throw err(400, 'MISSING_FIELDS', 'name required');
    if (!trigger?.entity || !trigger?.event)
        throw err(400, 'MISSING_FIELDS', 'trigger.entity and trigger.event required');
    if (!ENTITIES.includes(trigger.entity))
        throw err(400, 'INVALID_VALUE', `trigger.entity must be one of ${ENTITIES.join('|')}`);
    if (!EVENTS.includes(trigger.event))
        throw err(400, 'INVALID_VALUE', `trigger.event must be one of ${EVENTS.join('|')}`);
    if (trigger.event === 'field_changed' && !trigger.field)
        throw err(400, 'MISSING_FIELDS', 'trigger.field is required when event is field_changed');
    if (!Array.isArray(actions) || !actions.length)
        throw err(400, 'MISSING_FIELDS', 'at least one action required');
    for (const a of actions) {
        if (!ACTION_TYPES.includes(a?.type))
            throw err(400, 'INVALID_VALUE', `Unknown action type: ${a?.type}. Allowed: ${ACTION_TYPES.join(', ')}`);
        if (a.type === 'http_call' && !a.url)
            throw err(400, 'MISSING_FIELDS', 'http_call action requires a url');
        if (a.type === 'create_task' && !a.name)
            throw err(400, 'MISSING_FIELDS', 'create_task action requires a name');
        if (a.type === 'send_message') {
            if (!['email', 'sms', 'whatsapp'].includes(a.channel || 'sms'))
                throw err(400, 'INVALID_VALUE', 'send_message channel must be email|sms|whatsapp');
            if (!a.body && !a.templateId)
                throw err(400, 'MISSING_FIELDS', 'send_message requires a body or templateId');
        }
    }
}
// Metadata for the rule builder UI: valid entities/events/action types + merge tokens.
automationRouter.get('/meta', async (req, res) => {
    try {
        const data = await withTenant(req.auth.tenantId, async (c) => ({
            entities: ENTITIES, events: EVENTS, actionTypes: ACTION_TYPES,
            tokens: {
                lead: await availableTokens(c, 'lead'),
                opportunity: await availableTokens(c, 'opportunity'),
                activity: await availableTokens(c, 'activity'),
            },
            activityTypes: (await c.query(`SELECT id, name FROM activity_types WHERE is_active ORDER BY name`)).rows,
            stages: (await c.query(`SELECT name FROM lead_stages ORDER BY sort_order`)).rows.map((r) => r.name),
        }));
        res.json(data);
    }
    catch (e) {
        sendError(res, e);
    }
});
automationRouter.get('/', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM automation_rules ORDER BY priority, created_at`)).rows);
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
automationRouter.post('/', requireFeature('automation'), async (req, res) => {
    try {
        requireManage(req);
        validateRule(req.body);
        const { name, description, trigger, conditions = [], actions, priority = 100, maxExecutionsPerRecord = 25 } = req.body;
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`INSERT INTO automation_rules (tenant_id, name, description, trigger, conditions, actions, priority, max_executions_per_record, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.auth.tenantId, name, description || null, JSON.stringify(trigger), JSON.stringify(conditions),
                JSON.stringify(actions), priority, maxExecutionsPerRecord, req.auth.userId]);
            await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'automation_rule.created', 'automation_rule', r.rows[0].id, null, r.rows[0]);
            return r.rows[0];
        });
        res.status(201).json(row);
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'RULE_EXISTS', 'A rule with this name already exists'));
        sendError(res, e);
    }
});
automationRouter.patch('/:id', requireFeature('automation'), async (req, res) => {
    try {
        requireManage(req);
        const { name, description, trigger, conditions, actions, isActive, priority, maxExecutionsPerRecord } = req.body || {};
        if (trigger || actions)
            validateRule({ name: name || 'x', trigger: trigger || { entity: 'lead', event: 'created' }, actions: actions || [{ type: 'create_task', name: 'x' }] });
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const cur = (await c.query(`SELECT * FROM automation_rules WHERE id=$1`, [req.params.id])).rows[0];
            if (!cur)
                return null;
            const r = await c.query(`UPDATE automation_rules SET name=COALESCE($2,name), description=COALESCE($3,description),
           trigger=COALESCE($4,trigger), conditions=COALESCE($5,conditions), actions=COALESCE($6,actions),
           is_active=COALESCE($7,is_active), priority=COALESCE($8,priority),
           max_executions_per_record=COALESCE($9,max_executions_per_record), updated_at=now()
         WHERE id=$1 RETURNING *`, [req.params.id, name, description, trigger ? JSON.stringify(trigger) : null,
                conditions ? JSON.stringify(conditions) : null, actions ? JSON.stringify(actions) : null,
                isActive, priority, maxExecutionsPerRecord]);
            await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'automation_rule.updated', 'automation_rule', req.params.id, cur, r.rows[0]);
            return r.rows[0];
        });
        if (!row)
            throw err(404, 'NOT_FOUND', 'Rule not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
automationRouter.delete('/:id', async (req, res) => {
    try {
        requireManage(req);
        await withTenant(req.auth.tenantId, async (c) => {
            const cur = (await c.query(`SELECT * FROM automation_rules WHERE id=$1`, [req.params.id])).rows[0];
            if (!cur)
                throw err(404, 'NOT_FOUND', 'Rule not found');
            await c.query(`DELETE FROM automation_rules WHERE id=$1`, [req.params.id]);
            await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'automation_rule.deleted', 'automation_rule', req.params.id, cur, null);
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
// Execution log — the debugging surface. Filterable by rule or record.
automationRouter.get('/executions', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => {
            const params = [];
            const clauses = ['1=1'];
            if (req.query.ruleId) {
                params.push(req.query.ruleId);
                clauses.push(`ae.rule_id = $${params.length}`);
            }
            if (req.query.entityId) {
                params.push(req.query.entityId);
                clauses.push(`ae.entity_id = $${params.length}`);
            }
            if (req.query.status) {
                params.push(req.query.status);
                clauses.push(`ae.status = $${params.length}`);
            }
            const limit = Math.min(200, parseInt(String(req.query.limit || '50')));
            params.push(limit);
            return (await c.query(`SELECT ae.*, ar.name AS rule_name FROM automation_executions ae
         JOIN automation_rules ar ON ar.id = ae.rule_id
         WHERE ${clauses.join(' AND ')} ORDER BY ae.id DESC LIMIT $${params.length}`, params)).rows;
        });
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
// Outbound HTTP call log (automation + custom actions) — "did my integration fire?"
automationRouter.get('/outbound-calls', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => {
            const limit = Math.min(200, parseInt(String(req.query.limit || '50')));
            return (await c.query(`SELECT * FROM outbound_calls ORDER BY id DESC LIMIT $1`, [limit])).rows;
        });
        res.json({ items: rows });
    }
    catch (e) {
        sendError(res, e);
    }
});
