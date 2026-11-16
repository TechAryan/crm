import type pg from 'pg';
import { matches } from './distribution.js';
import { safeHttpCall } from './http.js';
import { mergeString, mergeJsonBody, mergeMap, buildMergeContext } from './merge.js';
import { hasFeature } from './entitlements.js';
import { audit } from './audit.js';
import { sendMessage, defaultConnectorFor } from './messaging.js';

/**
 * Automation engine.
 *
 * Fires on record changes, evaluates conditions, then runs actions — internal record CRUD
 * and/or guarded outbound HTTP calls. Every run is logged per-step to automation_executions,
 * because an automation you cannot debug is worse than no automation at all.
 *
 * TRIGGER SHAPE
 *   { entity: 'lead'|'opportunity'|'activity'|'task',
 *     event : 'created'|'updated'|'field_changed'|'stage_changed'|'deleted',
 *     field?: 'mx_city' | 'stage' | ...     // for field_changed
 *     toValue?: 'Qualified',                // fire only when the new value equals this
 *     fromValue?: 'New',                    // fire only when the old value equals this
 *     activityTypeId?: uuid }               // for activity triggers: only this type
 *
 * ACTION SHAPES
 *   { type:'update_lead',        patch:{ stage?, ownerId?, fields?{} } }
 *   { type:'update_opportunity', patch:{ stage?, ownerId?, amount?, fields?{} } }
 *   { type:'create_task',        name, kind?, dueInDays?, ownerId?|'record_owner' }
 *   { type:'create_activity',    typeName|typeId, note?, fields?{} }
 *   { type:'reassign_owner',     ownerId }
 *   { type:'http_call',          method, url, headers?, body?, allowHttp? }
 *
 * LOOP PROTECTION — critical. An action that writes a field can re-trigger the same rule.
 * Two independent guards:
 *   1. An async-local depth counter: automation-caused changes run at depth+1, and we refuse
 *      to cascade beyond MAX_DEPTH.
 *   2. A per-rule/per-record execution ceiling (max_executions_per_record) checked against
 *      the execution log, so a slow loop across separate requests is also stopped.
 */

const MAX_DEPTH = 3;

/** Tracks automation recursion depth for the current logical operation. */
let currentDepth = 0;
export function automationDepth() { return currentDepth; }

export interface TriggerContext {
  entity: 'lead' | 'opportunity' | 'activity' | 'task';
  event: 'created' | 'updated' | 'field_changed' | 'stage_changed' | 'deleted';
  record: any;
  before?: any | null;
  changedFields?: string[];
  activityTypeId?: string | null;
  actorId?: string | null;
  actorType?: string;
}

function valueOf(record: any, field: string): any {
  if (!record) return undefined;
  if (field.startsWith('fields.')) return record.fields?.[field.slice(7)];
  if (record.fields && field in record.fields && !(field in record)) return record.fields[field];
  return record[field];
}

const sameStr = (a: any, b: any) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Does this rule's trigger match what just happened? */
export function triggerMatches(trigger: any, ctx: TriggerContext, resolved: { stageName?: string; prevStageName?: string } = {}): boolean {
  if (!trigger || trigger.entity !== ctx.entity) return false;

  // Activity-type narrowing: "when an *Incoming Call* activity is created"
  if (trigger.activityTypeId && ctx.activityTypeId && trigger.activityTypeId !== ctx.activityTypeId) return false;

  switch (trigger.event) {
    case 'created':
      return ctx.event === 'created';

    case 'deleted':
      return ctx.event === 'deleted';

    case 'stage_changed': {
      if (ctx.event !== 'stage_changed' && !(ctx.changedFields || []).includes('stage_id') &&
          !(ctx.changedFields || []).includes('stage')) return false;
      // Compare against human-readable stage names where we have them (rules are authored
      // with names like "Qualified", not stage UUIDs).
      const to = resolved.stageName ?? valueOf(ctx.record, 'stage');
      const from = resolved.prevStageName ?? valueOf(ctx.before, 'stage');
      if (trigger.toValue && !sameStr(to, trigger.toValue)) return false;
      if (trigger.fromValue && !sameStr(from, trigger.fromValue)) return false;
      return true;
    }

    case 'field_changed': {
      if (ctx.event === 'created') return false;
      if (!trigger.field) return false;
      const bare = trigger.field.startsWith('fields.') ? trigger.field.slice(7) : trigger.field;
      const changed = ctx.changedFields || [];
      const didChange = changed.includes(trigger.field) || changed.includes(bare) ||
        (bare === 'stage' && changed.includes('stage_id')) ||
        (bare === 'owner' && changed.includes('owner_id'));
      if (!didChange) return false;
      if (trigger.toValue !== undefined && trigger.toValue !== null && trigger.toValue !== '') {
        const to = bare === 'stage' ? (resolved.stageName ?? valueOf(ctx.record, 'stage')) : valueOf(ctx.record, trigger.field);
        if (!sameStr(to, trigger.toValue)) return false;
      }
      if (trigger.fromValue !== undefined && trigger.fromValue !== null && trigger.fromValue !== '') {
        const from = bare === 'stage' ? (resolved.prevStageName ?? valueOf(ctx.before, 'stage')) : valueOf(ctx.before, trigger.field);
        if (!sameStr(from, trigger.fromValue)) return false;
      }
      return true;
    }

    case 'updated':
      return ctx.event === 'updated' || ctx.event === 'field_changed' || ctx.event === 'stage_changed';

    default:
      return false;
  }
}

