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
import { MAX_REVIEW_SLOTS, MAX_TERMINAL_SLOTS, reviewSessionName, reviewSessionNames, sessionName, terminalSessionName, terminalSessionNames } from './tmux';
import type { ProjectHost } from './agentRegistry';

// `review` is the PR-review pane the UI's Review button starts next to the
// ctrl pane (routes/review.ts). It exists only while a review runs, and a
// workstream has up to MAX_REVIEW_SLOTS of them:
// the role's own name is slot 1, `<it>-<n>` the rest. The ctrl role has slots
// too: slot 1 is the ctrl pane itself, 2..MAX the
// terminals the user adds in the workspace.
export const SESSION_ROLES = ['agent', 'ctrl', 'data', 'data-ctrl', 'review'] as const;
export type SessionRole = typeof SESSION_ROLES[number];

export function isSessionRole(x: unknown): x is SessionRole {
  return typeof x === 'string' && (SESSION_ROLES as readonly string[]).includes(x);
}

/** Pure: every legal session name for a project (all workstreams × roles + both roles' extra slots). */
export function legalSessions(owner: string, projectName: string, workstreams: string[]): string[] {
  const wsList = workstreams.length ? workstreams : ['main'];
  const out: string[] = [];
  for (const ws of wsList) {
    for (const role of SESSION_ROLES) out.push(sessionName(owner, projectName, role, ws));
    out.push(...reviewSessionNames(owner, projectName, ws).slice(1));
    out.push(...terminalSessionNames(owner, projectName, ws).slice(1));
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
  /** The pane's slot within its role when the role has slots: review 1..MAX_REVIEW_SLOTS,
   * ctrl 1..MAX_TERMINAL_SLOTS
   * ( slot 1 = the ctrl pane). null for roles with one pane. */
  slot: number | null;
  isOwner: boolean;
  /** The workstream is an ask thread's chat (services/askChat.ts): its turns run in the chat runner, so it has no pane. */
  askChat: boolean;
  project: { id: string; name: string; userId: string; instanceId: string | null; ownerUsername: string; setupStatus: string };
}

/**
 * The answer for a route that reads or drives a pane (capture, send-keys, paste, history)
 * when the workstream is an ask thread's chat, or null. Without it the route asks tmux for
 * a session that never exists and answers 503 "can't find pane".
 */
export function askChatPaneRefusal(access: Pick<SessionAccess, 'askChat' | 'workstream'>): { status: 409; body: { error: string; code: 'ask_chat_no_pane' } } | null {
  if (!access.askChat) return null;
  return {
    status: 409,
    body: {
      error: `${access.workstream} is an ask thread's chat, which has no tmux pane: open it in the simple UI's chat, or read its replies with termag ask --inbox and termag ask --reply`,
      code: 'ask_chat_no_pane',
    },
  };
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

/** Pure: a slot as a request gave it, bounded by the role's maximum. Absent is slot 1. */
export function parseSlot(raw: unknown, max: number): { ok: true; slot: number } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, slot: 1 };
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
    return { ok: false, error: `slot must be 1 to ${max}` };
  }
  return { ok: true, slot: n };
}

/** Pure: a review slot as a request gave it, or an error. Absent is slot 1, today's one pane. */
export function parseReviewSlot(raw: unknown): { ok: true; slot: number } | { ok: false; error: string } {
  return parseSlot(raw, MAX_REVIEW_SLOTS);
}

/** How many slots a role has: review and ctrl have MAX, the rest one pane each. */
export function roleSlotMax(role: string): number {
  if (role === 'review') return MAX_REVIEW_SLOTS;
  if (role === 'ctrl') return MAX_TERMINAL_SLOTS;
  return 1;
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
      workstreams: { where: { archived: false }, select: { name: true, askThread: { select: { id: true } } } },
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
  const askChats = new Set(project.workstreams.filter(w => w.askThread).map(w => w.name));
  return (role: string, workstream: string = 'main', slot?: number): SessionAccess => {
    if (!isSessionRole(role)) {
      throw new SessionAccessError(400, `role must be one of: ${SESSION_ROLES.join(', ')}`);
    }
    const maxSlot = roleSlotMax(role);
    const askedSlot = slot === undefined ? { ok: true, slot: 1 } : parseSlot(slot, maxSlot);
    if (slot !== undefined && (!askedSlot.ok || maxSlot === 1)) {
      throw new SessionAccessError(400, `slot must be 1 to ${maxSlot}, and only for the review and ctrl roles`);
    }
    if (!known.includes(workstream)) throw new SessionAccessError(404, 'Workstream not found');
    const slotted = maxSlot > 1;
    const slotNum = askedSlot.ok ? askedSlot.slot : 1;
    const owner = project.user.unixUsername;
    return {
      host: { userId: project.userId, instanceId: project.instanceId },
      session: role === 'review' && slotted
        ? reviewSessionName(owner, project.name, workstream, slotNum)
        : role === 'ctrl' && slotted
          ? terminalSessionName(owner, project.name, workstream, slotNum)
          : sessionName(owner, project.name, role, workstream),
      role,
      workstream,
      slot: slotted ? slotNum : null,
      isOwner,
      askChat: askChats.has(workstream),
      project: {
        id: project.id, name: project.name, userId: project.userId,
        instanceId: project.instanceId, ownerUsername: owner,
        setupStatus: project.setupStatus,
      },
    };
  };
}

/** Why the terminal socket refused an attach: its close reason, which the TUI treats as final. */
export type TerminalRefusal = 'session forbidden' | 'session/project mismatch' | 'ask chat has no pane';

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
    // Every review slot and terminal slot past the
    // ctrl pane is a pane of its own.
    if (forPane('agent', workstream).askChat) return { refusal: 'ask chat has no pane' };
    const reviewSlots = Array.from({ length: MAX_REVIEW_SLOTS - 1 }, (_, i) => forPane('review', workstream, i + 2));
    const terminalSlots = Array.from({ length: MAX_TERMINAL_SLOTS - 1 }, (_, i) => forPane('ctrl', workstream, i + 2));
    return [...SESSION_ROLES.map(role => forPane(role, workstream)), ...reviewSlots, ...terminalSlots]
      .find(a => a.session === session)
      ?? { refusal: 'session/project mismatch' };
  } catch (err) {
    // A workstream the project does not have.
    if (err instanceof SessionAccessError) return { refusal: 'session/project mismatch' };
    throw err;
  }
}
