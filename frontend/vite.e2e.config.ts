// Vite config for the local e2e stack (scripts/e2e/up.sh): the normal config,
// pointed at the e2e backend's port and caching under the stack's temp root.
import { mergeConfig } from 'vite';
import base from './vite.config';

const backend = process.env.E2E_BACKEND_URL;
if (!backend) throw new Error('E2E_BACKEND_URL is required (set by scripts/e2e/up.sh)');
const ws = backend.replace(/^http/, 'ws');

export default mergeConfig(base, {
  cacheDir: process.env.E2E_VITE_CACHE_DIR,
  server: {
    proxy: {
      '/termag/auth': backend,
      '/termag/api': backend,
      '/termag/ws': { target: ws, ws: true },
      '/termag/health': backend,
    },
  },
});