/** Resolve stage ids → names so both conditions and triggers can use readable values. */
async function resolveStageNames(client: pg.PoolClient, ctx: TriggerContext) {
  const out: { stageName?: string; prevStageName?: string } = {};
  if (ctx.entity === 'lead') {
    if (ctx.record?.stage_id) {
      out.stageName = (await client.query(`SELECT name FROM lead_stages WHERE id=$1`, [ctx.record.stage_id])).rows[0]?.name;
    }
    if (ctx.before?.stage_id) {
      out.prevStageName = (await client.query(`SELECT name FROM lead_stages WHERE id=$1`, [ctx.before.stage_id])).rows[0]?.name;
    }
  } else if (ctx.entity === 'opportunity') {
    out.stageName = ctx.record?.stage;
    out.prevStageName = ctx.before?.stage;
  }
  return out;
}

/**
 * Main entry point — call after a record write, inside the same transaction/client.
 * Never throws: an automation failure must not roll back the user's actual edit. Failures
 * are recorded in the execution log instead.
 */
export async function runAutomations(client: pg.PoolClient, tenantId: string, ctx: TriggerContext): Promise<void> {
  try {
    if (currentDepth >= MAX_DEPTH) return;                       // guard 1: cascade depth
    if (!(await hasFeature(tenantId, 'automation'))) return;     // paid feature

    const { rows: rules } = await client.query(
      `SELECT * FROM automation_rules WHERE is_active ORDER BY priority ASC, created_at ASC`);
    if (!rules.length) return;

    const resolved = await resolveStageNames(client, ctx);

    for (const rule of rules) {
      if (!triggerMatches(rule.trigger, ctx, resolved)) continue;

      // Conditions run against a shaped record so 'stage' means the stage name.
      const shaped = { ...ctx.record, fields: ctx.record?.fields || {} };
      if (resolved.stageName !== undefined) shaped.stage = resolved.stageName;
      if (!matches(rule.conditions || [], shaped)) continue;

      // guard 2: per-rule/per-record ceiling (catches loops spread across requests)
      const recordId = ctx.record?.id || null;
      if (recordId) {
        const { rows: cnt } = await client.query(
          `SELECT COUNT(*)::int AS n FROM automation_executions
           WHERE rule_id=$1 AND entity_id=$2 AND status <> 'skipped'`, [rule.id, recordId]);
        if (cnt[0].n >= (rule.max_executions_per_record || 25)) {
          await logExecution(client, tenantId, rule.id, ctx, 'skipped', [], 'Execution ceiling reached for this record (possible rule loop)');
          continue;
        }
      }

      const steps: any[] = [];
      let failed = 0;
      currentDepth++;
      try {
        for (const action of rule.actions || []) {
          try {
            const detail = await runAction(client, tenantId, action, ctx, rule.id);
            steps.push({ action: action.type, status: 'success', detail });
          } catch (e: any) {
            failed++;
            steps.push({ action: action.type, status: 'failed', detail: e?.message || String(e) });
          }
        }
      } finally {
        currentDepth--;
      }

      const status = failed === 0 ? 'success' : (failed === (rule.actions || []).length ? 'failed' : 'partial');
      await logExecution(client, tenantId, rule.id, ctx, status, steps, null);
    }
  } catch (e) {
    // Automation must never break the originating operation.
    console.error('runAutomations error', e);
  }
}

