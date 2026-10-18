/**
 * termag-otel — pi extension that exports a session's spans to the
 * telemetry project termag ships to.
 *
 * Loaded by the pi launch (providers/registry.ts) with `pi -e ~/.local/share/termag/pi-ext/termag-otel.ts`
 * (installed by termag-reconcile) next to termag-status.ts. pi has no
 * OpenTelemetry of its own, so this is its counterpart of Claude Code's
 * built-in export: the destination is the record termag-credentials writes
 * from the orchestrator's agent-telemetry delivery, read at each
 * session_start, and with none the extension does nothing. The mapping lives
 * in ./termag-otel-core.ts, metadata only.
 *
 * Spans go out as OTLP/JSON with only the content-type header: nothing of the
 * owner's shell exporter (OTEL_EXPORTER_OTLP_HEADERS and the like) is read.
 * Fail-open everywhere: telemetry must never take the agent down.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  initialState, parseDestination, reduce, toOtlp,
  type Destination, type PiEventLike, type Span, type State,
} from './termag-otel-core.ts';

const EVENTS = ['agent_start', 'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_end', 'agent_end'] as const;
/** Flush a long run's finished spans at least this often. */
const FLUSH_MS = 30_000;

function readRecord(): string | null {
  try {
    return readFileSync(process.env.TERMAG_AGENT_TELEMETRY ?? join(homedir(), '.config', 'termag', 'agent-telemetry.json'), 'utf8');
  } catch {
    return null;
  }
}

export default function termagOtel(pi: ExtensionAPI): void {
  let dest: Destination | null = null;
  let state: State = initialState();
  let pending: Span[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const newId = (bytes: 8 | 16): string => randomBytes(bytes).toString('hex');

  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dest || pending.length === 0) return Promise.resolve();
    const body = JSON.stringify(toOtlp(dest, pending));
    pending = [];
    return fetch(`${dest.endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    }).then(() => undefined, () => undefined);
  };

  const handle = (ev: PiEventLike): Promise<void> => {
    try {
      const r = reduce(state, ev, Date.now(), newId);
      state = r.state;
      if (dest && r.spans.length) pending.push(...r.spans);
      if (ev.type === 'agent_end' || ev.type === 'session_shutdown') return flush();
      if (pending.length && !timer) {
        timer = setTimeout(() => { void flush(); }, FLUSH_MS);
        timer.unref?.();
      }
    } catch { /* fail-open */ }
    return Promise.resolve();
  };

  const on = pi.on as unknown as (type: string, handler: (ev: unknown, ctx: unknown) => unknown) => void;

  on('session_start', (ev, ctx) => {
    let sessionId: string | undefined;
    try {
      dest = parseDestination(readRecord(), process.env.TERMAG_OTEL_REPLAY_ID);
      sessionId = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager?.getSessionId?.();
    } catch { dest = null; }
    return handle({ ...(ev as PiEventLike), type: 'session_start', sessionId });
  });

  // Awaited by pi before it exits, so the last spans are sent.
  on('session_shutdown', ev => handle({ ...(ev as PiEventLike), type: 'session_shutdown' }));

  for (const type of EVENTS) {
    on(type, ev => handle({ ...(ev as PiEventLike), type }));
  }
}
