/**
 * Session inventory: project rows → one entry per (workstream, role) with
 * agent connectivity, tmux liveness and the in-memory status. Extracted from
 * routes/sessions.ts so the per-user route and the org-wide admin view build
 * rows the same way (one tmux-list RPC per distinct host, 5 s timeout).
 */
import { sendForProject, isProjectAgentConnected, type ProjectHost } from './agentRegistry';
import { SESSION_ROLES, isOnCallerHost } from './sessionAccess';
import { sessionName } from './tmux';
import { getAllStatuses } from './status';
import { statusKey } from './statusKey';
import { providerForSource } from '../providers/registry';

export interface InventoryProject {
  id: string;
  name: string;
  userId: string;
  instanceId: string | null;
  lastActiveAt: Date;
  user: { unixUsername: string };
  workstreams: Array<{ name: string }>;
  workflows: Array<{ provider: string | null }>;
}

export const inventoryInclude = {
  user: { select: { unixUsername: true } },
  workstreams: { where: { archived: false }, select: { name: true } },
  // Fallback provider for rows whose status carries no `source` (hook-driven
  // Claude sends none) — the project's agent workflow says what runs there.
  workflows: { where: { type: 'agent' as const }, select: { provider: true } },
};

export interface SessionRow {
  projectId: string;
  projectName: string;
  owner: string;
  ownerUserId: string;
  access: string;
  workstream: string;
  role: string;
  session: string;
  instanceId: string | null;
  /** Is this pane on the host the caller's own agent token belongs to? Always false for browser sessions and the admin view. */
  onCallerHost: boolean;
  connected: boolean;
  alive: boolean;
  status: string;
  contextTokens: number | null;
  updatedAt: string | null;
  waitingReason: string | null;
  rateLimited: string | null;
  /** "PR opened/merged" milestone awaiting a compact/clear decision (additive). */
  milestone: unknown;
  provider: string | null;
  lastActiveAt: string;
}

export async function collectSessionRows(
  projects: Array<{ p: InventoryProject; access: string }>,
  callerInstanceId?: string | null,
): Promise<SessionRow[]> {
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

  // Probe every distinct host up front and in parallel: with N unreachable
  // hosts the sequential form would cost N × the 5 s timeout.
  const hosts = new Map<string, ProjectHost>();
  for (const { p } of projects) hosts.set(`${p.userId}:${p.instanceId ?? ''}`, { userId: p.userId, instanceId: p.instanceId });
  await Promise.all([...hosts.values()].map(liveSet));

  // Read the raw map, not getStatus(): that helper fabricates a
  // `not_running` entry stamped `updatedAt: now` for unknown sessions, which
  // would make every never-seen session look freshly updated.
  const statuses = getAllStatuses();
  const out: SessionRow[] = [];
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
        // agent/ctrl exist for every project; data and review roles only if actually live.
        if ((role === 'data' || role === 'data-ctrl' || role === 'review') && !alive) continue;
        // The status map is keyed by (instanceId, session): same-named projects
        // on two boxes must not share an entry (services/statusKey.ts).
        const raw = statuses.get(statusKey(p.instanceId, session));
        out.push({
          projectId: p.id, projectName: p.name, owner: p.user.unixUsername, ownerUserId: p.userId, access,
          workstream: ws, role, session, instanceId: p.instanceId,
          onCallerHost: isOnCallerHost(p.instanceId, callerInstanceId),
          connected, alive, status: raw?.status ?? 'not_running', contextTokens: raw?.contextTokens ?? null,
          // Triage fields (additive). updatedAt is the last status WRITE — metadata
          // pushes (context tokens, rate-limit gauge) bump it too, so "waiting since"
          // derived from it is a lower bound. null = no status ever recorded.
          updatedAt: raw ? raw.updatedAt.toISOString() : null,
          waitingReason: raw?.waitingReason ?? null,
          rateLimited: raw?.rateLimited ?? null,
          milestone: raw?.milestone ?? null,
          // The review pane always runs Devin (routes/review.ts), whatever the project's agent is.
          provider: role === 'review' ? 'devin' : (raw?.source ? providerForSource(raw.source) : undefined) ?? p.workflows[0]?.provider ?? null,
          lastActiveAt: p.lastActiveAt.toISOString(),
        });
      }
    }
  }
  return out;
}
