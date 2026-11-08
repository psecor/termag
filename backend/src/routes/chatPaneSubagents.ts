/**
 * A pane chat's subagents ("Subagents in a pane
 * chat"), behind chat-pane-subagents-enabled (404 `pane-subagents-off`):
 *
 *   GET /api/projects/:id/chat/pane-subagents?workstream=<ws>
 *   GET /api/projects/:id/chat/pane-subagents/:agentId?workstream=<ws>
 *   GET /api/projects/:id/chat/pane-sessions/:sessionId?workstream=<ws>
 *
 * A project made in Lab runs Claude Code in its agent pane, and the simple
 * UI's pane chat (ChatView.tsx) has no event stream to see its Agent-tool
 * subagents in. The box reads them from beside the pane Claude's session
 * (agent/pane-subagents.js, pane-subagents-v1): the list, and one
 * subagent's own transcript for the agent tab, and the transcript of a
 * Claude session running alongside the pane's in its directory (one in the
 * ctrl pane, an agent team's teammate), which the list names.
 *
 * The list never fails loudly: the pane chat polls it, and a box that is
 * away, an agent from before the RPC (it needs a restart or a newer image),
 * or an answer that doesn't parse is 200 `{ available: false, reason }`, so
 * the chat shows no subagents and nothing else changes. The transcript read
 * answers as GET …/chat/subagents/:agentId does (409 `runner-update`, 503
 * `box-away`, 404 `subagent-missing`), whose words the agent tab already has.
 *
 * Anyone who may read the session (its owner, or someone it is shared with,
 * who can open its pane anyway) may read them. Read only: nothing here writes
 * or wakes a box. The box's answer is re-validated before it is passed on.
 */
import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { boolVariation } from '../services/featureFlags';
import type { FlagUser } from '../services/featureFlags';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject, type ProjectHost } from '../services/agentRegistry';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { subagentIdOf } from '../services/chatRunner';

export const PANE_SUBAGENTS_FLAG = 'chat-pane-subagents-enabled';
export const PANE_SUBAGENTS_CAPABILITY = 'pane-subagents-v1';
const RPC_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;
/** As the agent caps them (agent/pane-subagents.js). */
const MAX_SUBAGENTS = 50;
const MAX_ALONGSIDE = 20;
const TEXT_MAX = 4001;

interface Result { status: number; body: unknown }

export interface PaneSubagent {
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  background: boolean;
  model: string | null;
  finished: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  prompt: string | null;
  report: string | null;
}

export interface PaneAlongside { sessionId: string; startedAt: number | null; updatedAt: string | null; title: string | null }

export type PaneSubagentsAnswer =
  | { available: true; running: boolean; session: { sessionId: string; startedAt: number | null } | null; subagents: PaneSubagent[]; alongside: PaneAlongside[] }
  | { available: false; reason: 'offline' | 'outdated-agent' | 'unreadable' };

const str = (v: unknown, max = 512): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const sessionIdOf = (v: unknown): string | null => (typeof v === 'string' && SESSION_ID_RE.test(v) ? v : null);

