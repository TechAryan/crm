# NexCRM

A multi-tenant, LeadSquared-style sales CRM: host admin panel (control plane) + tenant CRM app + public API/webhooks/connectors. See `CRM-BLUEPRINT.md` for the full product design and roadmap. This README covers how to actually run, test, and deploy what's been built.

> **Picking this up on a new machine or in a fresh chat?** Read [`PROJECT-CONTEXT.md`](PROJECT-CONTEXT.md) first — it's the handoff: decisions made, what's built, known open items, and the current queue. Then [`SETUP-NEW-MACHINE.md`](SETUP-NEW-MACHINE.md) to get running (about 10 minutes, no Postgres install needed).

**Current state: 382/382 end-to-end checks passing, 14 migrations, both apps building clean.**
Load-tested at 100,000 leads: worst p95 62.6ms, 2,800 req/s at 50-way concurrency, ~1.05 GB per million leads.

## What's built (Phase 0 + Phase 1 of the blueprint)

- **Database**: PostgreSQL with Row-Level Security. Control-plane tables (`tenants`, `plans`, `partners`, `host_users`) have no RLS; every tenant table (`leads`, `activities`, `opportunities`, `tasks`, `users`, `roles`, `permission_sets`, `custom_field_defs`, `webhook_subscriptions`, `distribution_rules`, `connectors`, `audit_log`, etc.) is isolated by `tenant_id` via RLS policies, enforced even against the table owner (`FORCE ROW LEVEL SECURITY`).
- **API** (`apps/api`, Node + Express + TypeScript): JWT auth for tenant users and host admins, scoped API keys, permission engine (role hierarchy + stackable permission sets + field-level hide/readonly rules), leads/activities/opportunities/tasks CRUD, custom field registry, lead capture/upsert pipeline, CSV bulk import, lead distribution engine (round robin / weighted / least-open / fixed), outbound webhooks (HMAC-signed, retried with backoff), inbound connectors (website form endpoint, Meta Lead Ads webhook, WhatsApp Cloud API webhook), host admin control-plane API (tenant provisioning, plans, partners, login-as/impersonation, usage).
- **Web app** (`apps/web`, React + Vite + TypeScript): tenant CRM (leads list/detail/timeline, opportunities kanban, tasks, settings for fields/stages/roles/users/distribution/connectors/webhooks/API keys) and host admin console (tenants/plans/partners), both permission/role-driven in the UI.
- **Seed data**: a `test` tenant is created automatically (`admin@test.local`), matching the "one CRM with one test tenant" requirement.

### Built since (Phase 2)

- **Automation engine** — granular triggers (created / updated / field-changed / *changed to a specific value* / stage-changed / activity-type-specific), conditions, and actions (update lead or opportunity, create opportunity/task/activity, reassign owner, call any API, send a message). Per-step execution log; loop protection via cascade-depth and per-record ceilings.
- **Custom action buttons** — admin-defined buttons on records that call your own API server-side, with `{{merge.tokens}}` and a click-to-insert token picker.
- **Telephony screen-pop** — SSE + Postgres `LISTEN/NOTIFY`, targeted at the one agent who took the call (resolved via any unique user field). Navigate or popup-card modes; ambiguous numbers show a chooser rather than guessing.
- **Messaging & payments through the customer's own provider** — Gupshup / Twilio / MSG91 / SendGrid / Resend / Razorpay / Stripe / any HTTP API. Credentials AES-256-GCM encrypted, never returned. Plus a **zero-cost WhatsApp mode** that deep-links to the user's own WhatsApp.
- **Unified capture API** — `POST /v1/capture` upserts lead + opportunity + activity atomically (built for telephony post-call sync, exposed publicly).
- **Bulk APIs & CSV import** for leads, opportunities (auto-resolving the parent lead) and activities, with per-row error capture.
- **Per-tenant API rate limits & daily quotas** — multi-process-correct via a single atomic statement; raised per tenant from the admin panel.
- **Entitlements / paid feature gating**, enforced server-side, with locked-but-visible UI states.
- **Embedded widgets** — any external page in a sandboxed iframe with record context merged into the URL, or sanitized inline HTML.
- **Named UI variants** — branchable, per-tenant UI rollout (branch a new variant from the *original*, not just the newest).
- **Audit & retention** — record history, settings-change history, API request/response logging with redaction; retention configurable per category and sold as an upgrade.
- **Admin panel teams** — multiple admin users, teams (Sales/Tech/Support/Billing), 13 granular permissions, super-admin protection, full action audit, and a break-glass recovery CLI.
- **Cost/revenue ledger** — per-tenant profitability with auto-derived usage costs.
- **Ops** — structured JSON logging with request-id correlation, `WORKER_ONLY` split, IP allowlisting, one-click NDJSON data export, onboarding checklist, in-app help.

