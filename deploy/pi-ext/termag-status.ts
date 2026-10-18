/**
 * termag-status — pi extension that reports the pane's status to termag.
 *
 * Loaded by `pi` with `pi -e ~/.local/share/termag/pi-ext/termag-status.ts`
 * (installed by termag-reconcile). pi runs tools without approval prompts and
 * has no hooks file like Claude Code, so this is the pi counterpart of
 * deploy/claude-settings.json: it turns pi's lifecycle events into
 * working / waiting / idle / not_running posts plus context-token metadata.
 *
 * Posting goes through `~/.local/bin/termag-status`, never a direct fetch: that
 * script already resolves the endpoint from the agent config's termag_url, the
 * session from `tmux display-message -p '#S'`, and passes the bearer token via
 * `curl -K -` so it never appears in argv. The mapping itself lives in
 * ./termag-status-core.ts so it can be unit-tested without pi.
 *
 * Fail-open everywhere: a status bug must never take the agent down.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  initialState, keepalivePost, reduce, toArgv, KEEPALIVE_MS,
  type PiEventLike, type Post, type State,
} from './termag-status-core.ts';

const EVENTS = [
  'agent_start', 'turn_start', 'tool_execution_start', 'tool_execution_end',
  'message_end', 'after_provider_response', 'agent_end', 'session_shutdown',
] as const;

export default function termagStatus(pi: ExtensionAPI): void {
  const bin = process.env.TERMAG_STATUS_BIN ?? join(homedir(), '.local', 'bin', 'termag-status');
  let enabled = existsSync(bin);
  let state: State = initialState();
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const post = (p: Post): void => {
    if (!enabled) return;
    try {
      const child = execFile(bin, toArgv(p), { timeout: 6000 }, () => { /* fire and forget */ });
      child.unref?.();
    } catch { /* fail-open */ }
  };

  const handle = (ev: PiEventLike): void => {
    try {
      const r = reduce(state, ev, Date.now());
      state = r.state;
      for (const p of r.posts) post(p);
      if (state.inRun && !keepalive) {
        keepalive = setInterval(() => { const k = keepalivePost(state); if (k) post(k); }, KEEPALIVE_MS);
        keepalive.unref?.();
      } else if (!state.inRun && keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
    } catch { /* fail-open */ }
  };

  const on = pi.on as unknown as (type: string, handler: (ev: unknown, ctx: unknown) => void) => void;

  on('session_start', (ev, ctx) => {
    try {
      enabled = existsSync(bin);
      const ui = (ctx as { ui?: { setStatus?: (k: string, v: string) => void } } | undefined)?.ui;
      ui?.setStatus?.('termag', enabled ? 'termag ●' : 'termag: off');
    } catch { /* fail-open */ }
    handle(ev as PiEventLike);
  });

  on('turn_end', (ev, ctx) => {
    let contextTokens: number | undefined;
    try {
      const usage = (ctx as { getContextUsage?: () => { tokens?: number } | undefined } | undefined)?.getContextUsage?.();
      if (usage && typeof usage.tokens === 'number' && usage.tokens > 0) contextTokens = usage.tokens;
    } catch { /* fail-open */ }
    handle({ ...(ev as PiEventLike), type: 'turn_end', contextTokens });
  });

  for (const type of EVENTS) {
    on(type, ev => handle({ ...(ev as PiEventLike), type }));
  }
}
