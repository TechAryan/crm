import { withTenant } from './db.js';
import { postActivity } from './services.js';

/**
 * Demo data generator — a believable tenant for sales demos.
 *
 * WHY: selling from an empty CRM is materially harder than selling from one that looks alive.
 * Prospects can't picture their own workflow in a blank screen, and the dashboard/funnel/reports
 * (some of your strongest features) are literally invisible without data.
 *
 * Design goals:
 *  - Realistic Indian names, phone formats and cities, since that's the target market.
 *  - Leads spread over the last 90 days with a believable daily curve, so trend charts look real.
 *  - A funnel shape that actually converts downward (most in early stages, a few won).
 *  - Activities clustered on recent leads, so "Needs Attention" has genuine cold leads to show.
 *  - Deterministic given a seed, so a demo looks the same every time you present it.
 */

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Krishna', 'Ishaan',
  'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Kiara', 'Riya', 'Myra', 'Anika',
  'Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Pooja', 'Rohan', 'Neha',
  'Karthik', 'Meera', 'Suresh', 'Kavya', 'Manish', 'Divya'];
const LAST = ['Sharma', 'Verma', 'Patel', 'Gupta', 'Singh', 'Kumar', 'Reddy', 'Nair',
  'Iyer', 'Mehta', 'Joshi', 'Desai', 'Rao', 'Chopra', 'Malhotra', 'Bose'];
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Hyderabad', 'Chennai', 'Ahmedabad',
  'Kolkata', 'Jaipur', 'Lucknow', 'Indore', 'Chandigarh'];
const SOURCES = ['Website', 'Facebook Ads', 'Google Ads', 'Referral', 'WhatsApp', 'Walk-in', 'IndiaMART'];
const COMPANIES = ['Acme Industries', 'Bharat Textiles', 'Sunrise Traders', 'Global Exports',
  'Metro Retail', 'Prime Solutions', 'Nova Enterprises', 'Skyline Corp'];