async function logExecution(
  client: pg.PoolClient, tenantId: string, ruleId: string, ctx: TriggerContext,
  status: string, steps: any[], error: string | null
) {
  try {
    await client.query(
      `INSERT INTO automation_executions (tenant_id, rule_id, entity, entity_id, status, trigger_event, steps, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, ruleId, ctx.entity, ctx.record?.id || null, status, ctx.event, JSON.stringify(steps), error]);
  } catch (e) { console.error('automation log failed', e); }
}

/** Execute one action. Throws on failure so the caller records it as a failed step. */
async function runAction(
  client: pg.PoolClient, tenantId: string, action: any, ctx: TriggerContext, ruleId: string
): Promise<string> {
  const entity = ctx.entity === 'task' ? 'lead' : ctx.entity;
  const mergeCtx = await buildMergeContext(client, entity as any, ctx.record, {
    user: { name: 'Automation', email: '' },
  });

  const leadId = ctx.entity === 'lead' ? ctx.record?.id : ctx.record?.lead_id;

  switch (action.type) {
    case 'update_lead': {
      if (!leadId) throw new Error('No lead in context to update');
      const patch = action.patch || {};
      const sets: string[] = [];
      const params: any[] = [leadId];
      let stageId: string | null = null;
      if (patch.stage) {
        const s = (await client.query(`SELECT id FROM lead_stages WHERE name=$1`, [mergeString(String(patch.stage), mergeCtx)])).rows[0];
        if (!s) throw new Error(`Unknown stage: ${patch.stage}`);
        stageId = s.id;
        params.push(stageId); sets.push(`stage_id=$${params.length}`);
      }
      if (patch.ownerId) { params.push(patch.ownerId); sets.push(`owner_id=$${params.length}`); }
      if (patch.fields && Object.keys(patch.fields).length) {
        const merged: Record<string, any> = {};
        for (const [k, v] of Object.entries(patch.fields)) merged[k] = typeof v === 'string' ? mergeString(v, mergeCtx) : v;
        params.push(JSON.stringify(merged)); sets.push(`fields = fields || $${params.length}::jsonb`);
      }
      if (!sets.length) throw new Error('update_lead action has an empty patch');
      const before = (await client.query(`SELECT * FROM leads WHERE id=$1`, [leadId])).rows[0];
      const after = (await client.query(
        `UPDATE leads SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, params)).rows[0];
      await audit(client, tenantId, null, 'automation', 'lead.updated', 'lead', leadId, before, after);
      // Cascade: let other rules react to this change, bounded by MAX_DEPTH.
      await runAutomations(client, tenantId, {
        entity: 'lead', event: 'updated', record: after, before,
        changedFields: sets.map(s => s.split('=')[0].trim()), actorType: 'automation',
      });
      return `Updated lead ${leadId}`;
    }

    case 'reassign_owner': {
      if (!action.ownerId) throw new Error('reassign_owner requires ownerId');
      const table = ctx.entity === 'opportunity' ? 'opportunities' : 'leads';
      const id = ctx.record?.id;
      await client.query(`UPDATE ${table} SET owner_id=$2, updated_at=now() WHERE id=$1`, [id, action.ownerId]);
      return `Reassigned ${ctx.entity} ${id}`;
    }

    case 'update_opportunity': {
      const oppId = ctx.entity === 'opportunity' ? ctx.record?.id : action.opportunityId;
      if (!oppId) throw new Error('No opportunity in context to update');
      const patch = action.patch || {};
      const cur = (await client.query(`SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, [oppId])).rows[0];
      if (!cur) throw new Error('Opportunity not found');
      let status = cur.status;
      if (patch.stage) {
        const type = (await client.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [cur.opportunity_type_id])).rows[0];
        const st = (type?.stages || []).find((x: any) => x.name === patch.stage);
        if (!st) throw new Error(`Unknown opportunity stage: ${patch.stage}`);
        status = st.status;
      }
      const mergedFields = patch.fields ? { ...cur.fields, ...patch.fields } : cur.fields;
      const after = (await client.query(
        `UPDATE opportunities SET stage=COALESCE($2,stage), status=$3, owner_id=COALESCE($4,owner_id),
           amount=COALESCE($5,amount), fields=$6, updated_at=now() WHERE id=$1 RETURNING *`,
        [oppId, patch.stage || null, status, patch.ownerId || null, patch.amount ?? null, JSON.stringify(mergedFields)])).rows[0];
      await audit(client, tenantId, null, 'automation', 'opportunity.updated', 'opportunity', oppId, cur, after);
      return `Updated opportunity ${oppId}`;
    }

    case 'create_opportunity': {
      if (!leadId) throw new Error('No lead in context');
      const typeId = action.opportunityTypeId ||
        (await client.query(`SELECT id FROM opportunity_types WHERE is_active ORDER BY name LIMIT 1`)).rows[0]?.id;
      if (!typeId) throw new Error('No opportunity type available');
      const type = (await client.query(`SELECT stages FROM opportunity_types WHERE id=$1`, [typeId])).rows[0];
      const first = (type?.stages || [])[0] || { name: 'New', status: 'Open' };
      const row = (await client.query(
        `INSERT INTO opportunities (tenant_id, lead_id, opportunity_type_id, name, status, stage, amount, currency, owner_id, fields, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,$9,NULL) RETURNING id`,
        [tenantId, leadId, typeId, mergeString(String(action.name || 'New Opportunity'), mergeCtx),
         first.status, first.name, action.amount || 0, action.ownerId || ctx.record?.owner_id || null,
         JSON.stringify(action.fields || {})])).rows[0];
      return `Created opportunity ${row.id}`;
    }

    case 'create_task': {
      if (!leadId) throw new Error('No lead in context to attach a task to');
      const dueAt = action.dueInDays !== undefined && action.dueInDays !== null
        ? new Date(Date.now() + Number(action.dueInDays) * 86400000).toISOString() : null;
      const ownerId = action.ownerId === 'record_owner' || !action.ownerId
        ? (ctx.record?.owner_id || null) : action.ownerId;
      const row = (await client.query(
        `INSERT INTO tasks (tenant_id, kind, name, description, lead_id, owner_id, due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL) RETURNING id`,
        [tenantId, action.kind || 'todo', mergeString(String(action.name || 'Follow up'), mergeCtx),
         action.description ? mergeString(String(action.description), mergeCtx) : null,
         leadId, ownerId, dueAt])).rows[0];
      return `Created task ${row.id}`;
    }

    case 'create_activity': {
      if (!leadId) throw new Error('No lead in context to attach an activity to');
      let typeRow;
      if (action.typeId) typeRow = (await client.query(`SELECT * FROM activity_types WHERE id=$1 AND is_active`, [action.typeId])).rows[0];
      else if (action.typeName) typeRow = (await client.query(`SELECT * FROM activity_types WHERE name=$1 AND is_active`, [action.typeName])).rows[0];
      if (!typeRow) throw new Error(`Unknown activity type: ${action.typeName || action.typeId}`);
      const row = (await client.query(
        `INSERT INTO activities (tenant_id, lead_id, activity_type_id, note, fields, performed_by)
         VALUES ($1,$2,$3,$4,$5,NULL) RETURNING id`,
        [tenantId, leadId, typeRow.id, action.note ? mergeString(String(action.note), mergeCtx) : null,
         JSON.stringify(action.fields || {})])).rows[0];
      if (typeRow.score !== 0)
        await client.query(`UPDATE leads SET score = score + $2 WHERE id=$1`, [leadId, typeRow.score]);
      return `Created activity ${row.id}`;
    }

    case 'send_message': {
      // Uses the tenant's OWN provider connector (Gupshup/Twilio/SendGrid/custom). If they
      // haven't connected one, this is a clear per-step failure in the log rather than silence.
      if (!leadId) throw new Error('No lead in context to message');
      const channel = action.channel || 'sms';
      const lead = (await client.query(`SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL`, [leadId])).rows[0];
      if (!lead) throw new Error('Lead not found');

      let subject = action.subject || null;
      let body = action.body || '';
      if (action.templateId) {
        const tpl = (await client.query(`SELECT * FROM message_templates WHERE id=$1 AND is_active`, [action.templateId])).rows[0];
        if (!tpl) throw new Error('Message template not found');
        subject = tpl.subject; body = tpl.body;
      }
      if (!body) throw new Error('send_message needs a body or templateId');

      const connectorId = action.connectorId || await defaultConnectorFor(client, channel);
      if (!connectorId) throw new Error(`No active ${channel} connector configured (Settings > Messaging)`);

      const to = action.to ? mergeString(String(action.to), mergeCtx)
        : (channel === 'email' ? lead.email : lead.phone);
      if (!to) throw new Error(`Lead has no ${channel === 'email' ? 'email' : 'phone'} to send to`);

      const r = await sendMessage(client, tenantId, connectorId, {
        channel, to,
        subject: subject ? mergeString(subject, mergeCtx) : undefined,
        body: mergeString(body, mergeCtx),
      }, { leadId, templateId: action.templateId || null });
      if (!r.ok) throw new Error(`Message send failed: ${r.error}`);
      return `Sent ${channel} to ${to}`;
    }

    case 'http_call': {
      if (!action.url) throw new Error('http_call requires a url');
      const url = mergeString(String(action.url), mergeCtx);
      const headers = mergeMap(action.headers, mergeCtx);
      const body = action.body ? mergeJsonBody(String(action.body), mergeCtx) : null;
      const started = Date.now();
      const result = await safeHttpCall({
        method: action.method || 'POST', url, headers, body, allowHttp: !!action.allowHttp,
      });
      await client.query(
        `INSERT INTO outbound_calls (tenant_id, source, source_id, method, url, request_body, response_code, response_body, error, duration_ms)
         VALUES ($1,'automation',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, ruleId, (action.method || 'POST').toUpperCase(), url, body,
         result.status, result.body.slice(0, 4000), result.error, Date.now() - started]);
      if (!result.ok) throw new Error(`HTTP call failed: ${result.error}`);
      return `HTTP ${result.status} from ${url}`;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}
