// MUST be the first import: this module reads process.env at module-evaluation time, so `.env`
// has to be loaded before the object literal below is built.
import './env.js';
export const config = {
    port: parseInt(process.env.PORT || '4000', 10),
    dbMode: process.env.DB_MODE || 'external', // external | embedded
    databaseUrl: process.env.DATABASE_URL || 'postgres://crm_app:crm_app_pw@localhost:5432/nexcrm',
    databaseAdminUrl: process.env.DATABASE_ADMIN_URL || 'postgres://postgres:postgres@localhost:5432/nexcrm',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    hostJwtSecret: process.env.HOST_JWT_SECRET || 'dev-host-secret-change-me',
    metaVerifyToken: process.env.META_VERIFY_TOKEN || 'meta-verify',
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'wa-verify',
    // Used to build admin-generated "set your password" links. Point this at the real web app
    // origin in production (e.g. https://app.yourcrm.com); no email is sent — the admin copies
    // and shares the link themselves until an SMTP/SES provider is wired up.
    appUrl: process.env.APP_URL || 'http://localhost:5173',
    // AES-256-GCM key (base64, 32 bytes) protecting tenant-supplied third-party credentials.
    // Generate: openssl rand -base64 32. MUST come from a secrets manager in production.
    credentialsKey: process.env.CREDENTIALS_KEY || '',
    // Default API limits when a plan doesn't specify them.
    defaultApiBurstSeconds: parseInt(process.env.API_BURST_SECONDS || '5', 10),
    defaultApiRatePerWindow: parseInt(process.env.API_RATE_PER_WINDOW || '50', 10),
    defaultApiDailyQuota: parseInt(process.env.API_DAILY_QUOTA || '50000', 10),
};
/**
 * Fail fast on insecure production configuration. Called at startup — a deploy with default
 * dev secrets is a serious risk, and silently accepting them is how it reaches production.
 */
export function assertProductionConfig() {
    if (process.env.NODE_ENV !== 'production')
        return;
    const problems = [];
    if (config.jwtSecret === 'dev-secret-change-me')
        problems.push('JWT_SECRET is still the development default');
    if (config.hostJwtSecret === 'dev-host-secret-change-me')
        problems.push('HOST_JWT_SECRET is still the development default');
    if (!config.credentialsKey)
        problems.push('CREDENTIALS_KEY is not set (third-party connector credentials cannot be stored)');
    if (config.appUrl.startsWith('http://'))
        problems.push('APP_URL is not https');
    if (problems.length) {
        throw new Error(`Refusing to start in production with insecure configuration:\n  - ${problems.join('\n  - ')}`);
    }
}