Still not built (see blueprint §15 Phase 3): Converse-style WhatsApp inbox, email sync, custom report builder, native mobile app, AI features. Deliberately out of scope: customer-authored code execution (Lapps-style) and a free-form drag-and-drop page builder — see `NexCRM-Build-Status-and-Sellability.md` for the reasoning.

### Documentation index

| Document | Covers |
|---|---|
| [`SETUP-NEW-MACHINE.md`](SETUP-NEW-MACHINE.md) | Clone → running, on a fresh machine |
| [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) | End-user and admin guide (plain language) |
| [`CRM-BLUEPRINT.md`](CRM-BLUEPRINT.md) | Original product design and roadmap |
| [`NexCRM-Vertical-and-Feature-Analysis.md`](NexCRM-Vertical-and-Feature-Analysis.md) | Six verticals, gaps, feasibility |
| [`NexCRM-Analysis-Part2-Platform-Connectors-GoLive.md`](NexCRM-Analysis-Part2-Platform-Connectors-GoLive.md) | LeadSquared parity, connectors, per-tenant UI |
| [`NexCRM-Build-Status-and-Sellability.md`](NexCRM-Build-Status-and-Sellability.md) | What's built, what's deferred, what we won't build |
| [`NexCRM-Architecture-Cost-and-Answers.md`](NexCRM-Architecture-Cost-and-Answers.md) | Multi-tenancy, cost model, scalability ceilings |
| [`NexCRM-Answers-Cost-Monitoring-Runbooks.md`](NexCRM-Answers-Cost-Monitoring-Runbooks.md) | Monitoring thresholds, read-replica & dedicated-cluster runbooks |
| [`NexCRM-Decisions-Pricing-Vertical-SEO.md`](NexCRM-Decisions-Pricing-Vertical-SEO.md) | Pricing tiers, vertical strategy, signup model, SEO |
| [`NexCRM-GitHub-Setup-and-Commercial-Policy.md`](NexCRM-GitHub-Setup-and-Commercial-Policy.md) | Load-test results, GitHub setup, commercial policy |
| [`NexCRM-GoLive-Joint-Plan.md`](NexCRM-GoLive-Joint-Plan.md) | Step-by-step go-live plan, split by owner |
| [`NexCRM-CI-Troubleshooting-and-Next-Steps.md`](NexCRM-CI-Troubleshooting-and-Next-Steps.md) | CI diagnostics, branch protection, current queue |

## Repo layout

```
apps/api/          Express + TypeScript API
apps/web/           React + Vite frontend (tenant app + host admin, routed by path)
db/migrations/      SQL migrations, run in order, tracked in schema_migrations
deploy/             Dockerfiles + nginx config for production images
docker-compose.yml  One-command local stack: Postgres + API + web
CRM-BLUEPRINT.md    Full product/architecture blueprint and roadmap
```

## Running it locally

### Option A — Docker (recommended, closest to production)

Requires Docker Desktop (or any Docker engine) on your machine.

```bash
cp .env.example .env        # edit JWT secrets before going to production
docker compose up --build
```

This starts Postgres, runs migrations + seed automatically, and serves the API on `http://localhost:4000` and the web app on `http://localhost:3000`.

Log in:
- Tenant app (`http://localhost:3000/login`): tenant ID `test`, email `admin@test.local`, password `ChangeMe123!`
- Host admin (`http://localhost:3000/host/login`): email `owner@nexcrm.local`, password `ChangeMe123!`

**Change both passwords immediately** — they're seeded for first login only.

### Option B — Run directly with Node (no Docker)

You need a real Postgres 14+ instance (a local install, or a free one from Neon/Supabase/Railway).

```bash
npm install
# point these at your Postgres — DATABASE_ADMIN_URL needs superuser rights (creates the crm_app role + RLS policies)
export DATABASE_ADMIN_URL=postgres://postgres:yourpassword@localhost:5432/nexcrm
export DATABASE_URL=postgres://crm_app:crm_app_pw@localhost:5432/nexcrm
export JWT_SECRET=$(openssl rand -hex 32)
export HOST_JWT_SECRET=$(openssl rand -hex 32)

npm run migrate -w apps/api
npm run seed -w apps/api
npm run dev -w apps/api      # API on :4000

# in a second terminal
npm run dev -w apps/web      # Vite dev server on :5173
```

### Running the automated test suite

