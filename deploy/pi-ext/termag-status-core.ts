/**
 * termag-status-core — the pure part of termag's pi status extension.
 *
 * Maps pi extension events onto termag status posts. No imports, no I/O: the
 * adapter (termag-status.ts) feeds events in and shells the resulting argv out
 * to `termag-status`, which owns endpoint/token/session resolution. Keeping
 * this half pure is what lets backend/src/providers/piStatusExtension.test.ts
 * exercise the whole mapping without pi.
 *
 * Every post carries `--source pi-ext:pi`, on any model backend:
 * the source names the harness, and the backend books a status with no
 * recognised source as Claude (services/status.ts), so a missing source would
 * silently credit Claude with pi's working time.
 */

export const SOURCE = 'pi-ext:pi';

/** Which model backend this pi runs on, for what a failed model request
 *  tells the owner to do. The launcher names it in TERMAG_PI_AGENT. */
export interface PiAgent {
  label: string;
  remedy: (status: number) => string;
  badge: (status: number) => string;
}

export const PI: PiAgent = {
  label: 'pi',
  remedy: brokerRemedy,
  badge: status => `pi: model endpoint HTTP ${status}`,
};

// Fireworks' answers come through the termag gateway: a
// 401 or 403 is the gateway refusing this box, which `termag-credentials
// status` explains; anything else is Fireworks or the gateway failing.
export const FIREWORKS: PiAgent = {
  label: 'Fireworks',
  remedy: status => (status === 401 || status === 403
    ? `Fireworks gateway HTTP ${status} — the termag gateway refused this box; in the ctrl pane run: termag-credentials status`
    : `Fireworks gateway HTTP ${status} — the model request failed; in the ctrl pane run: termag-credentials status`),
  badge: status => `Fireworks: gateway HTTP ${status}`,
};

export function piAgent(name: string | undefined): PiAgent {
  return name === 'fireworks' ? FIREWORKS : PI;
}

/** Re-post `working` this often during a run so a single long tool call does
 *  not trip the backend's 5-minute auto-idle. */
export const KEEPALIVE_MS = 4 * 60_000;
/** Within a run, repeat `working` on tool/turn events at most this often. */
export const DEBOUNCE_MS = 60_000;

export type Status = 'working' | 'waiting' | 'idle' | 'not_running';

export type Post =
  | {
      kind: 'status';
      status: Status;
      waitingReason?: 'user_input' | 'approval';
      notify?: boolean;
      message?: string;
      /** null clears a badge a previous process may have left behind. */
      rateLimited?: string | null;
    }
  | { kind: 'meta'; contextTokens?: number | null; rateLimited?: string | null };

export interface State {
  lastStatus: Status | null;
  lastPostAt: number;
  inRun: boolean;
  /** HTTP status of the last failed provider response in this run, if any. */
  brokerError: number | null;
  /** A `rateLimited` badge is currently shown and must be cleared on recovery. */
  flagged: boolean;
  contextTokens: number | null;
  lastAssistantText: string;
  lastStopReason: string | null;
}