/** The box's list, re-validated; anything malformed reads as unreadable. Its cwd stays on the box. */
export function parsePaneSubagents(raw: unknown): PaneSubagentsAnswer {
  if (!raw || typeof raw !== 'object') return { available: false, reason: 'unreadable' };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.subagents)) return { available: false, reason: 'unreadable' };
  const s = o.session && typeof o.session === 'object' ? o.session as Record<string, unknown> : null;
  const sessionId = s ? sessionIdOf(s.sessionId) : null;
  const subagents: PaneSubagent[] = [];
  for (const a of o.subagents.slice(0, MAX_SUBAGENTS)) {
    if (!a || typeof a !== 'object') continue;
    const x = a as Record<string, unknown>;
    const agentId = subagentIdOf(x.agentId);
    if (!agentId) continue;
    subagents.push({
      agentId,
      toolUseId: str(x.toolUseId, 128),
      agentType: str(x.agentType, 128),
      description: str(x.description),
      background: x.background === true,
      model: str(x.model, 128),
      finished: x.finished === true,
      startedAt: iso(x.startedAt),
      updatedAt: iso(x.updatedAt),
      prompt: str(x.prompt, TEXT_MAX),
      report: str(x.report, TEXT_MAX),
    });
  }
  const alongside: PaneAlongside[] = [];
  for (const a of (Array.isArray(o.alongside) ? o.alongside : []).slice(0, MAX_ALONGSIDE)) {
    if (!a || typeof a !== 'object') continue;
    const x = a as Record<string, unknown>;
    const id = sessionIdOf(x.sessionId);
    if (!id) continue;
    alongside.push({ sessionId: id, startedAt: ms(x.startedAt), updatedAt: iso(x.updatedAt), title: str(x.title, 201) });
  }
  return {
    available: true,
    running: o.running === true,
    session: sessionId ? { sessionId, startedAt: ms(s!.startedAt) } : null,
    subagents: sessionId ? subagents : [],
    alongside: sessionId ? alongside : [],
  };
}