`apps/api/scripts/e2e.ts` spins up an embedded, throwaway Postgres (no setup needed) and exercises the full stack end to end: tenant provisioning, login, custom fields, distribution rules, lead capture → auto-assignment → activity scoring, permission enforcement (a Sales User is blocked from deleting), API-key scope enforcement, cross-tenant RLS isolation, and signed webhook delivery.

```bash
cd apps/api
DB_MODE=embedded npx tsx scripts/e2e.ts
```

All 23 checks pass as of this build. Run this after any backend change before shipping.

## Environment variables

A single `.env` at the repo root configures both apps — the API walks up from its working
directory to find it, and Vite is pointed at the same file via `envDir`. See `.env.example` for
the full annotated list, and [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) for local setup. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | App connection string (uses the restricted `crm_app` role — RLS enforced) |
| `DATABASE_ADMIN_URL` | Superuser connection, used only for migrations (creates `crm_app`, enables RLS) |
| `JWT_SECRET` / `HOST_JWT_SECRET` | Sign tenant vs. host admin sessions — **use distinct, long random values in production** |
| `META_VERIFY_TOKEN` / `WHATSAPP_VERIFY_TOKEN` | Webhook verification tokens you'll set when registering callback URLs with Meta/WhatsApp |
| `VITE_API_URL` (web) | Where the frontend points its API calls |

## Provisioning a real customer tenant

Log into the host admin console (`/host/login`) → Tenants → **New Tenant**. This creates the tenant, an Admin role/user, default permission sets (Administrator, Sales Manager, Sales User), default stages/sources/activity types, and a starter opportunity type — the same bootstrap the `test` tenant went through. You'll be shown the admin login to hand to the customer.

Equivalent via API:
```bash
curl -X POST $API_URL/host/api/tenants \
  -H "authorization: Bearer $HOST_TOKEN" -H "content-type: application/json" \
  -d '{"name":"Acme Corp","subdomain":"acme","planCode":"pro","adminEmail":"admin@acme.com","adminPassword":"..."}'
```

## Connecting WhatsApp / Meta / a website form

In the tenant app: Settings → Connectors → New Connector. Each connector gets a unique inbound URL:

- **Website form**: `POST {API_URL}/capture/v1/forms/{token}` — point your HTML form's `action` here, or call it from your site's backend. Configure a field map (form field name → lead field) when creating the connector.
- **Meta Lead Ads**: register `{API_URL}/capture/v1/meta/{token}` as your Facebook App's webhook callback URL (leadgen subscription) during app review, using `META_VERIFY_TOKEN` for the verify challenge.
- **WhatsApp Cloud API**: register `{API_URL}/capture/v1/whatsapp/{token}` as your WhatsApp Business app's webhook, using `WHATSAPP_VERIFY_TOKEN`.

For local testing before you have a real domain, tunnel port 4000 with a tool like `ngrok http 4000` and use the tunnel URL as the callback.

## Deploying to the cloud

The app is a standard container workload: one Postgres, one API container, one static web container (nginx). It runs on any of these without code changes:

- **Railway / Render**: easiest — point each at this repo, one service using `deploy/Dockerfile.api` (set `DATABASE_URL`/`DATABASE_ADMIN_URL` to their managed Postgres, plus the JWT secrets), one static/web service using `deploy/Dockerfile.web` with `VITE_API_URL` set to the API's public URL, plus their managed Postgres add-on.
- **AWS/GCP/Azure**: build both images (`docker build -f deploy/Dockerfile.api .` / `deploy/Dockerfile.web`), push to a registry, run on ECS/Cloud Run/App Service, with RDS/Cloud SQL for Postgres. For India data residency (per the blueprint), use `ap-south-1` (Mumbai) or the closest regional equivalent.
- **A single VM**: `docker compose up -d` on any VM with Docker installed (Postgres included) is enough for a first pilot customer.

Before going live: set strong unique `JWT_SECRET`/`HOST_JWT_SECRET`, put the API behind HTTPS (a reverse proxy like Caddy/nginx or the platform's built-in TLS), and change the seeded host owner and test-tenant passwords.

## Known gaps to fix before heavy production use

- No automated DB backup job configured yet — set up your provider's automatic Postgres backups.
- No rate limiting on the public capture/webhook endpoints yet — put them behind a WAF/rate limiter (Cloudflare, or an nginx `limit_req`) before exposing publicly at scale.
- Email/password reset flow isn't built — host admin currently sets/repairs passwords directly.
- See `CRM-BLUEPRINT.md` §14 for the fuller security/compliance checklist (DPDP/GDPR data export, SOC2 posture, etc.) as you move toward paying customers.
