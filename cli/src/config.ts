import { join } from 'node:path';
import { usage } from './errors.js';

export const DEFAULT_HOST = 'https://app.termag.example.com/termag';
// Every deployment serves termag under this path (BASE_PATH).
const DEFAULT_BASE_PATH = '/termag';

/**
 * Canonical orchestrator URL: scheme + host + base path, no trailing slash.
 * `localhost:3040` means http://localhost:3040/termag; a bare host defaults to
 * https, except loopback.
 */
export function normalizeHost(input: string): string {
  let text = input.trim();
  if (!text) throw usage('--host must not be empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const hostPart = text.split('/')[0];
    const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(hostPart);
    text = `${loopback ? 'http' : 'https'}://${text}`;
  }
  let url: URL;
  try { url = new URL(text); } catch { throw usage(`Not a valid orchestrator URL: ${input}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw usage(`The orchestrator URL must be http(s): ${input}`);
  if (url.username || url.password) throw usage('The orchestrator URL must not contain credentials');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path || DEFAULT_BASE_PATH}`;
}

/** ws://host:3040/termag/ws/agent → http://host:3040/termag (adapted from PR #136's tui/src/config.ts). */
export function baseUrlFromAgentUrl(agentWsUrl: string): string {
  const u = new URL(agentWsUrl);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported scheme ${u.protocol}`);
  const path = u.pathname.replace(/\/ws\/agent\/?$/, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path || DEFAULT_BASE_PATH}`;
}

/** Where a box's (or a per-user) agent keeps its config, most specific first. */
export function agentConfigCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = [];
  if (env.TERMAG_AGENT_CONFIG) out.push(env.TERMAG_AGENT_CONFIG);
  out.push(
    join(home, 'src', 'termag', 'agent', 'agent.config.json'),
    join(home, '.config', 'termag', 'agent.config.json'),
    join(home, '.termag', 'agent.config.json'),
  );
  return out;
}

export interface BoxCredential {
  host: string;
  token: string;
  path: string;
}

export type ReadFile = (path: string) => string | null;

/**
 * The agent token of the machine we're running on, so a box needs no
 * `termag login`. Only a real `tmag_` token counts: the example config ships
 * a placeholder.
 */
export function findBoxCredential(env: NodeJS.ProcessEnv, home: string, read: ReadFile): BoxCredential | null {
  for (const path of agentConfigCandidates(env, home)) {
    const text = read(path);
    if (!text) continue;
    let cfg: Record<string, unknown>;
    try { cfg = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
    const ws = typeof cfg.termag_url === 'string' ? cfg.termag_url : typeof cfg.server_url === 'string' ? cfg.server_url : null;
    const token = typeof cfg.token === 'string' ? cfg.token : null;
    if (!ws || !token || !token.startsWith('tmag_')) continue;
    try {
      return { host: baseUrlFromAgentUrl(ws), token, path };
    } catch {
      continue;
    }
  }
  return null;
}

export interface Target {
  host: string;
  source: 'flag' | 'env' | 'box' | 'default';
  box: BoxCredential | null;
}

/**
 * Which orchestrator to talk to: --host, then TERMAG_URL, then (on a box) the
 * box's own orchestrator, then the production default. The box credential is
 * offered only when it belongs to the chosen orchestrator.
 */
export function resolveTarget(flagHost: string | undefined, env: NodeJS.ProcessEnv, home: string, read: ReadFile): Target {
  const box = findBoxCredential(env, home, read);
  let host: string;
  let source: Target['source'];
  if (flagHost !== undefined) { host = normalizeHost(flagHost); source = 'flag'; }
  else if (env.TERMAG_URL) { host = normalizeHost(env.TERMAG_URL); source = 'env'; }
  else if (box) { host = box.host; source = 'box'; }
  else { host = DEFAULT_HOST; source = 'default'; }
  return { host, source, box: box && box.host === host ? box : null };
}
