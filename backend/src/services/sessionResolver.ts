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
import { sessionName as buildSessionName, tmuxSafeName } from './tmux';


const ROLES = ['agent', 'ctrl', 'data', 'data-ctrl', 'review'] as const;

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

export interface SessionMatch {
  projectId: string;
  workstream: string;
  instanceId: string | null;
}

export interface AmbiguousSession {
  ambiguous: true;
}

export function isAmbiguousSession(value: unknown): value is AmbiguousSession {
  return !!value && typeof value === 'object' && (value as AmbiguousSession).ambiguous === true;
}

export function operationScopeForResolvedSession(
  resolved: ResolvedSession,
): string | null | undefined {
  return resolved.projectId ? resolved.instanceId : undefined;
}

export function ownerProjectsWhere(userId: string): { userId: string; archived: false } {
  return { userId, archived: false };
}

/**
 * Pure: rebuild candidate session names from the owner's projects/workstreams
 * and return the match. Handles dashes in project AND workstream names
 * because it never parses the session string — it only compares against names
 * built by the canonical `sessionName()`.
 *
 * The same tmux name can be built by two projects when they share a name on
 * different instances. Without `instanceId` that is ambiguous and returns
 * null (it does not pick the first row). Pass `instanceId` — including null
 * for the orchestrator — to select the row on that host.
 */
function collectMatches(session: string, owner: string, projects: ProjectLike[]): SessionMatch[] {
  const matches: SessionMatch[] = [];
  for (const p of projects) {
    const wsNames = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
    let hit = false;
    for (const ws of wsNames) {
      if (hit) break;
      for (const role of ROLES) {
        if (session === buildSessionName(owner, p.name, role, ws)) {
          matches.push({ projectId: p.id, workstream: ws, instanceId: p.instanceId });
          hit = true;
          break;
        }
      }
    }
  }
  return matches;
}

function scopeMatches(matches: SessionMatch[], instanceId?: string | null): SessionMatch[] {
  return instanceId === undefined ? matches : matches.filter(m => m.instanceId === instanceId);
}

export function matchSession(
  session: string,
  owner: string,
  projects: ProjectLike[],
  instanceId?: string | null,
): SessionMatch | null {
  const scoped = scopeMatches(collectMatches(session, owner, projects), instanceId);
  if (scoped.length === 1) return scoped[0];
  return null;
}

/**
 * A single row is that project. Several rows are `{ ambiguous: true }`.
 * The legacy agent (instanceId null, no project) is only for an unscoped
 * lookup that matches nothing. A caller that named an instance and found
 * no row gets null, so the command is not sent to the orchestrator.
 */
export function resolveSessionMatch(
  userId: string,
  session: string,
  owner: string,
  projects: ProjectLike[],
  instanceId?: string | null,
): ResolvedSession | AmbiguousSession | null {
  const matches = collectMatches(session, owner, projects);
  const scoped = scopeMatches(matches, instanceId);
  if (scoped.length === 1) {
    const m = scoped[0];
    return { userId, instanceId: m.instanceId, projectId: m.projectId, workstream: m.workstream };
  }
  if (scoped.length > 1) return { ambiguous: true };
  if (instanceId === undefined && matches.length === 0) {
    return { userId, instanceId: null, projectId: null, workstream: null };
  }
  return null;
}

/**
 * A superset of the users whose tmux-safe name is `owner`. Folding only
 * turns `.`/`:` into `_`, so such a username starts with the text before
 * the first `_` and ends with the text after the last one; callers keep
 * only the rows where `tmuxSafeName(unixUsername) === owner`.
 */
export function ownerCandidatesWhere(owner: string) {
  const parts = owner.split('_');
  if (parts.length === 1) return { unixUsername: owner };
  return { unixUsername: { startsWith: parts[0], endsWith: parts[parts.length - 1] } };
}

/**
 * Combine per-user results for every user whose tmux-safe name is the
 * session's owner segment. More than one user rebuilding the name, or more
 * than one falling back to its legacy agent, is ambiguous: two accounts that
 * fold to the same name can't be told apart from the session string.
 */
export function combineOwnerResults(
  results: (ResolvedSession | AmbiguousSession | null)[],
): ResolvedSession | AmbiguousSession | null {
  const hits = results.filter(r => r && (isAmbiguousSession(r) || r.projectId));
  if (hits.length > 1 || hits.some(isAmbiguousSession)) return { ambiguous: true };
  if (hits.length === 1) return hits[0];
  const legacy = results.filter(r => r !== null);
  if (legacy.length > 1) return { ambiguous: true };
  return legacy[0] ?? null;
}

const cache = new Map<string, { resolved: ResolvedSession | AmbiguousSession | null; at: number }>();
const TTL_MS = 60_000;

/**
 * Null when the owner is unknown. `{ ambiguous: true }` when more than one
 * live project builds the name. A known owner with no project match is the
 * legacy-agent object, and only when the caller did not name an instance.
 */
export async function resolveSessionProject(
  session: string,
  instanceId?: string | null,
): Promise<ResolvedSession | AmbiguousSession | null> {
  // Scope the cache by instance. An unscoped lookup that failed as ambiguous
  // must not satisfy a later lookup that names the box.
  const cacheKey = instanceId === undefined ? `*\0${session}` : `${instanceId ?? ''}\0${session}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.resolved;

  let resolved: ResolvedSession | AmbiguousSession | null = null;
  const owner = session.split('-')[0];
  if (owner) {
    // tmux names carry `_` where the username has `.` (tmuxSafeName), so
    // the owner segment is compared against each username folded forward.
    const users = (await prisma.user.findMany({ where: ownerCandidatesWhere(owner) }))
      .filter(u => tmuxSafeName(u.unixUsername) === owner);
    const results = [];
    for (const user of users) {
      const projects = await prisma.project.findMany({
        where: ownerProjectsWhere(user.id),
        include: { workstreams: true },
      });
      results.push(resolveSessionMatch(user.id, session, user.unixUsername, projects, instanceId));
    }
    resolved = combineOwnerResults(results);
  }
  cache.set(cacheKey, { resolved, at: Date.now() });
  return resolved;
}