export interface PaneSubagentsDeps {
  enabled: (user: FlagUser) => Promise<boolean>;
  /** The agent pane's tmux session and its host, if the caller may read the session; a Result otherwise. */
  find: (userId: string, projectId: string, workstream: string) => Promise<{ host: ProjectHost; session: string } | Result>;
  connected: (host: ProjectHost) => boolean;
  capabilities: (host: ProjectHost) => string[];
  send: (host: ProjectHost, type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
}

const defaultDeps: PaneSubagentsDeps = {
  enabled: user => boolVariation(PANE_SUBAGENTS_FLAG, user, false),
  async find(userId, projectId, workstream) {
    try {
      const access = (await projectSessionAccess(userId, projectId))('agent', workstream);
      return { host: access.host, session: access.session };
    } catch (err) {
      if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
      throw err;
    }
  },
  connected: host => isProjectAgentConnected(host),
  capabilities: host => projectAgentCapabilities(host),
  send: (host, type, payload, timeoutMs) => sendForProject(host, type, payload, timeoutMs),
};

const OFF: Result = { status: 404, body: { error: 'Not found', code: 'pane-subagents-off' } };
const isResult = (v: unknown): v is Result => Boolean(v && typeof v === 'object' && 'status' in v && 'body' in v);
const workstreamOf = (q: Request['query']) => (typeof q.workstream === 'string' && q.workstream ? q.workstream : 'main');

export function paneSubagentsHandlers(deps: PaneSubagentsDeps = defaultDeps) {
  return {
    async list(userId: string, projectId: string, query: Request['query'], user?: FlagUser): Promise<Result> {
      if (!user || !await deps.enabled(user).catch(() => false)) return OFF;
      const found = await deps.find(userId, projectId, workstreamOf(query));
      if (isResult(found)) return found;
      if (!deps.connected(found.host)) return { status: 200, body: { available: false, reason: 'offline' } };
      if (!deps.capabilities(found.host).includes(PANE_SUBAGENTS_CAPABILITY)) return { status: 200, body: { available: false, reason: 'outdated-agent' } };
      try {
        return { status: 200, body: parsePaneSubagents(await deps.send(found.host, 'pane-subagents', { session: found.session }, RPC_TIMEOUT_MS)) };
      } catch (err) {
        console.warn(`[PANE-SUBAGENTS] ${found.session}: ${err instanceof Error ? err.message : String(err)}`);
        return { status: 200, body: { available: false, reason: 'unreadable' } };
      }
    },

    async read(userId: string, projectId: string, agentIdRaw: unknown, query: Request['query'], user?: FlagUser): Promise<Result> {
      if (!user || !await deps.enabled(user).catch(() => false)) return OFF;
      const agentId = subagentIdOf(agentIdRaw);
      if (!agentId) return { status: 400, body: { error: 'agentId must be a subagent id' } };
      const found = await deps.find(userId, projectId, workstreamOf(query));
      if (isResult(found)) return found;
      if (!deps.connected(found.host)) return { status: 503, body: { error: "The session's box isn't connected", code: 'box-away' } };
      if (!deps.capabilities(found.host).includes(PANE_SUBAGENTS_CAPABILITY)) {
        return { status: 409, body: { error: "This box's agent needs an update before it can show a subagent's work", code: 'runner-update' } };
      }
      try {
        const r = await deps.send(found.host, 'pane-subagent-read', { session: found.session, agentId }, READ_TIMEOUT_MS) as { found?: boolean; entries?: unknown[] } | null;
        if (!r?.found) return { status: 404, body: { error: 'The box has no transcript for that subagent', code: 'subagent-missing' } };
        return { status: 200, body: { agentId, entries: Array.isArray(r.entries) ? r.entries : [] } };
      } catch (err) {
        if (/not connected/i.test(err instanceof Error ? err.message : String(err))) return { status: 503, body: { error: "The session's box isn't connected", code: 'box-away' } };
        return { status: 502, body: { error: `The box couldn't read it: ${err instanceof Error ? err.message : String(err)}` } };
      }
    },

    /** A session running alongside the pane's: its own transcript, from the pane Claude's directory only (agent pane-session-read). */
    async session(userId: string, projectId: string, sessionIdRaw: unknown, query: Request['query'], user?: FlagUser): Promise<Result> {
      if (!user || !await deps.enabled(user).catch(() => false)) return OFF;
      const sessionId = sessionIdOf(sessionIdRaw);
      if (!sessionId) return { status: 400, body: { error: 'sessionId must be a Claude session id' } };
      const found = await deps.find(userId, projectId, workstreamOf(query));
      if (isResult(found)) return found;
      if (!deps.connected(found.host)) return { status: 503, body: { error: "The session's box isn't connected", code: 'box-away' } };
      if (!deps.capabilities(found.host).includes(PANE_SUBAGENTS_CAPABILITY)) {
        return { status: 409, body: { error: "This box's agent needs an update before it can show that session", code: 'runner-update' } };
      }
      try {
        const r = await deps.send(found.host, 'pane-session-read', { session: found.session, sessionId }, READ_TIMEOUT_MS) as { found?: boolean; entries?: unknown[] } | null;
        if (!r?.found) return { status: 404, body: { error: 'The box has no transcript for that session in this directory', code: 'session-missing' } };
        return { status: 200, body: { sessionId, entries: Array.isArray(r.entries) ? r.entries : [] } };
      } catch (err) {
        if (/not connected/i.test(err instanceof Error ? err.message : String(err))) return { status: 503, body: { error: "The session's box isn't connected", code: 'box-away' } };
        return { status: 502, body: { error: `The box couldn't read it: ${err instanceof Error ? err.message : String(err)}` } };
      }
    },
  };
}

export function chatPaneSubagentsRouter(deps: PaneSubagentsDeps = defaultDeps): Router {
  const router = Router();
  const h = paneSubagentsHandlers(deps);
  router.get('/:id/chat/pane-subagents', requireAuth, asyncHandler(async (req, res) => {
    const r = await h.list(req.user!.id, req.params.id, req.query, req.user!);
    res.status(r.status).json(r.body);
  }));
  router.get('/:id/chat/pane-subagents/:agentId', requireAuth, asyncHandler(async (req, res) => {
    const r = await h.read(req.user!.id, req.params.id, req.params.agentId, req.query, req.user!);
    res.status(r.status).json(r.body);
  }));
  router.get('/:id/chat/pane-sessions/:sessionId', requireAuth, asyncHandler(async (req, res) => {
    const r = await h.session(req.user!.id, req.params.id, req.params.sessionId, req.query, req.user!);
    res.status(r.status).json(r.body);
  }));
  return router;
}
