import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  /**
   * Read `.env` from the REPO ROOT rather than apps/web.
   *
   * Vite defaults envDir to the project root (apps/web), so a VITE_* variable set in the
   * repo-root `.env` — where every other setting lives, and where the API reads from — was
   * silently ignored. Locally that hid itself, because the client falls back to
   * http://localhost:4000. In a deployed build it would not: VITE_API_URL is inlined at BUILD
   * time, so the fallback would ship, and the production site would try to call localhost.
   *
   * Only VITE_-prefixed variables are exposed to client code (Vite's default envPrefix), so
   * pointing at the root file does not risk leaking JWT_SECRET or CREDENTIALS_KEY into the bundle.
   */
  envDir: '../../',
});
