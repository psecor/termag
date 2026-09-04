/**
 * Resolve a tmux session name back to its owner + project + workstream.
 *
 * Session names are `<owner>-<project>-<role>` (main workstream) or
 * `<owner>-<project>-<workstream>-<role>` (non-main). Parsing is ambiguous —
 * both project and workstream names can contain dashes, and roles like
 * `data-ctrl` do too — so instead of splitting we rebuild candidate names from
 * the owner's projects/workstreams and match. This is the same battle-tested
 * approach the Slack `/t` surface used (previously inlined in slack/tmuxAgent).
 *
 * Results are cached briefly so hot callers (the status-route context sampler,
 * Slack poll loops) don't re-query the DB on every tick.
 */
import { prisma } from '../db';
import { sessionName as buildSessionName } from './tmux';


const ROLES = ['agent', 'ctrl', 'data', 'data-ctrl'] as const;

export interface ResolvedSession {
  userId: string;
  instanceId: string | null;
  // Project match. null when the owner is known but the session doesn't map to
  // a known project/workstream (e.g. an arbitrary `/t attach <name>` target) —
  // the owner's legacy agent still handles it, but there's nothing to sample.
  projectId: string | null;
  workstream: string | null;
}

export interface ProjectLike {
  id: string;
  name: string;
  instanceId: string | null;
  workstreams: { name: string }[];
}

/**
 * Pure: rebuild candidate session names from the owner's projects/workstreams
 * and return the first match. Handles dashes in project AND workstream names
 * because it never parses the session string — it only compares against names
 * built by the canonical `sessionName()`.
 */
export function matchSession(
  session: string,
  owner: string,
  projects: ProjectLike[],
): { projectId: string; workstream: string; instanceId: string | null } | null {
  for (const p of projects) {
    const wsNames = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
    for (const ws of wsNames) {
      for (const role of ROLES) {
        if (session === buildSessionName(owner, p.name, role, ws)) {
          return { projectId: p.id, workstream: ws, instanceId: p.instanceId };
        }
      }
    }
  }
  return null;
}

const cache = new Map<string, { resolved: ResolvedSession | null; at: number }>();
const TTL_MS = 60_000;

/**
 * Returns the resolved session, or null when the owner is unknown. When the
 * owner exists but no project matches, `projectId`/`workstream` are null and
 * `instanceId` is null (legacy-agent fallback).
 */
export async function resolveSessionProject(session: string): Promise<ResolvedSession | null> {
  const cached = cache.get(session);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.resolved;

  let resolved: ResolvedSession | null = null;
  const owner = session.split('-')[0];
  if (owner) {
    const user = await prisma.user.findUnique({ where: { unixUsername: owner } });
    if (user) {
      const projects = await prisma.project.findMany({
        where: { userId: user.id },
        include: { workstreams: true },
      });
      const m = matchSession(session, owner, projects);
      resolved = m
        ? { userId: user.id, instanceId: m.instanceId, projectId: m.projectId, workstream: m.workstream }
        : { userId: user.id, instanceId: null, projectId: null, workstream: null };
    }
  }
  cache.set(session, { resolved, at: Date.now() });
  return resolved;
}
