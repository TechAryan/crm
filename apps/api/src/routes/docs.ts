import { Router } from 'express';

/** LSQ-style API documentation, served at GET /docs on the API host. */
export const docsRouter = Router();

const S = (method: string, path: string, desc: string, body?: string, notes?: string) => `
<div class="ep">
  <div class="sig"><span class="m ${method.toLowerCase()}">${method}</span><code>${path}</code></div>
  <p>${desc}</p>
  ${body ? `<pre>${body.trim()}</pre>` : ''}
  ${notes ? `<p class="note">${notes}</p>` : ''}
</div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NexCRM API Documentation</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;color:#1a1d23;background:#fff;line-height:1.55}
  .wrap{display:flex;max-width:1200px;margin:0 auto}
  nav{width:230px;flex-shrink:0;padding:24px;border-right:1px solid #e3e6eb;position:sticky;top:0;height:100vh;overflow:auto;box-sizing:border-box}
  nav a{display:block;color:#6b7280;text-decoration:none;font-size:13.5px;padding:5px 0;font-weight:500}
  nav a:hover{color:#4f46e5}
  main{flex:1;padding:24px 40px;min-width:0}
  h1{font-size:26px}h2{font-size:19px;margin-top:44px;padding-top:20px;border-top:1px solid #e3e6eb}
  code{background:#f5f6f8;padding:2px 6px;border-radius:4px;font-size:13px}
  pre{background:#0f1115;color:#e6e6e6;padding:14px;border-radius:8px;font-size:12.5px;overflow:auto}
  .ep{margin:22px 0}
  .sig{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .m{font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;color:#fff}
  .m.get{background:#16a34a}.m.post{background:#4f46e5}.m.patch{background:#d97706}.m.delete{background:#dc2626}
  .note{color:#6b7280;font-size:13px}
  table{border-collapse:collapse;font-size:13.5px;width:100%}
  td,th{border:1px solid #e3e6eb;padding:8px 10px;text-align:left}
</style></head><body><div class="wrap">
<nav>
  <strong>NexCRM API</strong>
  <a href="#auth">Authentication</a>
  <a href="#conventions">Conventions</a>
  <a href="#leads">Leads</a>
  <a href="#activities">Activities</a>
  <a href="#opportunities">Opportunities</a>
  <a href="#tasks">Tasks</a>
  <a href="#users">Users & Permissions</a>
  <a href="#fields">Custom Fields</a>
  <a href="#forms">Forms</a>
  <a href="#files">Files</a>
  <a href="#distribution">Distribution</a>
  <a href="#webhooks">Webhooks</a>
  <a href="#capture">Public Capture</a>
  <a href="#reports">Reports</a>
  <a href="#smartviews">Smart Views</a>
  <a href="#automation">Automation</a>
  <a href="#customactions">Custom Actions</a>
  <a href="#telephony">Telephony</a>
  <a href="#messaging">Messaging</a>
  <a href="#payments">Payments</a>
  <a href="#bulk">Bulk & Import</a>
  <a href="#widgets">Embedded Widgets</a>
  <a href="#exportdata">Data Export</a>
  <a href="#audit">Audit Log</a>
  <a href="#errors">Errors & Limits</a>
</nav>
<main>
<h1>NexCRM API Documentation</h1>
<p>REST API, JSON in/out. Base URL: <code>https://&lt;your-api-host&gt;</code>. All tenant endpoints are under <code>/v1</code>.</p>

<h2 id="auth">Authentication</h2>
<p>Two options:</p>
<table>
<tr><th>Method</th><th>How</th><th>Use for</th></tr>
<tr><td>JWT session</td><td><code>Authorization: Bearer &lt;token&gt;</code> from <code>POST /auth/login</code></td><td>Web apps, short-lived sessions</td></tr>
<tr><td>API key</td><td>Headers <code>x-api-key-id</code> + <code>x-api-key-secret</code></td><td>Server-to-server integrations</td></tr>
</table>
${S('POST', '/auth/login', 'Exchange tenant credentials for a JWT (12h expiry). If the user has 2FA enabled, this returns { requires2fa: true, pendingToken } instead of a token — finish with /auth/login/2fa.', `{
  "tenantCode": "t-8FK2Q",   // tenant ID or subdomain
  "email": "user@company.com",
  "password": "••••••••"
}
→ 200 { "token": "eyJ...", "mustChangePassword": false }
→ 200 { "requires2fa": true, "pendingToken": "eyJ..." }`)}
${S('POST', '/auth/login/2fa', 'Completes login when 2FA is required. code is a 6-digit authenticator code OR one unused backup code.', `{ "pendingToken": "eyJ...", "code": "123456" } → 200 { "token": "eyJ...", "mustChangePassword": false }`)}
${S('POST', '/auth/reset-password', 'Consumes an admin-generated (or self-service) set-password link.', `{ "token": "…", "newPassword": "••••••••" }`)}
<p>API keys are created in Settings → Webhooks &amp; API (or <code>POST /v1/api-keys</code>). Each key carries <b>scopes</b> (e.g. <code>leads:read</code>, <code>leads:write</code>, <code>leads:delete</code>) that are intersected with the owning user's permissions — a key can never do more than its owner. Secrets are shown once and stored hashed. Never put keys in query strings.</p>
<p><b>Forced password change:</b> when <code>mustChangePassword</code> is true (new users, or admin-reset accounts), every <code>/v1/*</code> endpoint except <code>/v1/me/*</code> returns <code>403 PASSWORD_CHANGE_REQUIRED</code> until <code>POST /v1/me/change-password</code> succeeds.</p>

<h2 id="conventions">Conventions</h2>
<p>Timestamps are ISO-8601 UTC. Custom fields use immutable <code>mx_*</code> schema names and travel in a <code>fields</code> object. List endpoints support <code>?page=&amp;limit=</code> (max 200). Business errors return proper 4xx codes with machine-readable bodies — never 500s.</p>

<h2 id="leads">Leads</h2>
${S('GET', '/v1/leads', 'List/search leads. Query: q (name/email/phone search), stage, ownerId, page, limit, and filters — a JSON array of conditions on system or custom fields.', `GET /v1/leads?filters=[{"field":"fields.mx_city","op":"eq","value":"Mumbai"},{"field":"score","op":"gt","value":10}]
ops: eq | neq | contains | in | gt | lt | exists`)}
${S('POST', '/v1/leads', 'Create a lead. At least one of firstName/lastName/email/phone required. Unassigned leads are auto-routed by distribution rules.', `{
  "firstName": "Ravi", "email": "ravi@example.com", "phone": "+919876543210",
  "stage": "New", "source": "Website",
  "fields": { "mx_city": "Mumbai", "mx_course_interest": "JEE" }
}`)}
${S('POST', '/v1/leads/capture', 'Upsert (the integration workhorse). Dedupes by email → phone; override with searchBy: "email"|"phone"|"id". updateBehavior: update | doNotUpdate | updateEmptyOnly.')}
${S('POST', '/v1/capture', 'UNIFIED CAPTURE — upsert a lead, an opportunity on it, and log an activity in ONE atomic call. Built for telephony post-call sync and any integration that writes several records together. Every section is optional except lead. searchBy picks the match key; createIfNotFound controls whether a miss creates the record (lead: default true, opportunity: default false).', `{
  "lead": {
    "searchBy": "phone", "phone": "+919876543210",
    "createIfNotFound": true, "updateBehavior": "updateEmptyOnly",
    "firstName": "Ravi", "fields": { "mx_city": "Pune" }
  },
  "opportunity": {
    "searchBy": "field", "searchField": "mx_order_id", "searchValue": "ORD-9001",
    "createIfNotFound": true, "name": "Ravi — Course", "stage": "Negotiation",
    "amount": 45000, "fields": { "mx_order_id": "ORD-9001" }
  },
  "activity": {
    "typeName": "Incoming Call", "note": "Discussed pricing",
    "fields": { "mx_recording_url": "https://…", "mx_duration": 214 }
  }
}
Response: { status, lead:{id,created}, opportunity:{id,created}, activity:{id} }`)}
${S('GET', '/v1/leads/:id', 'Fetch one lead (404 if outside your tenant or visibility scope).')}
${S('PATCH', '/v1/leads/:id', 'Update system and/or custom fields. Stage changes fire lead.stage_changed webhooks.')}
${S('DELETE', '/v1/leads/:id', 'Soft delete. Requires delete permission AND leads:delete scope on API keys.')}
${S('GET', '/v1/leads/export', 'Export matching leads as CSV (same q/stage/filters as the list; respects your visibility scope and field masking). Requires export permission.')}
${S('POST', '/v1/leads/bulk-update', 'Update up to 1000 leads at once. patch: { stage?, ownerId? }. Leads outside your scope are skipped.', `{ "ids": ["…","…"], "patch": { "ownerId": "…" } }`)}
${S('POST', '/v1/leads/bulk-delete', 'Soft-delete up to 1000 leads (leads:delete scope + delete permission).', `{ "ids": ["…","…"] }`)}
${S('POST', '/v1/leads/:id/merge', 'Merge a duplicate into this lead: activities, opportunities and tasks are moved over.', `{ "duplicateId": "…", "fieldChoices": { "phone": "+91…" } }`)}
${S('GET', '/v1/leads/:id/notes', 'List notes.')}${S('POST', '/v1/leads/:id/notes', 'Add a note.', `{ "body": "Spoke to parent, call back Monday" }`)}

<h2 id="activities">Activities</h2>
<p>Activities are the event log. Every activity belongs to a lead and optionally an opportunity. Posting an activity applies its type's score to the lead.</p>
${S('GET', '/v1/activities', 'List. Filters: leadId, opportunityId, typeId, limit.')}
${S('POST', '/v1/activities', 'Post an activity on a lead or opportunity (opportunityId alone resolves the parent lead).', `{
  "opportunityId": "…",              // or "leadId"
  "typeName": "Site Visit",          // or "typeId"
  "note": "Visited the campus",
  "fields": { "mx_property": "Skyline Towers" }
}`)}
${S('GET', '/v1/activities/:id', 'Fetch one activity.')}
${S('PATCH', '/v1/activities/:id', 'Edit note/fields/time. Audited.')}
${S('DELETE', '/v1/activities/:id', 'Delete; the lead score contribution is reversed.')}
${S('GET', '/v1/activity-types', 'List activity types.')}
${S('POST', '/v1/activity-types', 'Create a custom activity type with its own field schema and score.', `{
  "name": "Site Visit", "direction": 0, "score": 10,
  "fields": [{ "label": "Property", "type": "text", "mandatory": true }]
}`)}
${S('GET', '/v1/activity-types/:id/fields', 'Field schema of a type.')}

<h2 id="opportunities">Opportunities</h2>
${S('GET', '/v1/opportunities', 'List. Filters: status (Open|Won|Lost), leadId.')}
${S('POST', '/v1/opportunities', 'Create on a lead (or upsert a lead inline via "lead": {...}). Stage defaults to the first stage of the type.', `{
  "leadId": "…", "opportunityTypeId": "…", "name": "Ravi — JEE 2027",
  "amount": 50000, "fields": { "mx_course_name": "JEE Advanced" }
}`)}
${S('PATCH', '/v1/opportunities/:id', 'Update stage/amount/owner/fields. Moving to a Won/Lost stage flips status automatically.')}
${S('DELETE', '/v1/opportunities/:id', 'Soft delete (opportunities:delete scope).')}
${S('GET', '/v1/opportunity-types', 'List types with their stage definitions.')}
${S('POST', '/v1/opportunity-types', 'Create a type (own pipeline).')}
${S('PATCH', '/v1/opportunity-types/:id', 'Edit stages: [{"name":"Enrolled","status":"Won"}, …]. Statuses are fixed: Open|Won|Lost.')}
${S('GET', '/v1/opportunity-types/:id/fields', 'Per-type custom fields.')}${S('POST', '/v1/opportunity-types/:id/fields', 'Add a field to the type.')}

<h2 id="tasks">Tasks</h2>
${S('GET', '/v1/tasks', 'List (status, leadId filters).')}
${S('POST', '/v1/tasks', 'Create To-Do or Appointment.', `{ "kind": "todo", "name": "Call back", "leadId": "…", "dueAt": "2026-07-21T10:00:00Z" }`)}
${S('PATCH', '/v1/tasks/:id', 'Update / mark done ({"status":"done"}).')}${S('DELETE', '/v1/tasks/:id', 'Delete.')}

<h2 id="users">Users & Permissions</h2>
${S('GET', '/v1/users', 'List users.')}${S('POST', '/v1/users', 'Create user. password is optional — omit it and a temp password + one-time set-password link are generated and returned once (no email is sent; share manually).', `{ "email": "rep1@acme.com", "firstName": "Riya", "roleId": "…" }
→ 201 { "id":"…", …, "generatedCredentials": { "tempPassword": "aB3xQ9mP2kLz", "resetUrl": "https://app…/reset-password?token=…", "resetExpiresAt": "…" } }`)}
${S('POST', '/v1/users/bulk', 'Create up to 500 users in one call (e.g. from a CSV). Each row succeeds/fails independently; each success gets its own temp password + reset link.', `{ "users": [ {"email":"a@x.com","firstName":"A","roleId":"…"}, {"email":"b@x.com","firstName":"B","roleId":"…"} ] }`)}
${S('POST', '/v1/users/:id/reset-link', 'Generate a fresh one-time set-password link for an existing user (re-invite / forgot password), valid 24h.')}
${S('PATCH', '/v1/users/:id', 'Update, deactivate (isActive), check in/out (isCheckedIn — feeds routing), set custom fields.')}
${S('GET', '/v1/roles', 'Roles with record scope + UI policy (hidden tabs).')}${S('POST', '/v1/roles', 'Create custom role.')}
${S('GET', '/v1/permission-sets', 'Permission sets.')}${S('POST', '/v1/permission-sets', 'Create.')}${S('POST', '/v1/permission-sets/assign', 'Attach a set to a role or user.')}
${S('GET', '/v1/me', 'Caller identity + effective permissions + UI policy + mustChangePassword — drive your UI from this.')}
${S('POST', '/v1/me/change-password', 'Change own password (also clears mustChangePassword).')}
${S('POST', '/v1/me/2fa/setup', 'Start TOTP 2FA enrollment. Returns a secret + otpauthUrl to render as a QR code in an authenticator app.')}
${S('POST', '/v1/me/2fa/verify', 'Confirm enrollment with a 6-digit code. Enables 2FA and returns backup codes (shown once).')}
${S('POST', '/v1/me/2fa/disable', 'Disable 2FA (requires current password).')}
${S('GET', '/v1/api-keys', 'List keys.')}${S('POST', '/v1/api-keys', 'Create scoped key (secret returned once).')}${S('DELETE', '/v1/api-keys/:id', 'Revoke.')}

<h2 id="fields">Custom Fields</h2>
${S('GET', '/v1/fields/:entity', 'Field definitions. entity: lead | user | opportunity_type:&lt;id&gt; | activity_type:&lt;id&gt;.')}
${S('POST', '/v1/fields/:entity', 'Create a field. Types: text, textarea, number, currency, email, phone, url, date, datetime, boolean, dropdown, multiselect, file, audio. unique:true enforces tenant-wide uniqueness.', `{ "label": "City Tier", "type": "dropdown", "options": ["Tier1","Tier2"], "mandatory": false, "unique": false }`)}
${S('PATCH', '/v1/fields/:entity/:schemaName', 'Edit label/options/mandatory/isActive (schema name is immutable).')}
${S('GET', '/v1/stages', 'Lead stages.')}${S('POST', '/v1/stages', 'Add stage.')}${S('GET', '/v1/sources', 'Sources.')}${S('POST', '/v1/sources', 'Add source.')}

<h2 id="forms">Custom Forms</h2>
<p>Design forms from lead/opportunity/activity fields; place them on lead or opportunity pages; submissions update the record or post an activity.</p>
${S('GET', '/v1/forms?entity=lead', 'Forms for a page.')}
${S('POST', '/v1/forms', 'Create a form.', `{
  "name": "Site Visit Report", "entity": "lead",
  "definition": {
    "sections": [{ "title": "Visit Details", "items": [
      { "kind": "subheading", "text": "Property" },
      { "kind": "field", "source": "activity", "schemaName": "mx_property", "label": "Property", "required": true },
      { "kind": "field", "source": "activity", "schemaName": "mx_outcome", "label": "Outcome",
        "showIf": { "field": "mx_property", "op": "notEmpty" } }
    ]}],
    "valueRules": [{ "if": { "field": "mx_outcome", "op": "eq", "value": "Booked" },
                     "set": { "field": "mx_priority", "value": "High" } }]
  },
  "onSubmit": { "action": "post_activity", "activityTypeId": "…" }
}`)}
${S('PATCH', '/v1/forms/:id', 'Edit definition / onSubmit / deactivate.')}
${S('POST', '/v1/forms/:id/submit', 'Submit with { leadId | opportunityId, values }. Server enforces required fields, show-if visibility and value rules.')}

<h2 id="files">Files</h2>
${S('POST', '/v1/files', 'Upload (base64, max 8MB). Use the returned id as the value of file/audio custom fields.', `{ "name": "brochure.pdf", "mime": "application/pdf", "dataBase64": "JVBERi0…" }`)}
${S('GET', '/v1/files/:id', 'Download/stream with correct content-type (images preview, audio plays, pdf renders inline).')}
${S('DELETE', '/v1/files/:id', 'Delete.')}

<h2 id="distribution">Lead Distribution</h2>
${S('GET', '/v1/distribution-rules', 'Rules, priority-ordered.')}
${S('POST', '/v1/distribution-rules', 'Create rule.', `{
  "name": "Mumbai to Team A", "priority": 10,
  "conditions": [{ "field": "fields.mx_city", "op": "eq", "value": "Mumbai" }],
  "strategy": "weighted_round_robin",          // fixed_user | fixed_team | round_robin | weighted_round_robin | least_open
  "strategyConfig": { "weights": { "<userId>": 3, "<userId2>": 1 } }
}`, 'Round-robin skips checked-out users. First matching rule wins; add a catch-all (empty conditions) as the last rule.')}

<h2 id="webhooks">Webhooks (outbound)</h2>
${S('GET', '/v1/webhooks', 'Subscriptions + available events.')}
${S('POST', '/v1/webhooks', 'Subscribe. Returns the HMAC signing secret once.', `{ "url": "https://your-system.com/hook", "events": ["lead.created", "lead.stage_changed"] }`)}
${S('GET', '/v1/webhooks/:id/deliveries', 'Delivery history with attempts and response codes.')}
<p>Deliveries are JSON POSTs signed with <code>x-nexcrm-signature: sha256=&lt;hmac&gt;</code> (HMAC-SHA256 of the raw body with your secret). Verify it. Retries: 5 attempts with exponential backoff. Events: lead.created, lead.updated, lead.stage_changed, lead.owner_changed, lead.deleted, activity.created, opportunity.created, opportunity.updated, opportunity.stage_changed, task.created, task.completed, user.created.</p>

<h2 id="capture">Public Capture (no auth — token-secured)</h2>
${S('POST', '/capture/v1/forms/:token', 'Website form intake. Field mapping from connector config; unmapped keys matching our names (firstName, email, phone, fields.mx_*) pass through.')}
${S('GET', '/capture/v1/forms/:token/page', 'Hosted, shareable lead-capture form page (for customers without a website).')}
${S('GET', '/capture/v1/meta/:token', 'Meta webhook verification.')}${S('POST', '/capture/v1/meta/:token', 'Facebook/Instagram Lead Ads intake.')}
${S('GET', '/capture/v1/whatsapp/:token', 'WhatsApp Cloud API verification.')}${S('POST', '/capture/v1/whatsapp/:token', 'Inbound WhatsApp: creates/updates lead + posts message activity.')}

<h2 id="reports">Reports</h2>
${S('GET', '/v1/reports/overview', 'Dashboard aggregates: funnel by stage, sources, 14-day trend, pipeline by status, task stats, needs-attention cold leads (coldDays param), overdue tasks. Respects record visibility of the caller.')}

<h2 id="smartviews">Smart Views</h2>
${S('GET', '/v1/smart-views?entity=lead', 'Saved filter + column sets. Returns your own views plus any shared with the tenant.')}
${S('POST', '/v1/smart-views', 'Save a view. isShared requires manageFields; otherwise it stays private to you.', `{ "entity": "lead", "name": "Hot Mumbai", "filters": [{"field":"fields.mx_city","op":"eq","value":"Mumbai"}], "columns": ["name","email","stage"], "isShared": false }`)}
${S('PATCH', '/v1/smart-views/:id', 'Update a view (owner or admin).')}${S('DELETE', '/v1/smart-views/:id', 'Delete a view (owner or admin).')}

<h2 id="automation">Automation</h2>
<p>Trigger-based rules: when something happens, run internal actions and/or call your APIs. Paid feature — a locked tenant gets <code>402 FEATURE_NOT_ENABLED</code>.</p>
${S('GET', '/v1/automation/meta', 'Everything the rule builder needs: valid entities, events, action types, merge tokens, activity types, stage names.')}
${S('GET', '/v1/automation', 'List rules.')}
${S('POST', '/v1/automation', 'Create a rule. Triggers can be as narrow as "when THIS field changes TO THIS value".', `{
  "name": "Chase demo no-shows",
  "trigger": {
    "entity": "lead",              // lead | opportunity | activity | task
    "event": "field_changed",      // created | updated | field_changed | stage_changed | deleted
    "field": "fields.mx_status",   // required for field_changed
    "toValue": "No Show",          // optional: only fire when the NEW value matches
    "fromValue": "Scheduled",      // optional: only when the OLD value matches
    "activityTypeId": null         // for activity triggers: narrow to one type
  },
  "conditions": [ { "field": "fields.mx_city", "op": "eq", "value": "Pune" } ],
  "actions": [
    { "type": "create_task", "name": "Call {{lead.full_name}}", "dueInDays": 1, "ownerId": "record_owner" },
    { "type": "update_lead", "patch": { "stage": "Contacted" } },
    { "type": "send_message", "channel": "sms", "templateId": "…" },
    { "type": "http_call", "method": "POST", "url": "https://hooks.you.com/x", "body": "{\\"id\\":\\"{{lead.id}}\\"}" }
  ],
  "maxExecutionsPerRecord": 25
}
Action types: update_lead | update_opportunity | create_opportunity | create_task |
create_activity | reassign_owner | http_call | send_message`)}
${S('PATCH', '/v1/automation/:id', 'Update / pause a rule (isActive:false).')}${S('DELETE', '/v1/automation/:id', 'Delete a rule.')}
${S('GET', '/v1/automation/executions', 'Execution log with per-step outcomes — this is how you debug a rule. Filters: ruleId, entityId, status, limit.')}
${S('GET', '/v1/automation/outbound-calls', 'Log of every outbound HTTP call made by automation or custom actions (request, response code, error, duration).')}

<h2 id="customactions">Custom Actions</h2>
<p>Admin-defined buttons on records that call your own API. The call is made <b>server-side</b>, so credentials in headers never reach the browser and CORS is irrelevant.</p>
${S('GET', '/v1/custom-actions?entity=lead', 'Buttons the caller is allowed to see (used to render them).')}
${S('GET', '/v1/custom-actions/tokens/:entity', 'Every available merge token for that entity — powers the click-to-insert picker.')}
${S('POST', '/v1/custom-actions', 'Create a button.', `{
  "name": "Send to Dialer", "entity": "lead", "method": "POST",
  "urlTemplate": "https://api.yourdialer.com/call?to={{lead.phone}}",
  "headers": { "Authorization": "Bearer YOUR_KEY" },
  "bodyTemplate": "{\\"name\\":\\"{{lead.full_name}}\\",\\"agent\\":\\"{{owner.email}}\\"}",
  "confirmText": "Dial this lead?", "successMessage": "Sent to dialer",
  "openUrlInNewTab": false, "requiredPermission": null
}`)}
${S('POST', '/v1/custom-actions/:id/execute', 'Run the action against one record.', `{ "recordId": "…" }`)}
${S('PATCH', '/v1/custom-actions/:id', 'Update.')}${S('DELETE', '/v1/custom-actions/:id', 'Delete.')}

<h2 id="telephony">Telephony (screen-pop)</h2>
<p>Keep whatever dialer you already use. On an inbound call, tell us the number and which agent answered; we pop that agent's screen — nobody else's.</p>
${S('POST', '/v1/telephony/call-started', 'Match the caller and push a screen-pop to ONE agent. agentField may be email | id | phone, or the schema name of any user field marked unique (e.g. mx_agent_extension).', `{
  "phone": "+919876543210",       // or leadId / opportunityId
  "agentField": "email",
  "agentValue": "riya@acme.com",
  "direction": "inbound",
  "callId": "CALL-8891"
}
→ { "matched": true, "agentId": "…", "mode": "navigate", "navigateTo": "/leads/…", "eventId": "…" }`)}
${S('GET', '/v1/telephony/lookup?phone=…', 'Resolve a number to leads without pushing anything — for dialers that render their own UI.')}
${S('GET', '/v1/events/stream', 'Server-Sent Events stream for the logged-in user (this is what the browser subscribes to).')}
${S('POST', '/v1/events/ack/:eventId', 'Acknowledge delivery.')}${S('GET', '/v1/events/status', 'Is this user currently connected?')}
${S('POST', '/v1/capture', 'AFTER the call: upsert lead + opportunity + activity in one atomic call (see Leads section).')}

<h2 id="messaging">Messaging</h2>
<p>Send through <b>your own</b> provider account (Gupshup, Twilio, MSG91, SendGrid, Resend, or any HTTP API). Credentials are encrypted at rest and never returned.</p>
${S('GET', '/v1/messaging/providers', 'Supported providers and the credential fields each needs.')}
${S('POST', '/v1/messaging/connectors', 'Connect your provider.', `{
  "name": "Gupshup WhatsApp", "provider": "gupshup", "channel": "whatsapp",
  "config": { "source": "919876543210", "appName": "AcmeApp" },
  "secrets": { "apiKey": "…" }
}`)}
${S('GET', '/v1/messaging/connectors', 'List (never returns secrets — has_credentials only).')}
${S('GET', '/v1/messaging/connectors/:id/credentials', 'Masked preview of stored credentials.')}
${S('GET', '/v1/messaging/templates', 'Templates.')}${S('POST', '/v1/messaging/templates', 'Create a template with merge tokens.', `{ "name": "Welcome", "channel": "sms", "body": "Hi {{lead.first_name}}, thanks for your interest!" }`)}
${S('POST', '/v1/messaging/send', 'Send about a record. Recipient defaults to the email/phone on the lead for that channel.', `{ "channel": "sms", "leadId": "…", "templateId": "…" }`)}
${S('POST', '/v1/messaging/whatsapp/prepare', 'ZERO-COST option: returns a deep link that opens the user&rsquo;s own WhatsApp with the number and merged template pre-filled. No provider account, no per-message fee. Manual send, so it is logged as "prepared" rather than "sent".', `{ "leadId": "…", "templateId": "…", "phoneField": "mx_alt_phone" }
→ { "url": "https://wa.me/919876543210?text=…", "appUrl": "whatsapp://send?phone=…", "to": "919876543210" }`)}
${S('GET', '/v1/messaging/log', 'Delivery log. Filters: leadId, channel, status, limit.')}

<h2 id="payments">Payments</h2>
<p>Generate hosted checkout links using <b>your own</b> gateway. We never touch card data — PCI scope stays with the provider.</p>
${S('GET', '/v1/payments/providers', 'Razorpay, Stripe, or a custom endpoint / static-link template.')}
${S('POST', '/v1/payments/connectors', 'Connect your gateway (keys encrypted at rest).')}
${S('POST', '/v1/payments/links', 'Create a payment link from a lead/opportunity, optionally sending it immediately via a messaging template containing {{payment.url}}.', `{
  "leadId": "…", "amount": 4999, "currency": "INR", "description": "Course fee",
  "sendVia": "whatsapp", "templateId": "…"
}`)}
${S('GET', '/v1/payments/links', 'List links. Filters: leadId, status, limit.')}
${S('GET', '/v1/payments/links/:id/events', 'Full event history + netPaid + amountDue — the audit trail if a charge is disputed. Supports installments and refunds.')}
${S('POST', '/v1/payments/links/:id/record-refund', 'Record a refund made outside the CRM (e.g. in the gateway dashboard) so your numbers stay correct.', `{ "amount": 1000, "note": "Refunded in Razorpay dashboard" }`)}
${S('POST', '/payments/webhook/:reference', 'PUBLIC. Your gateway calls this. Razorpay/Stripe signatures are verified against the raw body; a custom provider uses a shared token. Idempotent, so redelivery is safe. Handles paid, partially_paid, refunded and partially_refunded.')}

<h2 id="bulk">Bulk & Import</h2>
<p>Consistent semantics everywhere: a unique locator is mandatory, found → update, not found → create (unless disabled), and rows succeed or fail independently so one bad row never aborts a 5,000-row batch.</p>
${S('POST', '/v1/bulk/leads', 'Upsert up to 5,000 leads.', `{
  "rows": [ { "email": "a@x.com", "firstName": "A", "fields": { "mx_city": "Pune" } } ],
  "createIfNotFound": true, "updateBehavior": "update"
}
→ { "created": 1, "updated": 0, "failed": 0, "results": [ { "row": 0, "status": "created", "id": "…", "ownerId": "…" } ] }`)}
${S('POST', '/v1/bulk/opportunities', 'Upsert opportunities. Each ALWAYS resolves or creates its parent lead. Owner falls back to distribution rules then the default-owner setting.', `{
  "rows": [ { "email": "a@x.com", "name": "Ravi — Course", "amount": 45000, "stage": "Proposal" } ],
  "createLeadIfMissing": true
}`)}
${S('POST', '/v1/bulk/activities', 'Bulk-log activities against resolved leads.')}
${S('POST', '/v1/bulk/import/opportunities', 'CSV import for opportunities. fieldMap destinations may be lead.* / lead.fields.* / fields.* / plain opportunity keys.', `{
  "csv": "Email,Name,Amount\\na@x.com,CSV Opp,7500\\n",
  "fieldMap": { "Email": "lead.email", "Name": "name", "Amount": "amount" },
  "searchBy": "email", "createLeadIfMissing": true
}`)}
${S('POST', '/v1/imports/leads', 'CSV import for leads with a field map and dedupe mode (update | skip | create).')}
${S('POST', '/v1/distribution-rules/run-now', 'Run the distribution sweep immediately (for tenants on scheduled distribution).')}

<h2 id="widgets">Embedded Widgets</h2>
<p>Show your own UI inside the CRM: any external page in a sandboxed iframe (with record context merged into the URL), or sanitized inline HTML. The iframe is deliberately NOT same-origin, so an embedded page cannot read the CRM session.</p>
${S('GET', '/v1/widgets?placement=lead_tab', 'Widgets for a placement. Placements: lead_tab | lead_sidebar | opportunity_tab | opportunity_sidebar | main_menu | dashboard.')}
${S('POST', '/v1/widgets', 'Create a widget (https only for iframes).', `{
  "name": "Lead Dashboard", "kind": "iframe", "placement": "lead_tab",
  "urlTemplate": "https://reports.you.com/lead?id={{lead.id}}&agent={{user.email}}",
  "height": 500
}`)}
${S('GET', '/v1/widgets/:id/resolve?recordId=…&entity=lead', 'Server-side merge of record context into the URL, after verifying the caller may see that record.')}
${S('GET', '/v1/widgets/tokens/:entity', 'Available merge tokens.')}

<h2 id="exportdata">Data Export</h2>
${S('GET', '/v1/export/summary', 'Row counts per section, so you can see the scope before downloading.')}
${S('GET', '/v1/export/full', 'Streams your entire tenant as NDJSON (one JSON object per line). Admin-only and audited. Connector credentials are deliberately excluded.')}
${S('GET', '/v1/onboarding', 'Setup checklist computed from your actual data, with progress and the next best action.')}

<h2 id="audit">Audit Log</h2>
${S('GET', '/v1/audit', 'Tenant audit trail (requires manageRoles). Filters: entity, entityId, action (prefix), actorId, page, limit.')}
${S('GET', '/v1/audit/:id', 'Full before/after snapshot of one audited change.')}
<p>Record history (who changed a lead/opportunity/activity) is retained indefinitely by default. Settings changes and API logs default to 7 days. Retention is raised per account by your account manager, since longer history costs storage.</p>

<h2 id="errors">Errors & Limits</h2>
<pre>HTTP 4xx with machine-readable body:
{ "error": { "code": "MANDATORY_FIELD_MISSING", "message": "Course Interest is mandatory", "field": "mx_course_interest" } }

Common codes: UNAUTHENTICATED, INVALID_TOKEN, FORBIDDEN, INSUFFICIENT_SCOPE, NOT_FOUND,
MANDATORY_FIELD_MISSING, UNKNOWN_FIELD, INVALID_FIELD_VALUE, UNIQUE_FIELD_VIOLATION,
EMAIL_EXISTS, FILE_TOO_LARGE, INVALID_FILTERS</pre>
<p>Deletes always require both the delete permission on your user and (for API keys) the <code>*:delete</code> scope. All data is tenant-isolated at the database level via Postgres row-level security.</p>
</main></div></body></html>`;

docsRouter.get('/', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(html);
});
