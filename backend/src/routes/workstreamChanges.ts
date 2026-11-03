// GET /api/projects/:projectId/workstreams/:workstream/changes?branch=<the session's PR head>
//
// A session's in-flight changes, for the simple UI's context card:
// the box's
// `git-changes` answer (agent/git-changes.js) for the workstream's checkout,
// or, given the session's PR branch, for the repository's worktree on it.
// Behind simple-ui-inflight-changes-enabled, read for the caller.
//
// The project's owner, or a user it is shared with; the box is the owner's.
// It never wakes a box: one that is down, or an agent without git-changes-v1,
// answers 200 `{ available: false, reason }`, and the card shows its PR's files
// alone. The box's answer is re-validated here before it is passed on.

import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { prisma } from '../db';
import { boolVariation } from '../services/featureFlags';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject, type ProjectHost } from '../services/agentRegistry';
import { projectDirFor } from '../services/tmux';

export const GIT_CHANGES_CAPABILITY = 'git-changes-v1';
const RPC_TIMEOUT_MS = 10_000;
/** As the agent caps each list (agent/git-changes.js MAX_FILES). */
const MAX_FILES = 200;
const STATUSES = new Set(['A', 'C', 'D', 'M', 'R', 'T', 'U', 'X', '?']);

export interface ChangedFile {
  path: string;
  from?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export type ChangesAnswer =
  | {
    available: true;
    branch: string | null;
    upstream: string | null;
    /** What `committed` counts from: the upstream, origin's default branch, or null. */
    against: string | null;
    commits: number;
    committed: ChangedFile[];
    uncommitted: ChangedFile[];
    truncated: boolean;
    /** The committed files couldn't be read (agent git-changes.js): `committed` is empty though `commits` may not be. */
    partial: boolean;
    /** The worktree read instead of the workstream's checkout, relative to it (`.worktrees/topic`); null when it is the checkout. */
    worktree: string | null;
  }
  | { available: false; reason: 'offline' | 'outdated-agent' | 'unreadable' };

const str = (v: unknown, max = 4096): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : null);
const count = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);

function files(v: unknown): ChangedFile[] {
  if (!Array.isArray(v)) return [];
  const out: ChangedFile[] = [];
  for (const f of v.slice(0, MAX_FILES)) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const path = str(o.path);
    const status = typeof o.status === 'string' && STATUSES.has(o.status) ? o.status : null;
    if (!path || !status) continue;
    const from = str(o.from);
    out.push({ path, ...(from ? { from } : {}), status, additions: count(o.additions), deletions: count(o.deletions) });
  }
  return out;
}

/** A worktree's place under the workstream's checkout (`.worktrees/topic`), or null when it is elsewhere or the checkout itself. */
export function worktreeUnder(dir: string, toplevel: unknown): string | null {
  const top = str(toplevel);
  const base = dir.replace(/\/+$/, '');
  if (!top || !top.startsWith(`${base}/`)) return null;
  const rel = top.slice(base.length + 1);
  return rel.split('/').some(seg => seg === '' || seg === '.' || seg === '..') ? null : rel;
}

/** The box's answer, re-validated; anything malformed reads as unreadable. */
export function parseChanges(raw: unknown, dir: string): ChangesAnswer {
  if (!raw || typeof raw !== 'object') return { available: false, reason: 'unreadable' };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.uncommitted) || !Array.isArray(o.committed)) return { available: false, reason: 'unreadable' };
  return {
    available: true,
    branch: str(o.branch, 255),
    upstream: str(o.upstream, 255),
    against: str(o.against, 255),
    commits: count(o.commits) ?? 0,
    committed: files(o.committed),
    uncommitted: files(o.uncommitted),
    truncated: o.truncated === true,
    partial: o.partial === true,
    worktree: o.worktree === true ? worktreeUnder(dir, o.toplevel) : null,
  };
}

/** A branch name worth passing to the box, which only compares it: anything else is dropped. */
export function branchParam(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9._/-]{1,255}$/.test(v) && !v.startsWith('-') && !v.includes('..') ? v : null;
}

export interface WorkstreamChangesDeps {
  enabled: (userId: string) => Promise<boolean>;
  /** The project, if the caller owns it or it is shared with them, with the workstream's checkout; null otherwise. */
  find: (userId: string, projectId: string, workstream: string) => Promise<{ host: ProjectHost; dir: string } | null>;
  connected: (host: ProjectHost) => boolean;
  capabilities: (host: ProjectHost) => string[];
  send: (host: ProjectHost, type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
}

const defaultDeps: WorkstreamChangesDeps = {
  async enabled(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    return user ? boolVariation('simple-ui-inflight-changes-enabled', user, false) : false;
  },
  async find(userId, projectId, workstream) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        user: { select: { unixUsername: true } },
        instance: { select: { hostHome: true } },
        workstreams: { where: { archived: false }, select: { name: true } },
      },
    });
    if (!project || project.archived) return null;
    if (project.userId !== userId) {
      const share = await prisma.projectShare.findUnique({ where: { projectId_userId: { projectId, userId } } });
      if (!share) return null;
    }
    const known = project.workstreams.length ? project.workstreams.map(w => w.name) : ['main'];
    if (!known.includes(workstream)) return null;
    return { host: { userId: project.userId, instanceId: project.instanceId }, dir: projectDirFor(project, workstream) };
  },
  connected: host => isProjectAgentConnected(host),
  capabilities: host => projectAgentCapabilities(host),
  send: (host, type, payload, timeoutMs) => sendForProject(host, type, payload, timeoutMs),
};

export function workstreamChangesRouter(deps: WorkstreamChangesDeps = defaultDeps): Router {
  const router = Router();

  const changes: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    if (!await deps.enabled(userId).catch(() => false)) { res.status(404).json({ error: 'Not found' }); return; }
    const found = await deps.find(userId, req.params.projectId, req.params.workstream);
    if (!found) { res.status(404).json({ error: 'Project not found' }); return; }
    const answer = await read(found, branchParam(req.query.branch));
    res.json(answer);
  };

  async function read(found: { host: ProjectHost; dir: string }, branch: string | null): Promise<ChangesAnswer> {
    if (!deps.connected(found.host)) return { available: false, reason: 'offline' };
    if (!deps.capabilities(found.host).includes(GIT_CHANGES_CAPABILITY)) return { available: false, reason: 'outdated-agent' };
    try {
      const raw = await deps.send(found.host, 'git-changes', { cwd: found.dir, ...(branch ? { branch } : {}) }, RPC_TIMEOUT_MS);
      return parseChanges(raw, found.dir);
    } catch (err) {
      console.warn(`[CHANGES] ${found.dir}: ${err instanceof Error ? err.message : String(err)}`);
      return { available: false, reason: 'unreadable' };
    }
  }

  router.get('/projects/:projectId/workstreams/:workstream/changes', requireAuth, asyncHandler(changes));
  return router;
}
