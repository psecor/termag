/**
 * Who gets a live status on the status socket (index.ts, /ws/status and the
 * TUI's /api/cli/v1/ws/status).
 *
 * The owner gets their own sessions. A collaborator gets the sessions of the
 * projects shared with them, matched by (box, session) on names rebuilt with
 * legalSessions: the rule GET /api/sessions applies (sessionInventory.ts).
 * The socket used to send a collaborator every session of anyone who shared
 * a project with them, so one share showed what the owner ran everywhere
 * else. Chat frames were already scoped per project
 * (chatRunner.mayReceiveChat); the same share rows feed both.
 */
import { prisma } from '../db';
import { isRunnerSessionShaped } from './claudeRunnerSpawn';
import { legalSessions } from './sessionAccess';
import { statusKey } from './statusKey';
import { sessionBelongsToUser } from './tmux';

export interface SharedScope {
  /** Every project shared with the viewer, archived or not: what chat frames check. */
  sharedProjectIds: Set<string>;
  /** statusKey(box, session) of every session of a live shared project. */
  sharedStatusKeys: Set<string>;
  /** The unix users who share a live project with the viewer. */
  sharedOwners: string[];
}

export interface ShareRow {
  projectId: string;
  project: {
    name: string;
    instanceId: string | null;
    archived: boolean;
    user: { unixUsername: string };
    workstreams: { name: string }[];
  };
}

/** Pure: the scope from the viewer's share rows (workstreams already filtered to live ones). */
export function sharedScope(rows: ShareRow[]): SharedScope {
  const live = rows.filter(r => !r.project.archived);
  return {
    sharedProjectIds: new Set(rows.map(r => r.projectId)),
    sharedStatusKeys: new Set(live.flatMap(({ project: p }) =>
      legalSessions(p.user.unixUsername, p.name, p.workstreams.map(w => w.name)).map(s => statusKey(p.instanceId, s)))),
    sharedOwners: [...new Set(live.map(r => r.project.user.unixUsername))],
  };
}

export async function loadSharedScope(userId: string): Promise<SharedScope> {
  const rows = await prisma.projectShare.findMany({
    where: { userId },
    select: {
      projectId: true,
      project: {
        select: {
          name: true, instanceId: true, archived: true,
          user: { select: { unixUsername: true } },
          workstreams: { where: { archived: false }, select: { name: true } },
        },
      },
    },
  });
  return sharedScope(rows);
}

/** A status socket's share state, as index.ts keeps it for each client. */
export interface ScopeHolder extends SharedScope {
  userId: string;
  sharedCheckedAt: number;
  /** The read in flight, which pushes held for a fresh scope wait for. */
  sharedRefresh?: Promise<void>;
}

// Chat frames carry prompts and file contents, and statuses show what runs
// where, so a revoked share must stop delivery without waiting for a
// reconnect. A share change on this process re-reads the scopes it touches at
// once (notifyShareChange); anything else that would reach a viewer through a
// share is sent only on a scope younger than this, a staler one being re-read
// first (sendThroughShare).
export const SHARED_SCOPE_TTL_MS = 15_000;

/**
 * Re-reads the holder's scope after `after`; pushes that wait from now on
 * wait for this read. A failed read fails closed: no shared project or
 * session, but the owners stay, so their statuses take the re-read path
 * (`recheck`) again once the scope is stale.
 */
export function startSharedRefresh(holder: ScopeHolder, after: Promise<void> = Promise.resolve()): Promise<void> {
  const refresh: Promise<void> = after
    .then(() => loadSharedScope(holder.userId))
    .then(scope => { Object.assign(holder, scope); })
    .catch(() => { holder.sharedProjectIds = new Set(); holder.sharedStatusKeys = new Set(); })
    .finally(() => {
      holder.sharedCheckedAt = Date.now();
      if (holder.sharedRefresh === refresh) holder.sharedRefresh = undefined;
    });
  holder.sharedRefresh = refresh;
  return refresh;
}

/** The read in flight, a new one if the scope is stale, or null while it is fresh. */
export function refreshSharedScopeIfStale(holder: ScopeHolder): Promise<void> | null {
  if (holder.sharedRefresh) return holder.sharedRefresh;
  if (Date.now() - holder.sharedCheckedAt < SHARED_SCOPE_TTL_MS) return null;
  return startSharedRefresh(holder);
}

