// Bundles the CLI: src/main.ts and everything it imports into one ES module,
// dist/main.js, so `termag` loads one file instead of about 65. That cuts
// about 20 ms from every run (80 to 60 ms for `termag --version` on a box).
// Type checking is tsc's (`npm run typecheck`, and `npm run build` and
// install.sh run it with --noEmit first); esbuild only strips the types.
//
// The modules loaded with a dynamic import() (events/socket.ts and
// forward/forwarder.ts, the only ones that need `ws`) stay separate files in
// the same directory (`splitting`), so a run that doesn't need them doesn't
// load them, and every other command still starts when node_modules has lost
// `ws` (lazyWs.ts). Packages stay external and resolve from node_modules as
// before. Every output file sits directly in the output directory, one level
// below cli/, as tsc's did: tui.ts and update.ts find the CLI and the checkout
// from import.meta.url.
//
// The version (`termag --version`, the User-Agent, usage and bug reports) is
// buildVersion.mjs's, from git, set as __TERMAG_CLI_VERSION__ (version.ts).
//
// Usage: node build.mjs [<outdir>]   (default dist; install.sh passes its
// scratch directory). The output directory is emptied first.
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildVersion } from './buildVersion.mjs';

const cliDir = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(cliDir, process.argv[2] ?? 'dist');

rmSync(outdir, { recursive: true, force: true });
await build({
  absWorkingDir: cliDir,
  entryPoints: ['src/main.ts'],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  define: { __TERMAG_CLI_VERSION__: JSON.stringify(buildVersion(cliDir)) },
  logLevel: 'warning',
});
