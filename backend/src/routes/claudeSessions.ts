/**
 * /api/claude-sessions — an owner's Claude Code cloud sessions on their boxes
 *. Owner only: every
 * query is scoped by the signed-in user, and nothing here is shared with
 * project collaborators. The admin counterpart (no titles) is a later PR.
 *
 *   GET  /?state=active|recent&days=N   sessions grouped from their runs and
 *        events (services/claudeSessions.ts); `active` is queued, starting and
 *        running, `recent` is ended and lost within `days` (default 30, max 90)
 *   GET  /:key/events                    the session's events, newest first
 *   GET  /:key/runner-log?lines=N        the tail of the current run's runner
 *        log on the box, through the agent, redacted; 404 without a log,
 *        503 while the box's agent is away
 *   PATCH /:key/title { title }          rename: the owner's title on every run of
 *        the session (first line, 120 chars); null or empty clears it. The
 *        "Claude Cloud N" name is fixed; this is the part after it
 *   POST /:key/end                       kill the current run's tmux session by
 *        exact name: the runner releases the session, which parks on claude.ai
 *        and stays resumable; 409 when no run is live
 *
 * `:key` is the Anthropic session id, or `order:<id>` for a run recorded
 * before session ids were kept.
 */
import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { asyncHandler } from '../middleware/errors';
import { requireAuth } from '../middleware/auth';
import { isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { isOrderId } from '../services/claudeRunnerSpawn';
import { isSessionId, titleFromPrompt } from '../services/claudeRunnerSessions';
import { recordSessionEvent } from '../services/claudeSessionEvents';
import { ACTIVE_STATES, listCloudSessions, listSessionEvents, renameCloudSession, type CloudSessionView } from '../services/claudeSessions';

const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;

/** `:key` is a session id or `order:<order id>`; anything else is 404. */
export function parseSessionKey(raw: string): string | null {
  if (raw.startsWith('order:')) return isOrderId(raw.slice('order:'.length)) ? raw : null;
  return isSessionId(raw) ? raw : null;
}

function daysParam(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

/**
 * Credentials that could appear in a runner log line, masked before the tail
 * leaves the backend: the same shapes deploy/termag-otelcol.yaml masks before
 * the journal leaves the host.
 */
export function redactLog(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, 'REDACTED_JWT')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'REDACTED_ANTHROPIC_KEY')
    .replace(/tmag_[A-Za-z0-9_-]+/g, 'tmag_REDACTED')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, 'REDACTED_GITHUB_TOKEN')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 REDACTED')
    .replace(/([?&;](?:token|access_token|id_token|refresh_token|code|state|key|api_key|apikey|secret|client_secret|password|passwd|sig|signature)=)[^&\s"']+/gi, '$1REDACTED');
}

export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export function claudeSessionsRouter(): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    const state = req.query.state === 'recent' ? 'recent' : 'active';
    const days = daysParam(req.query.days);
    const all = await listCloudSessions(req.user!.id, { days });
    const sessions = all.filter(s => (state === 'active') === ACTIVE_STATES.has(s.state));
    res.json({ state, days, sessions, generatedAt: new Date().toISOString() });
  };

  async function ownedSession(userId: string, rawKey: string): Promise<CloudSessionView | null> {
    const key = parseSessionKey(rawKey);
    if (!key) return null;
    const all = await listCloudSessions(userId, { days: MAX_DAYS });
    return all.find(s => s.key === key) ?? null;
  }

  const events: RequestHandler = async (req, res) => {
    const key = parseSessionKey(req.params.key);
    if (!key) { res.status(404).json({ error: 'no such session' }); return; }
    const rows = await listSessionEvents(req.user!.id, key);
    if (rows.length === 0) {
      const owned = await ownedSession(req.user!.id, key);
      if (!owned) { res.status(404).json({ error: 'no such session' }); return; }
    }
    res.json({ key, events: rows.map(e => ({ ...e, at: e.at.toISOString() })) });
  };

  const runnerLog: RequestHandler = async (req, res) => {
    const session = await ownedSession(req.user!.id, req.params.key);
    if (!session?.current) { res.status(404).json({ error: 'no such session, or it never ran' }); return; }
    const run = session.current;
    if (!isInstanceAgentConnected(run.instanceId)) { res.status(503).json({ error: 'the box is not connected' }); return; }
    const box = await prisma.instance.findFirst({ where: { id: run.instanceId, userId: req.user!.id }, select: { hostHome: true } });
    if (!box?.hostHome) { res.status(404).json({ error: 'the box has no known home directory' }); return; }
    const requested = Number(req.query.lines);
    const lines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LOG_LINES) : DEFAULT_LOG_LINES;
    const path = `${box.hostHome.replace(/\/+$/, '')}/.termag/claude-runner/${run.orderId}.log`;
    let reply: { ok?: boolean; content?: string | null };
    try {
      reply = await sendToInstanceAgent(run.instanceId, 'read-file', { path }, 10000);
    } catch (err) {
      res.status(502).json({ error: `the box agent did not answer: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (typeof reply?.content !== 'string') { res.status(404).json({ error: 'no runner log for this run on the box' }); return; }
    res.json({ key: session.key, orderId: run.orderId, lines, log: redactLog(tailLines(reply.content, lines)) });
  };

  const end: RequestHandler = async (req, res) => {
    const session = await ownedSession(req.user!.id, req.params.key);
    if (!session) { res.status(404).json({ error: 'no such session' }); return; }
    const run = session.current;
    if (!run || run.endedAt || run.alive !== true || !run.sessionName) {
      res.status(409).json({ error: 'no live run to end', state: session.state });
      return;
    }
    try {
      await sendToInstanceAgent(run.instanceId, 'tmux-kill', { sessionName: run.sessionName, exact: true }, 10000);
    } catch (err) {
      res.status(502).json({ error: `the box agent did not answer: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    console.log(`[CLAUDE-RUNNER] order ${run.orderId} for ${req.user!.unixUsername}: end requested from the UI (${run.boxName} slot ${run.slot})`);
    if (session.sessionId) {
      await recordSessionEvent({
        owner: { id: req.user!.id, unixUsername: req.user!.unixUsername }, sessionId: session.sessionId, orderId: run.orderId,
        instanceId: run.instanceId, kind: 'end-requested', detail: 'from the termag UI',
      });
    }
    res.status(202).json({ ok: true, key: session.key, orderId: run.orderId });
  };

  const rename: RequestHandler = async (req, res) => {
    const key = parseSessionKey(req.params.key);
    if (!key) { res.status(404).json({ error: 'no such session' }); return; }
    const raw = (req.body as { title?: unknown } | undefined)?.title;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') { res.status(400).json({ error: 'title must be a string or null' }); return; }
    const title = typeof raw === 'string' ? titleFromPrompt(raw) : null;
    if (typeof raw === 'string' && raw.trim() && !title) { res.status(400).json({ error: 'title is empty after trimming' }); return; }
    const touched = await renameCloudSession(req.user!.id, key, title);
    if (touched === 0) { res.status(404).json({ error: 'no such session, or it has no run to carry a title' }); return; }
    const session = await ownedSession(req.user!.id, key);
    if (session?.sessionId && session.current) {
      // The event carries no text: a rename is an action, the title is on the row.
      await recordSessionEvent({ owner: { id: req.user!.id, unixUsername: req.user!.unixUsername }, sessionId: session.sessionId, orderId: session.current.orderId, instanceId: session.current.instanceId, kind: 'renamed' });
    }
    res.json({ ok: true, key, title, name: session?.name ?? null });
  };

  router.get('/', requireAuth, asyncHandler(list));
  router.patch('/:key/title', requireAuth, asyncHandler(rename));
  router.get('/:key/events', requireAuth, asyncHandler(events));
  router.get('/:key/runner-log', requireAuth, asyncHandler(runnerLog));
  router.post('/:key/end', requireAuth, asyncHandler(end));
  return router;
}