/** Structural view of the pi events we read. Never import pi's types here. */
export interface PiEventLike {
  type: string;
  /** after_provider_response */
  status?: number;
  /** session_shutdown */
  reason?: string;
  /** turn_end / message_end */
  message?: {
    role?: string;
    stopReason?: string;
    content?: unknown;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
  /** Filled by the adapter from ctx.getContextUsage() when available. */
  contextTokens?: number;
}

export function initialState(): State {
  return {
    lastStatus: null, lastPostAt: 0, inRun: false, brokerError: null, flagged: false,
    contextTokens: null, lastAssistantText: '', lastStopReason: null,
  };
}

export function brokerRemedy(status: number): string {
  if (status === 400 || status === 404) {
    return `pi: model endpoint HTTP ${status} — the model or deployment may have changed; check pi's model settings in the ctrl pane`;
  }
  return `pi: model endpoint HTTP ${status} — check the model provider's credentials in the ctrl pane`;
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

function isBrokerFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404 || status >= 500;
}

export function reduce(state: State, ev: PiEventLike, now: number, agent: PiAgent = PI): { state: State; posts: Post[] } {
  const s: State = { ...state };
  const posts: Post[] = [];
  const status = (p: Omit<Extract<Post, { kind: 'status' }>, 'kind'>) => {
    posts.push({ kind: 'status', ...p });
    s.lastStatus = p.status;
    s.lastPostAt = now;
  };

  switch (ev.type) {
    case 'session_start':
      // Makes the session known to the backend: metadata-only posts for a
      // session that never reported a status are dropped (updateStatusMeta).
      // Also a hard reset: after /reload, /new or /resume pi starts a session
      // without a prior agent_end, so a run must not survive into it.
      s.inRun = false;
      s.brokerError = null;
      s.lastStopReason = null;
      s.lastAssistantText = '';
      // A fresh process has nothing to be throttled about, and it cannot know
      // whether the previous one raised the badge (the backend keeps
      // `rateLimited` across status flips, and `flagged` lived in that
      // process). Seen live: timeout → badge, user restarts pi, next run
      // succeeds, badge stays forever. So every session start clears it.
      s.flagged = false;
      status({ status: 'idle', rateLimited: null });
      break;

    case 'agent_start':
      s.inRun = true;
      s.brokerError = null;
      s.lastStopReason = null;
      s.lastAssistantText = '';
      status({ status: 'working' });
      break;

    case 'turn_start':
    case 'tool_execution_start':
    case 'tool_execution_end':
      if (s.inRun && (s.lastStatus !== 'working' || now - s.lastPostAt > DEBOUNCE_MS)) {
        status({ status: 'working' });
      }
      break;

    case 'message_end':
    case 'turn_end': {
      const m = ev.message;
      if (m && m.role === 'assistant') {
        if (m.stopReason) s.lastStopReason = m.stopReason;
        const text = assistantText(m.content);
        if (text.trim()) s.lastAssistantText = text;
        // Context tokens only once per turn: pi emits message_end AND turn_end
        // for the same assistant message, and the two accountings differ by a
        // few tokens, which showed up live as four metadata posts per reply.
        if (ev.type === 'turn_end') {
          const u = m.usage;
          const tokens = ev.contextTokens
            ?? (u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : undefined);
          if (tokens !== undefined && tokens > 0 && tokens !== s.contextTokens) {
            s.contextTokens = tokens;
            posts.push({ kind: 'meta', contextTokens: tokens });
          }
        }
      }
      break;
    }

    case 'after_provider_response':
      if (typeof ev.status === 'number') {
        if (isBrokerFailure(ev.status)) {
          s.brokerError = ev.status;
        } else if (ev.status < 400 && s.flagged) {
          s.flagged = false;
          posts.push({ kind: 'meta', rateLimited: null });
        }
      }
      break;

    case 'agent_end': {
      s.inRun = false;
      if (s.brokerError !== null || s.lastStopReason === 'error') {
        const code = s.brokerError ?? 0;
        const message = code ? agent.remedy(code) : `${agent.label}: the model request failed — check the pane`;
        s.flagged = true;
        status({
          status: 'waiting', waitingReason: 'user_input', notify: true, message,
          rateLimited: code ? agent.badge(code) : `${agent.label}: model error`,
        });
      } else if (s.lastStopReason !== 'aborted' && /\?\s*$/.test(s.lastAssistantText)) {
        status({
          status: 'waiting', waitingReason: 'user_input', notify: true,
          message: s.lastAssistantText.trim().slice(-200),
        });
      } else {
        status({ status: 'idle' });
      }
      break;
    }

    case 'session_shutdown':
      // Any shutdown ends the run (and with it the keepalive). quit = the
      // process is going away; reload/new/resume/fork keep the process and are
      // followed by a session_start, so report idle rather than not_running,
      // and only if the backend currently believes we are working.
      s.inRun = false;
      if (ev.reason === 'quit' || ev.reason === undefined) {
        status({ status: 'not_running' });
      } else if (s.lastStatus === 'working' || s.lastStatus === 'waiting') {
        status({ status: 'idle' });
      }
      break;

    default:
      break;
  }
  return { state: s, posts };
}

/** What the keepalive timer should post while a run is in flight. */
export function keepalivePost(state: State): Post | null {
  return state.inRun ? { kind: 'status', status: 'working' } : null;
}

/** argv for ~/.local/bin/termag-status. The mode is argv[0]; options follow. */
export function toArgv(post: Post): string[] {
  if (post.kind === 'meta') {
    const argv = ['meta', '--source', SOURCE];
    if (post.contextTokens !== undefined) argv.push('--context-tokens', post.contextTokens === null ? 'null' : String(post.contextTokens));
    if (post.rateLimited !== undefined) argv.push('--rate-limited', post.rateLimited === null ? 'null' : post.rateLimited);
    return argv;
  }
  const argv = [post.status, '--source', SOURCE];
  if (post.waitingReason) argv.push('--reason', post.waitingReason);
  if (post.notify) argv.push('--notify');
  if (post.message) argv.push('--message', post.message);
  if (post.rateLimited !== undefined) argv.push('--rate-limited', post.rateLimited === null ? 'null' : post.rateLimited);
  return argv;
}
