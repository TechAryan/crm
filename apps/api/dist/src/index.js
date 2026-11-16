import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { loadedEnvFile } from './env.js';
import { initDb, stopDb } from './db.js';
import { authRouter, hostAuthRouter, requireAuth, requireHostAuth, enforcePasswordChange } from './auth.js';
import { leadsRouter } from './routes/leads.js';
import { activityTypesRouter } from './routes/activityTypes.js';
import { opportunitiesRouter, opportunityTypesRouter } from './routes/opportunities.js';
import { tasksRouter } from './routes/tasks.js';
import { customFieldsRouter, stagesRouter, sourcesRouter } from './routes/customFields.js';
import { usersRouter, rolesRouter, permissionSetsRouter, teamsRouter, apiKeysRouter, meRouter, brandingRouter } from './routes/users.js';
import { connectorsRouter, publicCaptureRouter } from './routes/connectors.js';
import { importsRouter } from './routes/imports.js';
import { distributionRouter } from './routes/distribution.js';
import { webhooksRouter } from './routes/webhooksAdmin.js';
import { hostAdminRouter } from './routes/hostAdmin.js';
import { reportsRouter } from './routes/reports.js';
import { activitiesRouter } from './routes/activities.js';
import { filesRouter } from './routes/files.js';
import { formsRouter } from './routes/forms.js';
import { docsRouter } from './routes/docs.js';
import { smartViewsRouter } from './routes/smartViews.js';
import { auditRouter } from './routes/audit.js';
import { tenantSettingsRouter } from './routes/tenantSettings.js';
import { automationRouter } from './routes/automation.js';
import { customActionsRouter } from './routes/customActions.js';
import { captureRouter } from './routes/capture.js';
import { featuresRouter } from './routes/features.js';
import { telephonyRouter, eventsRouter } from './routes/telephony.js';
import { messagingRouter } from './routes/messaging.js';
import { widgetsRouter } from './routes/widgets.js';
import { bulkRouter } from './routes/bulk.js';
import { paymentsRouter, paymentWebhookRouter } from './routes/payments.js';
import { uiVariantsRouter, uiVariantPublicRouter } from './routes/uiVariants.js';
import { apiRequestLogger } from './apiLog.js';
import { hostTeamRouter } from './routes/hostTeam.js';
import { ledgerRouter } from './routes/ledger.js';
import { dataExportRouter } from './routes/dataExport.js';
import { onboardingRouter } from './routes/onboarding.js';
import { helpRouter } from './routes/help.js';
import { tenantRateLimit, startQuotaSweeper, stopQuotaSweeper } from './quota.js';
import { startRealtime, stopRealtime } from './realtime.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { assertProductionConfig } from './config.js';
import { encryptionAvailable } from './crypto.js';
import { rateLimit } from './rateLimit.js';
import { startWebhookDispatcher, stopWebhookDispatcher } from './webhooks.js';
import { log, requestLogger, installCrashHandlers } from './logger.js';
async function main() {
    installCrashHandlers();
    // Say where configuration came from. Silence here previously meant a `.env` could be ignored
    // entirely with no indication until a connection failed with an unrelated-looking error.
    log.info(loadedEnvFile ? `config loaded from ${loadedEnvFile}` : 'no .env found — using the process environment', {
        dbMode: config.dbMode,
    });
    // Refuse to boot in production with dev secrets or a missing encryption key.
    assertProductionConfig();
    await initDb();
    if (!encryptionAvailable()) {
        log.warn('CREDENTIALS_KEY is not set — messaging/payment connector credentials cannot be stored', {
            fix: 'openssl rand -base64 32',
        });
    }
    /**
     * WORKER_ONLY mode: run the background jobs (webhook dispatcher, scheduler, retention purge,
     * realtime listener) WITHOUT serving HTTP. Once you run more than one API instance, a heavy
     * retention sweep or distribution run competes with request latency — so you deploy the same
     * image twice: N web replicas with WORKER_ONLY unset, and exactly one worker with it set.
     * Job claiming already uses FOR UPDATE SKIP LOCKED, so this is safe either way.
     */
    const workerOnly = process.env.WORKER_ONLY === 'true';
    // Web replicas skip background jobs so only the worker performs them.
    const runBackgroundJobs = workerOnly || process.env.RUN_BACKGROUND_JOBS !== 'false';
    if (workerOnly) {
        log.info('starting in WORKER_ONLY mode (background jobs only, no HTTP server)');
        startWebhookDispatcher();
        startQuotaSweeper();
        startScheduler();
        await startRealtime();
        const shutdownWorker = async () => {
            log.info('worker shutting down');
            stopWebhookDispatcher();
            stopQuotaSweeper();
            stopScheduler();
            await stopRealtime();
            await stopDb();
            process.exit(0);
        };
        process.on('SIGINT', shutdownWorker);
        process.on('SIGTERM', shutdownWorker);
        return;
    }
    const app = express();
    app.use(cors());
    // Request ids + one structured log line per request. First, so everything downstream is traced.
    app.use(requestLogger());
    // Payment webhooks need the RAW body: Stripe (and Razorpay) sign the exact bytes, so any
    // re-serialisation breaks signature verification. Capture it before the JSON parser runs.
    app.use('/payments/webhook', express.json({
        limit: '1mb',
        verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
    }));
    app.use(express.json({ limit: '10mb' }));
    // Liveness: is the process up? Used by the container orchestrator to restart a wedged pod.
    app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
    // Readiness: can we actually serve traffic (DB reachable)? Used by the load balancer so a
    // node with a broken DB connection is pulled out of rotation instead of serving errors.
    app.get('/ready', async (_req, res) => {
        try {
            const { control } = await import('./db.js');
            await control(c => c.query('SELECT 1'));
            res.json({ ready: true });
        }
        catch (e) {
            res.status(503).json({ ready: false, error: e?.message || 'not ready' });
        }
    });
    /**
     * SEO hygiene: everything this API serves is either private (behind auth) or a customer's own
     * capture form. None of it should appear in search results — indexed customer forms would
     * compete with the customer's own site and leak their campaign structure. `X-Robots-Tag`
     * covers non-HTML responses too, which a <meta> tag cannot.
     */
    app.use((_req, res, next) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
        next();
    });
    // Explicit robots.txt so crawlers don't need to guess.
    app.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    });
    // --- public unauthenticated endpoints (rate limited) ---
    const loginLimiter = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'login' });
    const captureLimiter = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'capture' });
    app.use('/auth', loginLimiter, authRouter);
    app.use('/host/auth', loginLimiter, hostAuthRouter);
    app.use('/capture/v1', captureLimiter, publicCaptureRouter);
    // Payment provider callbacks: unauthenticated but signature/token verified inside.
    app.use('/payments', captureLimiter, paymentWebhookRouter);
    app.use('/docs', docsRouter);
    // --- host admin (control plane) ---
    app.use('/host/api', requireHostAuth, hostAdminRouter);
    app.use('/host/api/ui-variants', requireHostAuth, uiVariantsRouter);
    app.use('/host/api/team', requireHostAuth, hostTeamRouter);
    app.use('/host/api/ledger', requireHostAuth, ledgerRouter);
    // Cross-tenant onboarding progress — a churn signal, not just a UI nicety.
    app.use('/host/api/onboarding', requireHostAuth, onboardingRouter);
    // --- tenant API (v1), all require auth ---
    const v1 = express.Router();
    v1.use(requireAuth);
    v1.use(enforcePasswordChange);
    // Per-tenant rate limiting + daily quota. Mounted after auth (needs the tenant) and before
    // any route so every tenant API call is metered.
    v1.use(tenantRateLimit());
    // API request/response logging (redacted, truncated, retention-bounded). After auth so the
    // tenant and actor are known; after the rate limiter so throttled calls are also recorded.
    v1.use(apiRequestLogger());
    v1.use('/leads', leadsRouter);
    v1.use('/activity-types', activityTypesRouter);
    v1.use('/opportunities', opportunitiesRouter);
    v1.use('/opportunity-types', opportunityTypesRouter);
    v1.use('/tasks', tasksRouter);
    v1.use('/fields', customFieldsRouter);
    v1.use('/stages', stagesRouter);
    v1.use('/sources', sourcesRouter);
    v1.use('/users', usersRouter);
    v1.use('/roles', rolesRouter);
    v1.use('/permission-sets', permissionSetsRouter);
    v1.use('/teams', teamsRouter);
    v1.use('/api-keys', apiKeysRouter);
    v1.use('/me', meRouter);
    v1.use('/branding', brandingRouter);
    v1.use('/connectors', connectorsRouter);
    v1.use('/imports', importsRouter);
    v1.use('/distribution-rules', distributionRouter);
    v1.use('/webhooks', webhooksRouter);
    v1.use('/reports', reportsRouter);
    v1.use('/activities', activitiesRouter);
    v1.use('/files', filesRouter);
    v1.use('/forms', formsRouter);
    v1.use('/smart-views', smartViewsRouter);
    v1.use('/audit', auditRouter);
    v1.use('/settings/tenant', tenantSettingsRouter);
    v1.use('/automation', automationRouter);
    v1.use('/custom-actions', customActionsRouter);
    v1.use('/capture', captureRouter);
    v1.use('/features', featuresRouter);
    v1.use('/telephony', telephonyRouter);
    v1.use('/events', eventsRouter);
    v1.use('/messaging', messagingRouter);
    v1.use('/widgets', widgetsRouter);
    v1.use('/bulk', bulkRouter);
    v1.use('/payments', paymentsRouter);
    v1.use('/ui-variant', uiVariantPublicRouter);
    v1.use('/export', dataExportRouter);
    v1.use('/onboarding', onboardingRouter);
    v1.use('/help', helpRouter);
    v1.get('/me', async (req, res) => {
        // uiVersion drives staged UI rollout: we can ship a new view to a test tenant, then opt
        // customers in one at a time while everyone else keeps the current view. This is the
        // supported alternative to forking code per tenant.
        let uiVersion = 1;
        try {
            const { control } = await import('./db.js');
            const row = (await control(c => c.query(`SELECT ui_version FROM tenants WHERE id=$1`, [req.auth.tenantId]))).rows[0];
            uiVersion = row?.ui_version ?? 1;
        }
        catch { /* fall back to v1 rather than failing the session bootstrap */ }
        res.json({
            userId: req.auth.userId, tenantId: req.auth.tenantId, tenantCode: req.auth.tenantCode,
            permissions: req.auth.perms, uiPolicy: req.auth.uiPolicy, recordScope: req.auth.recordScope,
            mustChangePassword: req.auth.mustChangePassword, uiVersion,
        });
    });
    app.use('/v1', v1);
    app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.path}` } }));
    const server = app.listen(config.port, () => log.info('nexcrm api listening', { port: config.port, backgroundJobs: runBackgroundJobs }));
    // Realtime (SSE fan-out) must run on web replicas — that's where browsers connect.
    await startRealtime();
    if (runBackgroundJobs) {
        startWebhookDispatcher();
        startQuotaSweeper();
        startScheduler();
    }
    else {
        log.info('background jobs disabled on this instance (a dedicated WORKER_ONLY process handles them)');
    }
    const shutdown = async () => {
        log.info('shutting down');
        stopWebhookDispatcher();
        stopQuotaSweeper();
        stopScheduler();
        await stopRealtime();
        // Stop accepting new connections, then drain the pool. Without the graceful close a rolling
        // deploy drops in-flight requests.
        server.close();
        await stopDb();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch(e => { log.error('fatal startup error', { error: e?.message, stack: e?.stack }); process.exit(1); });