/** Small deterministic PRNG (mulberry32) so a demo is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoOptions {
  leadCount?: number;
  days?: number;
  seed?: number;
}

export async function generateDemoData(tenantId: string, opts: DemoOptions = {}) {
  const leadCount = Math.min(Math.max(opts.leadCount ?? 250, 1), 5000);
  const days = opts.days ?? 90;
  const rand = rng(opts.seed ?? 42);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

  return withTenant(tenantId, async c => {
    const stages = (await c.query(`SELECT id, name, is_active_stage, sort_order FROM lead_stages ORDER BY sort_order`)).rows;
    const users = (await c.query(`SELECT id FROM users WHERE is_active AND is_system=false`)).rows;
    const allUsers = users.length ? users : (await c.query(`SELECT id FROM users WHERE is_active LIMIT 1`)).rows;
    const oppTypes = (await c.query(`SELECT id, stages FROM opportunity_types WHERE is_active`)).rows;
    const actTypes = (await c.query(`SELECT id, name FROM activity_types WHERE is_active AND is_system=false`)).rows;

    // Ensure the demo's sources exist so charts have variety.
    for (const s of SOURCES) {
      await c.query(
        `INSERT INTO lead_sources (tenant_id, name) VALUES ($1,$2) ON CONFLICT (tenant_id,name) DO NOTHING`,
        [tenantId, s]);
    }
    const sources = (await c.query(`SELECT id, name FROM lead_sources`)).rows;

    // Funnel weighting: heavier at the top, so the funnel chart slopes correctly.
    const activeStages = stages.filter((s: any) => s.is_active_stage);
    const closedStages = stages.filter((s: any) => !s.is_active_stage);
    const stageFor = () => {
      const r = rand();
      if (r < 0.34) return activeStages[0] || stages[0];
      if (r < 0.58) return activeStages[1] || activeStages[0] || stages[0];
      if (r < 0.74) return activeStages[2] || activeStages[activeStages.length - 1] || stages[0];
      if (r < 0.86) return activeStages[activeStages.length - 1] || stages[0];
      return closedStages.length ? pick(closedStages) : stages[stages.length - 1];
    };

    let leadsCreated = 0, oppsCreated = 0, actsCreated = 0, tasksCreated = 0;
    const createdLeads: { id: string; createdAt: Date; stage: any }[] = [];

    // Start numbering after any existing leads so this can be run on a live-ish tenant.
    const startNum = Number((await c.query(`SELECT COALESCE(MAX(lead_number),0) AS n FROM leads`)).rows[0].n);

    for (let i = 0; i < leadCount; i++) {
      // Weight recent days more heavily (a growing business), and dip on weekends.
      const dayOffset = Math.floor(Math.pow(rand(), 0.65) * days);
      const created = new Date(Date.now() - dayOffset * 86400000);
      created.setUTCHours(int(8, 21), int(0, 59), int(0, 59), 0);
      const dow = created.getUTCDay();
      if ((dow === 0 || dow === 6) && rand() < 0.5) continue;   // fewer weekend leads

      const first = pick(FIRST), last = pick(LAST);
      const city = pick(CITIES);
      const source = pick(sources);
      const stage = stageFor();
      const owner = allUsers.length ? pick(allUsers).id : null;
      const phone = `+919${int(100000000, 999999999)}`;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${int(1, 99)}@example.com`;

      const fields: Record<string, any> = {};
      // Populate whichever custom fields this vertical template happens to define.
      const defs = (await c.query(
        `SELECT schema_name, field_type, options FROM custom_field_defs
         WHERE entity='lead' AND is_active AND is_system=false LIMIT 12`)).rows;
      for (const d of defs) {
        if (d.field_type === 'dropdown' && Array.isArray(d.options) && d.options.length) {
          if (rand() < 0.75) fields[d.schema_name] = pick(d.options);
        } else if (d.schema_name.includes('city')) {
          fields[d.schema_name] = city;
        } else if (d.field_type === 'number' || d.field_type === 'currency') {
          if (rand() < 0.5) fields[d.schema_name] = int(1000, 200000);
        } else if (d.field_type === 'text' && rand() < 0.4) {
          fields[d.schema_name] = pick(COMPANIES);
        }
      }

      const lead = (await c.query(
        `INSERT INTO leads (tenant_id, lead_number, first_name, last_name, email, phone, stage_id,
           source_id, sub_source, owner_id, score, fields, consent, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$13) RETURNING id`,
        [tenantId, startNum + i + 1, first, last, email, phone, stage.id, source.id,
         rand() < 0.4 ? pick(['Campaign A', 'Campaign B', 'Organic']) : null,
         owner, int(0, 60), JSON.stringify(fields), created.toISOString()])).rows[0];
      leadsCreated++;
      createdLeads.push({ id: lead.id, createdAt: created, stage });

      // Activities: more on recent leads, and deliberately none on some older ones so the
      // "Needs Attention" (cold leads) panel has real content to show in a demo.
      const actCount = dayOffset < 14 ? int(1, 5) : (rand() < 0.55 ? int(1, 3) : 0);
      for (let a = 0; a < actCount && actTypes.length; a++) {
        const at = pick(actTypes);
        const when = new Date(created.getTime() + int(1, Math.max(2, dayOffset)) * 3600000);
        if (when.getTime() > Date.now()) continue;
        try {
          await postActivity(c, tenantId, {
            leadId: lead.id, typeId: at.id,
            note: pick([
              'Called, discussed requirements', 'Sent brochure over WhatsApp',
              'Follow-up scheduled', 'Asked for pricing details',
              'Not reachable, will retry', 'Interested, needs approval from family',
            ]),
            performedBy: owner, activityTime: when.toISOString(),
          });
          actsCreated++;
        } catch { /* type/field mismatch on some templates — skip quietly */ }
      }

      // Opportunities on leads that progressed past the first stage.
      if (oppTypes.length && stage.sort_order > (activeStages[0]?.sort_order ?? 0) && rand() < 0.42) {
        const ot = pick(oppTypes);
        const oStages = (ot.stages || []) as any[];
        const oStage = oStages.length ? oStages[Math.min(oStages.length - 1, Math.floor(Math.pow(rand(), 1.4) * oStages.length))] : { name: 'New', status: 'Open' };
        const amount = int(5, 120) * 1000;
        await c.query(
          `INSERT INTO opportunities (tenant_id, lead_id, opportunity_type_id, name, status, stage,
             amount, currency, owner_id, fields, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,'{}'::jsonb,$9,$9)`,
          [tenantId, lead.id, ot.id, `${first} ${last} — ${pick(['Enrollment', 'Order', 'Package', 'Deal'])}`,
           oStage.status, oStage.name, amount, owner, created.toISOString()]);
        oppsCreated++;
      }

      // Open tasks, some overdue so the dashboard's overdue panel isn't empty.
      if (rand() < 0.3) {
        const due = new Date(Date.now() + (rand() < 0.4 ? -1 : 1) * int(1, 10) * 86400000);
        await c.query(
          `INSERT INTO tasks (tenant_id, kind, name, lead_id, owner_id, due_at, status, created_at)
           VALUES ($1,'todo',$2,$3,$4,$5,'open',$6)`,
          [tenantId, pick(['Call back', 'Send quotation', 'Schedule demo', 'Collect documents', 'Follow up on payment']),
           lead.id, owner, due.toISOString(), created.toISOString()]);
        tasksCreated++;
      }
    }

    return { leads: leadsCreated, opportunities: oppsCreated, activities: actsCreated, tasks: tasksCreated };
  });
}