/**
 * Calls `send` for a push that reaches the viewer only through a share, if
 * `admits()` says so on a fresh scope. A stale scope is re-read first and
 * `admits` asked again, so a revoked share never gets the push that would
 * have noticed it. Pushes held behind a read keep their order.
 */
export function sendThroughShare(holder: ScopeHolder, admits: () => boolean, send: () => void): void {
  const reading = refreshSharedScopeIfStale(holder);
  if (!reading) {
    if (admits()) send();
    return;
  }
  void reading.then(() => { if (admits()) send(); });
}

/** Whose scope a share change moves: the collaborator's, or everyone's holding a share on the project. */
export type ShareChange = { userId: string } | { projectId: string };

let shareChangeListener: ((change: ShareChange) => void) | null = null;

/** index.ts sets this to re-read the scope of the open status sockets a change touches. */
export function setShareChangeCallback(fn: ((change: ShareChange) => void) | null): void {
  shareChangeListener = fn;
}

/**
 * A share was accepted, revoked or left (routes/sharing.ts), and is committed.
 * The sockets it touches follow at once, rather than at the next push that
 * finds their scope stale: an accepted share's statuses show on a page that
 * is already open, and a revoked one's stop. "At once" holds on this process
 * only: a socket on the other process of an overlap deploy
 * follows at its next push through a
 * share once its scope is SHARED_SCOPE_TTL_MS old, and is not cleared.
 */
export function notifyShareChange(change: ShareChange): void {
  shareChangeListener?.(change);
}

/** Pure: does this change move the viewer's scope? */
export function shareChangeTouches(
  change: ShareChange,
  viewer: { userId: string } & Pick<SharedScope, 'sharedProjectIds'>,
): boolean {
  return 'userId' in change ? viewer.userId === change.userId : viewer.sharedProjectIds.has(change.projectId);
}

/**
 * Pure: what a socket is sent once a share change has re-read its scope.
 * `admitted`: the current statuses of the sessions the new scope adds, so an
 * accepted share shows at once. `gone`: the keys it dropped, which the browser
 * forgets (`status-gone`), so a revoked share leaves no live-looking pill. A
 * read that failed closed drops every key; a pill comes back with the next
 * push that re-reads the scope.
 */
export function shareChangeFrames<S>(
  before: Set<string>,
  after: Set<string>,
  statuses: Iterable<[string, S]>,
): { admitted: [string, S][]; gone: string[] } {
  const admitted: [string, S][] = [];
  for (const entry of statuses) if (!before.has(entry[0]) && after.has(entry[0])) admitted.push(entry);
  return { admitted, gone: [...before].filter(key => !after.has(key)) };
}

/**
 * How a status for (box, session) reaches this viewer:
 * - `own`: their session, the full payload;
 * - `shared`: a session of a project shared with them, the payload for
 *   shared viewers (milestone and review without their URLs). The caller
 *   trusts that only on a fresh scope: a stale one is re-read and the route
 *   asked again before anything is sent;
 * - `runner`: maybe a Claude Code cloud session on one of their boxes, named
 *   after the box's unix user; the caller checks the box (ownedBoxUser);
 * - `recheck`: a session of someone who shares a project with them, outside
 *   the scope as last read. A workstream made or renamed since then would
 *   look like this, so the caller re-reads a stale scope and asks again;
 * - null: nothing.
 */
export type StatusRoute = 'own' | 'shared' | 'runner' | 'recheck' | null;

export function statusRoute(
  viewer: { unixUsername: string } & Pick<SharedScope, 'sharedStatusKeys' | 'sharedOwners'>,
  session: string,
  instanceId: string | null,
): StatusRoute {
  if (sessionBelongsToUser(session, viewer.unixUsername)) return 'own';
  if (viewer.sharedStatusKeys.has(statusKey(instanceId, session))) return 'shared';
  if (instanceId && isRunnerSessionShaped(session)) return 'runner';
  if (viewer.sharedOwners.some(owner => sessionBelongsToUser(session, owner))) return 'recheck';
  return null;
}
