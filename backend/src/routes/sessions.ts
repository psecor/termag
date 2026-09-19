import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { sendForProject, isProjectAgentConnected, type ProjectHost } from '../services/agentRegistry';
import { assertSessionAccess, SessionAccessError, SESSION_ROLES } from '../services/sessionAccess';
import { sessionName } from '../services/tmux';
import { getAllStatuses } from '../services/status';
import { providerForSource } from '../providers/registry';

// Permissioned, token-friendly session surface for non-browser callers — built
// for the MetaTerm MCP server, usable by anything holding a Bearer agent token.
// Everything goes through assertSessionAccess (owner-OR-share + rebuild the
// legal session name) and is routed to the OWNER's per-user agent via
// sendForProject, because tmux is per-unix-user and the backend can't touch
// another user's sessions in-process.

const SEND_MIN_INTERVAL_MS = 500;
const sendRateLimits = new Map<string, number>();

export function sessionsRouter(): Router {
  const router = Router();

  // GET /api/sessions — every session the caller may reach: own + shared
  // projects × live workstreams × roles, with agent connectivity, tmux
  // liveness (one tmux-list per distinct host) and the current status.
  const list: RequestHandler = async (req, res) => {
    const requesterId = req.user!.id;
    const include = {
      user: { select: { unixUsername: true } },
      workstreams: { where: { archived: false }, select: { name: true } },
      // Fallback provider for rows whose status carries no `source` (hook-driven
      // Claude sends none) — the project's agent workflow says what runs there.
      workflows: { where: { type: 'agent' as const }, select: { provider: true } },
    };
    const owned = await prisma.project.findMany({ where: { userId: requesterId, archived: false }, include });
    const shares = await prisma.projectShare.findMany({
      where: { userId: requesterId },
      include: { project: { include } },
    });
    const projects = [
      ...owned.map(p => ({ p, access: 'owner' as const })),
      ...shares.filter(s => !s.project.archived).map(s => ({ p: s.project, access: 'collaborator' as const })),
    ];

    const liveByHost = new Map<string, Set<string> | null>();
    async function liveSet(host: ProjectHost): Promise<Set<string> | null> {
      const key = `${host.userId}:${host.instanceId ?? ''}`;
      if (liveByHost.has(key)) return liveByHost.get(key)!;
      let set: Set<string> | null = null;
      if (isProjectAgentConnected(host)) {
        try {
          const r = await sendForProject(host, 'tmux-list', {}, 5000);
          set = new Set<string>(Array.isArray(r?.sessions) ? r.sessions : []);
        } catch { set = null; }
      }
      liveByHost.set(key, set);
      return set;
    }

    // Read the raw map, not getStatus(): that helper fabricates a
    // `not_running` entry stamped `updatedAt: now` for unknown sessions, which
    // would make every never-seen session look freshly updated.
    const statuses = getAllStatuses();
    const out: Array<Record<string, unknown>> = [];
    for (const { p, access } of projects) {
      const host: ProjectHost = { userId: p.userId, instanceId: p.instanceId };
      const connected = isProjectAgentConnected(host);
      const live = await liveSet(host);
      const wsNames = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
      for (const ws of wsNames) {
        for (const role of SESSION_ROLES) {
          const session = sessionName(p.user.unixUsername, p.name, role, ws);
          const alive = live ? live.has(session) : false;
          // agent/ctrl exist for every project; data roles only if actually live.
          if ((role === 'data' || role === 'data-ctrl') && !alive) continue;
          const raw = statuses.get(session);
          out.push({
            projectId: p.id, projectName: p.name, owner: p.user.unixUsername, access,
            workstream: ws, role, session, instanceId: p.instanceId,
            connected, alive, status: raw?.status ?? 'not_running', contextTokens: raw?.contextTokens ?? null,
            // Triage fields (additive). updatedAt is the last status WRITE — metadata
            // pushes (context tokens, rate-limit gauge) bump it too, so "waiting since"
            // derived from it is a lower bound. null = no status ever recorded.
            updatedAt: raw ? raw.updatedAt.toISOString() : null,
            waitingReason: raw?.waitingReason ?? null,
            rateLimited: raw?.rateLimited ?? null,
            provider: (raw?.source ? providerForSource(raw.source) : undefined) ?? p.workflows[0]?.provider ?? null,
            lastActiveAt: p.lastActiveAt.toISOString(),
          });
        }
      }
    }
    res.json(out);
  };

  // POST /api/projects/:id/sessions/:role/send-keys { workstream?, keys, enter?, literal? }
  // The missing "drive" primitive. Same guard + failure modes as capture.
  const sendKeys: RequestHandler = async (req, res) => {
    const { workstream, keys, enter, literal } = req.body as {
      workstream?: string; keys?: string; enter?: boolean; literal?: boolean;
    };
    if (typeof keys !== 'string' || keys.length === 0) {
      res.status(400).json({ error: 'keys (non-empty string) required' });
      return;
    }
    if (keys.length > 4000) {
      res.status(400).json({ error: 'keys too long (max 4000 chars)' });
      return;
    }
    let access;
    try {
      access = await assertSessionAccess(req.user!.id, req.params.id, req.params.role, workstream || 'main');
    } catch (err) {
      if (err instanceof SessionAccessError) { res.status(err.status).json({ error: err.message }); return; }
      throw err;
    }
    if (!isProjectAgentConnected(access.host)) {
      res.status(503).json({ error: "Owner's agent is offline" });
      return;
    }
    const rateKey = `${req.user!.id}:${access.session}`;
    const now = Date.now();
    if (now - (sendRateLimits.get(rateKey) ?? 0) < SEND_MIN_INTERVAL_MS) {
      res.status(429).json({ error: 'Rate limited (max 2 sends/sec per session)' });
      return;
    }
    sendRateLimits.set(rateKey, now);
    try {
      // literal (default true): type `keys` verbatim. literal:false sends tmux
      // KEY NAMES (C-c, Escape, Up…) — deliberate control-tower use only. Old
      // agents ignore the flag and keep their historical key-name behavior.
      await sendForProject(access.host, 'tmux-send-keys', {
        sessionName: access.session, keys, withEnter: enter !== false, literal: literal !== false,
      });
      res.json({ ok: true, session: access.session });
    } catch (err) {
      res.status(503).json({ error: `send-keys failed: ${(err as Error).message}` });
    }
  };

  router.get('/sessions', requireAuthOrAgentToken, list);
  router.post('/projects/:id/sessions/:role/send-keys', requireAuthOrAgentToken, sendKeys);
  return router;
}
