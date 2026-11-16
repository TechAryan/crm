import { Router } from 'express';
import { sendError } from '../util.js';

/**
 * In-app contextual help.
 *
 * WHY IT'S SERVED FROM THE API RATHER THAN HARD-CODED IN THE UI: help text changes far more often
 * than code. Serving it means you can correct a confusing sentence without a frontend deploy, and
 * later make it per-tenant (different wording for an education customer vs a jewellery one)
 * without touching the components.
 *
 * Support cost scales inversely with documentation quality — every question answered here is a
 * WhatsApp message you don't get on a Sunday.
 */
export const helpRouter = Router();

interface HelpTopic {
  key: string;
  title: string;
  body: string;              // short, plain-language explanation
  steps?: string[];
  tips?: string[];
  related?: string[];
}

/**
 * Keyed by UI location. The frontend asks for the key matching the screen the user is on.
 * Written in plain language deliberately — the reader is a salesperson or an office admin,
 * not a developer.
 */
const TOPICS: Record<string, HelpTopic> = {
  'leads.list': {
    key: 'leads.list',
    title: 'Managing your leads',
    body: 'This is every enquiry your business has received. You can search, filter, and save filtered views you use often.',
    steps: [
      'Use the search box for a name, email or phone number.',
      'Click a lead to open its full history.',
      'Select several leads with the checkboxes to reassign or delete them together.',
      'Save a filter as a "Smart View" to come back to it in one click.',
    ],
    tips: [
      'Import leads in bulk from a CSV using the Import button — match your spreadsheet columns to CRM fields once and it remembers.',
      'Export respects what you are allowed to see, so a salesperson only exports their own leads.',
    ],
    related: ['leads.detail', 'settings.fields'],
  },
  'leads.detail': {
    key: 'leads.detail',
    title: 'Working a lead',
    body: 'Everything about one person: their details, every call and note, their deals, and their tasks.',
    steps: [
      'Log every conversation with "Log Activity" — this is what builds the history your team relies on.',
      'Change the stage from the dropdown at the top as the lead progresses.',
      'Click the phone number to dial (opens your phone or dialer app).',
      'Create an Opportunity when there is a real deal with a value attached.',
    ],
    tips: [
      'The Activity History tab shows what happened. The History tab shows who changed what, and when.',
      'If your admin has set up Custom Actions, extra buttons appear at the top — those connect to your other systems.',
    ],
    related: ['opportunities.detail', 'activities'],
  },
  'opportunities.list': {
    key: 'opportunities.list',
    title: 'Opportunities (deals)',
    body: 'A lead is a person. An opportunity is a specific deal with that person — a course enrolment, an order, a project.',
    tips: [
      'One lead can have several opportunities. A repeat customer keeps their history in one place.',
      'Moving an opportunity to a "Won" or "Lost" stage updates its status automatically.',
    ],
    related: ['leads.detail'],
  },
  'dashboard': {
    key: 'dashboard',
    title: 'Your dashboard',
    body: 'A live picture of your pipeline. What you see depends on your permissions — a manager sees their team, an admin sees everyone.',
    tips: [
      'Managers can use the "Viewing as" dropdown to see one team member\'s numbers.',
      '"Needs Attention" lists active leads nobody has touched recently — usually the fastest place to find lost revenue.',
    ],
  },
  'settings.users': {
    key: 'settings.users',
    title: 'Users and passwords',
    body: 'Add your team here. Each person gets their own login. Set a manager for each person so managers can see their team\'s leads.',
    steps: [
      'Click "Create User", enter their email and name, and pick a role.',
      'You get a one-time link and a temporary password — send whichever is easier.',
      'They will be asked to set their own password when they first log in.',
    ],
    tips: [
      'Forgot a password? Click "Set-password link" next to that user. Managers can also do this for people who report to them, so you are not the bottleneck.',
      'Deactivate someone who leaves rather than deleting them — that keeps their history intact.',
      'Use "Bulk Create (CSV)" to add a whole team at once.',
    ],
    related: ['settings.roles'],
  },
  'settings.roles': {
    key: 'settings.roles',
    title: 'Roles and permissions',
    body: 'Control who can see and do what. A role sets how much data someone sees; a permission set controls which actions they can take.',
    tips: [
      '"Own" means they see only their own leads. "Team" means they also see everyone reporting to them. "All" means the whole account.',
      'You can hide specific fields from a role — useful for salary, cost price, or margin.',
      'Field security can differ between the app and the API, so an integration can update a field that people cannot edit by hand.',
    ],
  },
  'settings.fields': {
    key: 'settings.fields',
    title: 'Custom fields',
    body: 'Add the things your business always asks that a generic CRM does not have — exam target, karat, order value, whatever it is.',
    tips: [
      'Mark a field "unique" to stop duplicate records sharing the same value (for example a student ID).',
      'Built-in fields like Phone and Email can be renamed or hidden, but never deleted, so nothing breaks.',
      'Dropdown options can be typed in, or pulled live from your own system.',
    ],
  },
  'settings.distribution': {
    key: 'settings.distribution',
    title: 'Who gets new leads',
    body: 'Decide automatically who owns each new enquiry, so nothing sits unassigned.',
    tips: [
      'Round-robin shares leads evenly. Least-open gives them to whoever has the fewest open leads.',
      'Rules run top to bottom; the first matching rule wins.',
      'If no rule matches, the default owner setting decides — by default the System user, so a lead is never lost.',
      'Prefer to hand leads out once a day instead of instantly? Switch to scheduled distribution in Organization settings.',
    ],
  },
  'settings.automation': {
    key: 'settings.automation',
    title: 'Automation',
    body: 'When something happens, do something automatically. For example: when a lead reaches "Qualified", create a call task for its owner.',
    steps: [
      'Choose the trigger — what has to happen.',
      'Add conditions if it should only run sometimes.',
      'Add one or more actions.',
    ],
    tips: [
      'Triggers can be very specific: "when this field changes to this value".',
      'Every run is recorded — click "Logs" on a rule to see exactly what it did and why.',
      'Rules cannot run away: a rule that re-triggers itself is stopped automatically.',
    ],
  },
  'settings.messaging': {
    key: 'settings.messaging',
    title: 'Email, SMS and WhatsApp',
    body: 'Send messages using your own provider account, so you keep control of your sender identity and costs.',
    tips: [
      'No provider? Choose "send from my own WhatsApp" — clicking the button opens WhatsApp with the message already written. Free, though you press send yourself.',
      'Templates support merge fields like {{lead.first_name}}, so each message is personalised.',
      'Your provider keys are encrypted and are never shown again after you save them.',
    ],
  },
  'settings.payments': {
    key: 'settings.payments',
    title: 'Collecting payments',
    body: 'Generate a payment link from a lead or deal using your own payment gateway. Money goes directly to you — it never passes through us.',
    tips: [
      'Send the link by WhatsApp or email in the same click.',
      'When the customer pays, the record updates automatically and a note is added to their history.',
      'Instalments and refunds are both handled, and the outstanding balance is always shown.',
    ],
  },
  'settings.webhooks': {
    key: 'settings.webhooks',
    title: 'Webhooks and API',
    body: 'Connect the CRM to your other systems. Webhooks push events out; the API lets other systems read and write.',
    tips: [
      'Full API documentation is at /docs — share it with your developer.',
      'Create an API key with only the permissions the integration needs.',
      'Every delivery is logged with the response, so a failing integration is easy to diagnose.',
    ],
  },
  'import': {
    key: 'import',
    title: 'Importing from a spreadsheet',
    body: 'Bring existing leads in from Excel or CSV.',
    steps: [
      'Save your spreadsheet as CSV.',
      'Upload it and match each column to a CRM field.',
      'Choose what happens to duplicates: update the existing record, or skip it.',
    ],
    tips: [
      'Duplicates are matched on email, then phone.',
      'Imported leads follow your normal distribution rules, so they get owners automatically.',
      'Every row reports success or failure individually — one bad row will not stop the rest.',
    ],
  },
};

/** All topics — used to build a help index page. */
helpRouter.get('/', (_req, res) => {
  try {
    res.json({
      items: Object.values(TOPICS).map(t => ({ key: t.key, title: t.title, body: t.body })),
      apiDocsUrl: '/docs',
    });
  } catch (e) { sendError(res, e); }
});

/** One topic, for the contextual help panel on a screen. */
helpRouter.get('/:key', (req, res) => {
  try {
    const topic = TOPICS[req.params.key];
    if (!topic) {
      // Not an error — a screen without help content just shows nothing.
      return res.json({ key: req.params.key, found: false });
    }
    res.json({ ...topic, found: true });
  } catch (e) { sendError(res, e); }
});
