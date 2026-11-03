/**
 * Who may touch which tmux session — the single shared authorization helper.
 *
 * Every non-browser surface that observes or drives a project's sessions (the
 * capture route, MetaTerm's list / send-keys routes) goes through
 * assertSessionAccess(). It encodes the two rules the terminal WS handler
 * (index.ts) and the capture route each established on their own:
 *
 *   1. owner-OR-ProjectShare — the requester owns the project or holds a share.
 *   2. allowlist-by-reconstruction — never accept a session name as an opaque
 *      target. The caller names (project, role, workstream); we REBUILD the one
 *      legal session name with sessionName() and route only to that.
 *
 * Permission lives HERE, server-side — never in a client like the MetaTerm MCP
 * server. A tmux-resident model has a shell and can be argued out of its own
 * checks; a 404 from the backend cannot. Denials are 404 (no existence leak),
 * matching the capture route.
 */
import { prisma } from '../db';
import { MAX_REVIEW_SLOTS, reviewSessionName, reviewSessionNames, sessionName } from './tmux';
import type { ProjectHost } from './agentRegistry';

// `review` is the PR-review pane the UI's Review button starts next to the
// ctrl pane (routes/review.ts). It exists only while a review runs, and a
// workstream has up to MAX_REVIEW_SLOTS of them:
// the role's own name is slot 1, `<it>-<n>` the rest.
export const SESSION_ROLES = ['agent', 'ctrl', 'data', 'data-ctrl', 'review'] as const;
export type SessionRole = typeof SESSION_ROLES[number];

export function isSessionRole(x: unknown): x is SessionRole {
  return typeof x === 'string' && (SESSION_ROLES as readonly string[]).includes(x);
}

/** Pure: every legal session name for a project (all workstreams × roles). */
export function legalSessions(owner: string, projectName: string, workstreams: string[]): string[] {
  const wsList = workstreams.length ? workstreams : ['main'];
  const out: string[] = [];
  for (const ws of wsList) {
    for (const role of SESSION_ROLES) out.push(sessionName(owner, projectName, role, ws));
    out.push(...reviewSessionNames(owner, projectName, ws).slice(1));
  }
  return out;
}

/**
 * Pure: is a project's host the one the caller's agent token belongs to?
 * `agentInstanceId` is undefined for a browser session (no host) and null for a
 * per-user token, whose host is the one box-less (instanceId null) projects run on.
 */
export function isOnCallerHost(projectInstanceId: string | null, agentInstanceId: string | null | undefined): boolean {
  return agentInstanceId !== undefined && projectInstanceId === agentInstanceId;
}

export class SessionAccessError extends Error {
  constructor(public readonly status: 400 | 404, message: string) {
    super(message);
    this.name = 'SessionAccessError';
  }
}

export interface SessionAccess {
  host: ProjectHost;
  session: string;
  role: SessionRole;
  workstream: string;
  /** The review pane's slot (1..MAX_REVIEW_SLOTS) for role `review`; null for every other role. */
  slot: number | null;
  isOwner: boolean;
  project: { id: string; name: string; userId: string; instanceId: string | null; ownerUsername: string; setupStatus: string };
}

export async function assertSessionAccess(
  requesterId: string,
  projectId: string,
  role: string,
  workstream: string = 'main',
  slot?: number,
): Promise<SessionAccess> {
  // Role first, so a bad role is a 400 without touching the database.
  if (!isSessionRole(role)) {
    throw new SessionAccessError(400, `role must be one of: ${SESSION_ROLES.join(', ')}`);
  }
  return (await projectSessionAccess(requesterId, projectId))(role, workstream, slot);
}

/** Pure: a review slot as a request gave it, or an error. Absent is slot 1, today's one pane. */
export function parseReviewSlot(raw: unknown): { ok: true; slot: number } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, slot: 1 };
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_REVIEW_SLOTS) {
    return { ok: false, error: `slot must be 1 to ${MAX_REVIEW_SLOTS}` };
  }
  return { ok: true, slot: n };
}

