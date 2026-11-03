/**
 * GET /api/projects/:id/sessions/:role/history — the tail of a session's
 * pane output log (agent RPC `pane-history-read`, agent/pane-history.js),
 * for the phone's "Load earlier". Agent panes run their TUI on tmux's
 * alternate screen, which keeps no scrollback, so no capture can reach the
 * pane's past; the agent's pipe-pane log is that past. Same access gate as
 * capture, and read on demand (a tap) — never polled — with the same 1/s
 * per-caller-and-session shape as capture's budget.
 */
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';

const HISTORY_MIN_INTERVAL_MS = 1000;
const MAX_BYTES = 256 * 1024;
const DEFAULT_BYTES = 64 * 1024;

const historyRateLimits = new Map<string, number>();

function clampBytes(value: unknown, fallback: number): number {
  const n = parseInt(value as string, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_BYTES, n));
}

export async function historyFor(
  userId: string, projectId: string, role: string, query: Record<string, unknown>,
  /** Who is asking, for the rate-limit key: a bearer token's box id, 'cli', or 'browser'. */
  callerId: string = 'browser',
): Promise<{ status: number; body: unknown }> {
  const maxBytes = clampBytes(query.maxBytes, DEFAULT_BYTES);
  const beforeRaw = parseInt(query.before as string, 10);
  const beforeBytes = Number.isFinite(beforeRaw) ? beforeRaw : undefined;
  const workstream = typeof query.workstream === 'string' && query.workstream ? query.workstream : 'main';

  let access;
  try {
    access = await assertSessionAccess(userId, projectId, role, workstream);
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  const sessionName = access.session;

  const rateKey = `${userId}:${callerId}:${sessionName}`;
  const now = Date.now();
  const last = historyRateLimits.get(rateKey) ?? 0;
  if (now - last < HISTORY_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: 'Rate limited (max 1 history read/sec per caller and session)' } };
  }
  historyRateLimits.set(rateKey, now);

  if (!isProjectAgentConnected(access.host)) {
    return { status: 503, body: { error: "Owner's agent is offline" } };
  }

  try {
    const result = await sendForProject(access.host, 'pane-history-read', { sessionName, beforeBytes, maxBytes }, 8000);
    return {
      status: 200,
      body: {
        session: sessionName,
        content: typeof result.content === 'string' ? result.content : '',
        startByte: result.startByte ?? 0,
        endByte: result.endByte ?? 0,
        totalBytes: result.totalBytes ?? 0,
      },
    };
  } catch (err) {
    const message = (err as Error).message;
    // An agent from before the RPC (agent.js `default:` case).
    if (message.startsWith('Unknown command: pane-history-read')) {
      return { status: 501, body: { error: 'This box needs an update for earlier pane history' } };
    }
    if (message.startsWith('no pane history')) {
      return { status: 404, body: { error: 'No pane history recorded for this session' } };
    }
    return { status: 503, body: { error: `history failed: ${message}` } };
  }
}

