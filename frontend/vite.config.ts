import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The commit this bundle is built from:
 * TERMAG_BAKED_SHA, else the bake's /opt/termag/.termag-baked-sha (written
 * before the build; the image has no .git), else git, else 'unknown'.
 */
function buildSha(): string {
  const ok = (v: string | undefined) => (v && /^[0-9a-f]{7,40}$/.test(v.trim()) ? v.trim().slice(0, 12) : null);
  const fromEnv = ok(process.env.TERMAG_BAKED_SHA);
  if (fromEnv) return fromEnv;
  try { const f = ok(readFileSync(resolve(__dirname, '../.termag-baked-sha'), 'utf8')); if (f) return f; } catch { /* not a baked tree */ }
  try { const g = ok(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); if (g) return g; } catch { /* no git */ }
  return 'unknown';
}

export default defineConfig({
  plugins: [react()],
  define: { __TERMAG_SHA__: JSON.stringify(buildSha()) },
  base: '/termag/',
  // Public sourcemaps next to each chunk (assets/<chunk>.js.map), so
  // browser error tooling can symbolicate browser errors by fetching them
  // by URL. The bundle is already served unauthenticated; the map adds the
  // unminified source of the same code.
  build: { sourcemap: true },
  server: {
    port: 5174,
    proxy: {
      '/termag/auth': 'http://localhost:3040',
      '/termag/api': 'http://localhost:3040',
      '/termag/ws': {
        target: 'ws://localhost:3040',
        ws: true,
      },
      '/termag/health': 'http://localhost:3040',
      '/termag/files': 'http://localhost:3040',
      // Share links; the slash keeps /termag/preview/ in the SPA.
      '/termag/p/': 'http://localhost:3040',
    },
  },
});
