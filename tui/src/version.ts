import { readFileSync } from 'node:fs';

const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,39}$/;

/**
 * The TUI's version, for its User-Agent (`termag-tui/<version>`, which the
 * orchestrator records per user for the admin Software tab):
 * `<major>.<minor>.<commits touching tui/>+<the latest one's sha>`, e.g.
 * `0.1.18+d57cf6f2`, the same scheme as the CLI's. The build writes it to
 * `dist/version.txt` (cli/buildVersion.mjs, from git; tui/install.sh and
 * `npm run build`). Run from the sources (vitest, `npm run dev`) there is no
 * such file and it is package.json's version. A file that isn't a version is
 * ignored, since the value goes into a header.
 */
export function readVersion(here: URL = new URL('.', import.meta.url)): string {
  try {
    const built = readFileSync(new URL('version.txt', here), 'utf8').trim();
    if (VERSION_RE.test(built)) return built;
  } catch { /* not a build */ }
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', here), 'utf8')) as { version?: unknown };
    if (typeof version === 'string' && VERSION_RE.test(version)) return version;
  } catch { /* no package.json beside it */ }
  return '0.1.0';
}

export const TUI_VERSION = readVersion();
