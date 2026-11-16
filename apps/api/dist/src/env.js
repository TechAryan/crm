/**
 * Loads `.env` into process.env. Import this BEFORE anything reads process.env at module scope.
 *
 * WHY THIS FILE EXISTS: for a long time nothing loaded `.env` at all. Every environment variable
 * was passed inline on the command line (`DB_MODE=embedded npm run test:e2e`), which is how the
 * e2e suite and the pre-push hook run — so the whole test suite passed while `npm run dev:api`
 * could not start. A `.env` file sat in the repo looking authoritative and was read by nobody.
 * That is a bad failure mode: it fails at the point of first use, with an error that names a
 * Postgres role rather than the missing config.
 *
 * Two deliberate choices:
 *
 * 1. WALKS UP from cwd. `npm run dev -w apps/api` executes with cwd=apps/api, but `.env` lives at
 *    the repo root. Loading only from cwd would silently find nothing in the common case.
 *
 * 2. DOES NOT OVERRIDE variables already set. An inline `DB_MODE=embedded npm run …` must beat
 *    the file, otherwise the hook and CI would start picking up a developer's local `.env` and
 *    testing something other than what they think. dotenv's default is no-override; it is stated
 *    explicitly here because the ordering matters.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
function findEnvFile() {
    let dir = process.cwd();
    // Six levels is far more than the repo is deep; the loop also stops at the filesystem root.
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, '.env');
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/** Absolute path of the .env that was loaded, or null when running purely on the real
 *  environment (containers, CI, a PaaS). Reported at startup so "which config am I running?"
 *  is never a guess. */
export const loadedEnvFile = findEnvFile();
if (loadedEnvFile) {
    dotenv.config({ path: loadedEnvFile, override: false });
}
