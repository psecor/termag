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
import { sessionName } from './tmux';
import type { ProjectHost } from './agentRegistry';

export const SESSION_ROLES = ['agent', 'ctrl', 'data', 'data-ctrl'] as const;
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
  }
  return out;
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
  isOwner: boolean;
  project: { id: string; name: string; userId: string; instanceId: string | null; ownerUsername: string };
}

export async function assertSessionAccess(
  requesterId: string,
  projectId: string,
  role: string,
  workstream: string = 'main',
): Promise<SessionAccess> {
  if (!isSessionRole(role)) {
    throw new SessionAccessError(400, `role must be one of: ${SESSION_ROLES.join(', ')}`);
  }
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
  if (!known.includes(workstream)) throw new SessionAccessError(404, 'Workstream not found');

  return {
    host: { userId: project.userId, instanceId: project.instanceId },
    session: sessionName(project.user.unixUsername, project.name, role, workstream),
    role,
    workstream,
    isOwner,
    project: {
      id: project.id, name: project.name, userId: project.userId,
      instanceId: project.instanceId, ownerUsername: project.user.unixUsername,
    },
  };
}
