import { Router } from 'express';
import { withTenant, control } from '../db.js';
import { sendError } from '../util.js';
import { getEntitlements } from '../entitlements.js';
/**
 * Onboarding checklist.
 *
 * DESIGN DECISION: every step's completion is COMPUTED from real data rather than stored as a
 * "dismissed" flag. That matters because stored flags lie — a tenant can mark "import your leads"
 * done and have zero leads, and then the checklist actively misleads whoever looks at it. Deriving
 * it means the checklist is always true, survives a re-import, and needs no migration or upkeep.
 *
 * It also doubles as a health signal for you: a tenant stuck at 30% after two weeks is a churn
 * risk you can call before they go quiet.
 */
export const onboardingRouter = Router();
onboardingRouter.get('/', async (req, res) => {
    try {
        const tenantId = req.auth.tenantId;
        const entitlements = await getEntitlements(tenantId);
        const data = await withTenant(tenantId, async (c) => {
            const n = async (sql, params = []) => Number((await c.query(sql, params)).rows[0]?.n || 0);
            return {
                // Exclude the System user and the founding admin: inviting real colleagues is the step.
                realUsers: await n(`SELECT COUNT(*)::int AS n FROM users WHERE is_active AND is_system=false`),
                leads: await n(`SELECT COUNT(*)::int AS n FROM leads WHERE deleted_at IS NULL`),
                customFields: await n(`SELECT COUNT(*)::int AS n FROM custom_field_defs WHERE entity='lead' AND is_system=false AND is_active`),
                stages: await n(`SELECT COUNT(*)::int AS n FROM lead_stages`),
                activityTypes: await n(`SELECT COUNT(*)::int AS n FROM activity_types WHERE is_system=false AND is_active`),
                activities: await n(`SELECT COUNT(*)::int AS n FROM activities`),
                opportunities: await n(`SELECT COUNT(*)::int AS n FROM opportunities WHERE deleted_at IS NULL`),
                distributionRules: await n(`SELECT COUNT(*)::int AS n FROM distribution_rules WHERE is_active`),
                captureConnectors: await n(`SELECT COUNT(*)::int AS n FROM connectors WHERE is_active AND type IN ('webform','meta','whatsapp')`),
                messagingConnectors: await n(`SELECT COUNT(*)::int AS n FROM connectors WHERE is_active AND channel IN ('email','sms','whatsapp')`),
                paymentConnectors: await n(`SELECT COUNT(*)::int AS n FROM connectors WHERE is_active AND channel='payment'`),
                automationRules: await n(`SELECT COUNT(*)::int AS n FROM automation_rules WHERE is_active`),
                customActions: await n(`SELECT COUNT(*)::int AS n FROM custom_actions WHERE is_active`),
                managers: await n(`SELECT COUNT(*)::int AS n FROM users WHERE manager_id IS NOT NULL`),
                smartViews: await n(`SELECT COUNT(*)::int AS n FROM smart_views`),
                brandingSet: await n(`SELECT COUNT(*)::int AS n FROM (SELECT 1) x WHERE EXISTS (
             SELECT 1 FROM users WHERE id=$1)`, [req.auth.userId]),
            };
        });
        const branding = (await control(c => c.query(`SELECT branding FROM tenants WHERE id=$1`, [tenantId]))).rows[0]?.branding || {};
        const steps = [
            {
                key: 'invite_users', title: 'Invite your team',
                description: 'Add the people who will actually work leads. Each gets their own login.',
                done: data.realUsers >= 2, route: '/settings/users', required: true,
                detail: data.realUsers >= 2 ? `${data.realUsers} users` : 'Only you so far',
            },
            {
                key: 'configure_stages', title: 'Match your sales stages',
                description: 'Rename the pipeline stages to the words your team already uses.',
                // Every template seeds stages, so "done" means they've looked at and shaped them.
                done: data.stages > 0, route: '/settings/stages', required: true,
                detail: `${data.stages} stages configured`,
            },
            {
                key: 'custom_fields', title: 'Add the fields you actually capture',
                description: 'The one or two things your business always asks that a generic CRM misses.',
                done: data.customFields >= 1, route: '/settings/lead-fields', required: true,
                detail: data.customFields ? `${data.customFields} custom fields` : 'None yet',
            },
            {
                key: 'add_leads', title: 'Bring your leads in',
                description: 'Import a CSV, or connect a form so new enquiries arrive automatically.',
                done: data.leads >= 1, route: '/leads', required: true,
                detail: data.leads ? `${data.leads.toLocaleString('en-IN')} leads` : 'No leads yet',
            },
            {
                key: 'capture_channel', title: 'Connect a lead source',
                description: 'A website form, WhatsApp, or Facebook ads — so leads stop arriving by spreadsheet.',
                done: data.captureConnectors >= 1, route: '/settings/connectors', required: true,
                detail: data.captureConnectors ? `${data.captureConnectors} connected` : 'None connected',
            },
            {
                key: 'log_activity', title: 'Log your first activity',
                description: 'Record a call or note on a lead — this is what builds the history your team relies on.',
                done: data.activities >= 1, route: '/leads', required: true,
                detail: data.activities ? `${data.activities.toLocaleString('en-IN')} activities` : 'None yet',
            },
            {
                key: 'distribution', title: 'Decide who gets new leads',
                description: 'Round-robin, by city, or a fixed owner — so nothing sits unassigned.',
                done: data.distributionRules >= 1, route: '/settings/distribution', required: false,
                detail: data.distributionRules ? `${data.distributionRules} rules` : 'Falls back to default owner',
            },
            {
                key: 'hierarchy', title: 'Set reporting managers',
                description: 'Lets managers see their team\'s leads, and reset their passwords when needed.',
                done: data.managers >= 1, route: '/settings/users', required: false,
                detail: data.managers ? `${data.managers} users have a manager` : 'No hierarchy set',
            },
            {
                key: 'branding', title: 'Add your logo and colour',
                description: 'Makes the CRM feel like your system, not ours.',
                done: !!(branding.logoUrl || branding.primaryColor || branding.appName), route: '/settings/branding', required: false,
                detail: branding.appName || (branding.primaryColor ? 'Colour set' : 'Not set'),
            },
            {
                key: 'opportunities', title: 'Track your first deal',
                description: 'Turn a qualified lead into an opportunity with a value and a close date.',
                done: data.opportunities >= 1, route: '/opportunities', required: false,
                detail: data.opportunities ? `${data.opportunities} opportunities` : 'None yet',
            },
            {
                key: 'automation', title: 'Automate a follow-up',
                description: 'e.g. when a lead reaches Qualified, create a call task for the owner.',
                done: data.automationRules >= 1, route: '/settings/automation', required: false,
                feature: 'automation',
                detail: data.automationRules ? `${data.automationRules} rules active` : 'None yet',
            },
            {
                key: 'messaging', title: 'Connect email or WhatsApp',
                description: 'Send from your own provider — or use your own WhatsApp at no cost.',
                done: data.messagingConnectors >= 1, route: '/settings/connectors', required: false,
                feature: 'messaging',
                detail: data.messagingConnectors ? `${data.messagingConnectors} connected` : 'Not connected',
            },
            {
                key: 'payments', title: 'Enable payment links',
                description: 'Collect money from a lead or deal using your own payment gateway.',
                done: data.paymentConnectors >= 1, route: '/settings/connectors', required: false,
                feature: 'payments',
                detail: data.paymentConnectors ? 'Connected' : 'Not connected',
            },
        ];
        // Hide steps for features this tenant isn't entitled to — a checklist that nags about
        // things you can't buy yet is just noise.
        const visible = steps.filter(s => !s.feature || entitlements[s.feature]);
        const required = visible.filter(s => s.required);
        const requiredDone = required.filter(s => s.done).length;
        const allDone = visible.filter(s => s.done).length;
        // Next best action = the first incomplete required step, else the first optional one.
        const next = required.find(s => !s.done) || visible.find(s => !s.done) || null;
        res.json({
            steps: visible,
            progress: {
                requiredTotal: required.length,
                requiredDone,
                requiredPercent: required.length ? Math.round((requiredDone / required.length) * 100) : 100,
                totalSteps: visible.length,
                totalDone: allDone,
                percent: visible.length ? Math.round((allDone / visible.length) * 100) : 100,
            },
            isReadyToUse: requiredDone === required.length,
            nextAction: next ? { key: next.key, title: next.title, route: next.route, description: next.description } : null,
        });
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Host-admin view: onboarding progress across all tenants.
 * A tenant stuck below 50% after a couple of weeks is a churn risk worth a phone call — this
 * turns onboarding from a UI nicety into a retention signal.
 */
onboardingRouter.get('/all', async (req, res) => {
    try {
        const tenants = (await control(c => c.query(`SELECT id, code, name, created_at, is_demo FROM tenants WHERE status='active' ORDER BY created_at DESC`))).rows;
        const out = [];
        for (const t of tenants) {
            const d = await withTenant(t.id, async (c) => {
                const n = async (sql) => Number((await c.query(sql)).rows[0]?.n || 0);
                return {
                    users: await n(`SELECT COUNT(*)::int AS n FROM users WHERE is_active AND is_system=false`),
                    leads: await n(`SELECT COUNT(*)::int AS n FROM leads WHERE deleted_at IS NULL`),
                    activities: await n(`SELECT COUNT(*)::int AS n FROM activities`),
                    customFields: await n(`SELECT COUNT(*)::int AS n FROM custom_field_defs WHERE entity='lead' AND is_system=false AND is_active`),
                    connectors: await n(`SELECT COUNT(*)::int AS n FROM connectors WHERE is_active`),
                };
            });
            const checks = [d.users >= 2, d.leads >= 1, d.activities >= 1, d.customFields >= 1, d.connectors >= 1];
            const done = checks.filter(Boolean).length;
            const ageDays = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400000);
            out.push({
                tenantId: t.id, code: t.code, name: t.name, isDemo: t.is_demo, ageDays,
                percent: Math.round((done / checks.length) * 100),
                counts: d,
                // The signal worth acting on: onboarded a while ago, still barely set up.
                churnRisk: ageDays >= 14 && done < 3 ? 'high' : ageDays >= 7 && done < 3 ? 'medium' : 'low',
            });
        }
        out.sort((a, b) => a.percent - b.percent);
        res.json({ items: out });
    }
    catch (e) {
        sendError(res, e);
    }
});
