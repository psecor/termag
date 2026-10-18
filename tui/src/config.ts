import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { TokenRefresh } from './api.js';

/**
 * Where the TUI gets its backend URL and bearer token: TERMAG_URL and
 * TERMAG_TOKEN, which `termag tui` sets from the CLI's own sign-in
 * (`termag login`: its access token, plus TERMAG_REFRESH_TOKEN and
 * TERMAG_TOKEN_EXPIRES_AT to renew it) or, on a box, from the box's agent token. The TUI has no
 * credential store and no sign-in of its own.
 *
 * ~/.config/termag/tui.json holds only TUI settings: `returnKey`, the
 * remote-attach `prefix`, `notify`, and the remembered `lastTarget`.
 *
 * Every call goes to /api/cli/v1 (api.ts), and the two WebSockets the TUI
 * opens are that API's (/api/cli/v1/ws/status and /ws/terminal, bearer in the
 * header). It never opens /termag/ws/agent: a box's agent token is a valid
 * credential there, and connecting would evict the box's real agent.
 */
export interface TuiConfig {
  url: string;          // e.g. http://host:3040/termag
  token: string;
  /** Set for a device sign-in (TERMAG_REFRESH_TOKEN, TERMAG_TOKEN_EXPIRES_AT): the access token is renewed with it. */
  refresh?: TokenRefresh;
  source: string;       // which credential `termag tui` chose, for the header
  returnKey: string | null; // tmux key (in the prefix table) that switches back to the TUI session
  /** Remote-attach prefix byte; default Ctrl-\ (0x1c). tui.json `prefix` takes "C-x" or a single character. */
  prefix: string;
  /** Desktop notification (OSC 777 / OSC 9) when a session enters `waiting`; the bell always rings. Default true. */
  notify: boolean;
  lastTarget?: { projectId: string; workstream: string } | null;
}

/** "C-\\" / "C-]" / "C-a" → the control byte; a single character is taken as-is. */
export function parsePrefix(value: unknown): string {
  if (typeof value !== 'string' || !value) return '\x1c';
  const m = /^C-(.)$/i.exec(value);
  if (m) {
    const c = m[1];
    if (c === '\\') return '\x1c';
    if (c === ']') return '\x1d';
    if (c === '^') return '\x1e';
    if (c === '_') return '\x1f';
    const code = c.toLowerCase().charCodeAt(0) - 0x60;
    if (code >= 1 && code <= 26) return String.fromCharCode(code);
  }
  return [...value].length === 1 ? value : '\x1c';
}

export const TUI_CONFIG_PATH = join(homedir(), '.config', 'termag', 'tui.json');

type Reader = (path: string) => string | null;
const fsReader: Reader = (p) => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env, read: Reader = fsReader, home = homedir()): TuiConfig {
  const tuiFile = parseJson(read(join(home, '.config', 'termag', 'tui.json'))) ?? {};
  const returnKey = tuiFile.returnKey === null ? null : (typeof tuiFile.returnKey === 'string' ? tuiFile.returnKey : 'T');
  const prefix = parsePrefix(tuiFile.prefix);
  const notify = tuiFile.notify !== false;
  const lastTarget = (tuiFile.lastTarget as TuiConfig['lastTarget']) ?? null;

  if (!env.TERMAG_URL || !env.TERMAG_TOKEN) {
    throw new Error('No credentials: start the TUI with `termag tui`, which signs it in with your `termag login` (or, on a box, the box\'s own credentials).');
  }
  const expiresAt = Date.parse(env.TERMAG_TOKEN_EXPIRES_AT ?? '');
  return {
    url: env.TERMAG_URL.replace(/\/$/, ''),
    token: env.TERMAG_TOKEN,
    ...(env.TERMAG_REFRESH_TOKEN
      // An unreadable expiry renews on the first call.
      ? { refresh: { refreshToken: env.TERMAG_REFRESH_TOKEN, expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt } }
      : {}),
    source: env.TERMAG_CREDENTIAL || 'TERMAG_TOKEN',
    returnKey,
    prefix,
    notify,
    lastTarget,
  };
}

/** Persist only the remembered selection. A `url`/`token` left from older TUIs is dropped. */
export function saveLastTarget(target: { projectId: string; workstream: string } | null, path = TUI_CONFIG_PATH): void {
  try {
    const { url: _url, token: _token, ...existing } = parseJson(fsReader(path)) ?? {};
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...existing, lastTarget: target }, null, 2) + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}