/**
 * The project half of assertSessionAccess: owner-or-share, checked once.
 * Resolves to a function that applies the session half (role and workstream
 * allowlist, rebuilt session name) per pane, so a caller touching many panes
 * of one project (pane search) does the database lookups once. Throws the
 * same 404s; the returned function throws the same 400 / 404s.
 */
export async function projectSessionAccess(
  requesterId: string,
  projectId: string,
): Promise<(role: string, workstream?: string, slot?: number) => SessionAccess> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      user: { select: { id: true, unixUsername: true } },
      workstreams: { where: { archived: false }, select: { name: true } },
    },
  });
  if (!project || project.archived) throw new SessionAccessError(404, 'Project not found');

  const isOwner = project.userId === requesterId;
  if (!isOwner) {
    const share = await prisma.projectShare.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: requesterId } },
    });
    if (!share) throw new SessionAccessError(404, 'Project not found');
  }

  const known = project.workstreams.length ? project.workstreams.map(w => w.name) : ['main'];
  return (role: string, workstream: string = 'main', slot?: number): SessionAccess => {
    if (!isSessionRole(role)) {
      throw new SessionAccessError(400, `role must be one of: ${SESSION_ROLES.join(', ')}`);
    }
    if (slot !== undefined && (role !== 'review' || !parseReviewSlot(slot).ok)) {
      throw new SessionAccessError(400, `slot must be 1 to ${MAX_REVIEW_SLOTS}, and only for the review role`);
    }
    if (!known.includes(workstream)) throw new SessionAccessError(404, 'Workstream not found');
    const reviewSlot = role === 'review' ? (slot ?? 1) : null;
    return {
      host: { userId: project.userId, instanceId: project.instanceId },
      session: reviewSlot !== null
        ? reviewSessionName(project.user.unixUsername, project.name, workstream, reviewSlot)
        : sessionName(project.user.unixUsername, project.name, role, workstream),
      role,
      workstream,
      slot: reviewSlot,
      isOwner,
      project: {
        id: project.id, name: project.name, userId: project.userId,
        instanceId: project.instanceId, ownerUsername: project.user.unixUsername,
        setupStatus: project.setupStatus,
      },
    };
  };
}

/** Why the terminal socket refused an attach: its close reason, which the TUI treats as final. */
export type TerminalRefusal = 'session forbidden' | 'session/project mismatch';

/**
 * The terminal socket's check (index.ts): the caller may reach the project,
 * and `session` is one of the names rebuilt for one of its roles in a
 * workstream it has. The session string comes from the client, so it is only
 * compared, never parsed or passed on unchecked: tmux reads `-t` as an exact
 * name, then a prefix, then an fnmatch pattern, and `alice-myproj-secret?ctrl`
 * attaches alice-myproj-secret-ctrl. The workstream is checked too, because
 * `myproj` + workstream `secret` builds the same name as project
 * `myproj-secret`.
 */
export async function terminalSessionAccess(
  requesterId: string,
  projectId: string,
  session: string,
  workstream: string = 'main',
): Promise<SessionAccess | { refusal: TerminalRefusal }> {
  let forPane: Awaited<ReturnType<typeof projectSessionAccess>>;
  try {
    forPane = await projectSessionAccess(requesterId, projectId);
  } catch (err) {
    if (err instanceof SessionAccessError) return { refusal: 'session forbidden' };
    throw err;
  }
  try {
    // Every review slot is a pane of its own.
    const slots = Array.from({ length: MAX_REVIEW_SLOTS - 1 }, (_, i) => forPane('review', workstream, i + 2));
    return [...SESSION_ROLES.map(role => forPane(role, workstream)), ...slots].find(a => a.session === session)
      ?? { refusal: 'session/project mismatch' };
  } catch (err) {
    // A workstream the project does not have.
    if (err instanceof SessionAccessError) return { refusal: 'session/project mismatch' };
    throw err;
  }
}
