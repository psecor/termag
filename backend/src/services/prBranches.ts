/**
 * The box half of the PR pipeline: each live workstream
 * of the user's own projects, asked over the `git-branch-state` agent RPC
 * where its checkout stands. Feeds lanes 1 and 2 and, through the checkout's
 * `origin`, tells the lane rules which repository a workstream is, so PR rows
 * link by (repository, branch) instead of branch alone.
 *
 * Only runs inside a /api/prs load, so it inherits that route's 60 s per-user
 * memo: nothing polls the boxes while no dashboard or PR screen is open. A
 * host whose agent is offline is skipped; an agent that predates the RPC
 * answers "Unknown command" and its workstreams fall back to branch-only
 * linkage.
 */

import { prisma } from '../db';
import { WORK_PROJECT_KINDS } from './projectKind';
import { isProjectAgentConnected, sendForProject, type ProjectHost } from './agentRegistry';
import { getGithubBrokerUrl } from './githubBroker';
import type { BranchState, LinkableWorkstream } from './prPipeline';
import { projectDirFor } from './tmux';

// The agent's git calls are capped at 5 s for `status` and 2 s for the rest,
// which run together, so a slow repo answers (or fails) inside this.
const RPC_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;

export interface WorkstreamTarget {
  host: ProjectHost;
  cwd: string;
  projectId: string;
  projectName: string;
  workstream: string;
  /** Workstream.branch: what the worktree was created for. */
  branch: string;
}

/** The fields of the RPC answer this reads; everything is re-validated. */
export interface RawBranchState {
  branch?: unknown;
  upstream?: unknown;
  ahead?: unknown;
  baseBranch?: unknown;
  aheadOfBase?: unknown;
  dirty?: unknown;
  lastCommitAt?: unknown;
  origin?: unknown;
}

/**
 * `owner/name` from a git remote on GitHub: https (github.com, or the GitHub
 * broker, which keeps GitHub's path), ssh `git@github.com:owner/name`, with or
 * without `.git`. Anything else (a path remote, another forge) is null: no PR
 * can be opened from it, and it must not borrow a GitHub repository's name.
 */
export function repoFromOrigin(origin: unknown, githubHosts: string[] = defaultGithubHosts()): string | null {
  if (typeof origin !== 'string') return null;
  const o = origin.trim();
  const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(o);
  let host: string; let owner: string; let name: string;
  if (scp) {
    [, host, owner, name] = scp;
  } else {
    let url: URL;
    try { url = new URL(o); } catch { return null; }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
    if (parts.length !== 2 || !parts.every(p => /^[\w.-]+$/.test(p))) return null;
    host = url.hostname;
    [owner, name] = parts;
  }
  return githubHosts.includes(host.toLowerCase()) ? `${owner}/${name}` : null;
}

function defaultGithubHosts(): string[] {
  const broker = getGithubBrokerUrl();
  return ['github.com', ...(broker ? [new URL(broker).hostname.toLowerCase()] : [])];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

export function toBranchState(t: WorkstreamTarget, raw: RawBranchState): BranchState | null {
  const branch = str(raw.branch);
  if (!branch) return null; // detached HEAD: nothing a PR could come from
  const upstream = str(raw.upstream);
  return {
    repo: repoFromOrigin(raw.origin),
    branch,
    baseBranch: str(raw.baseBranch) ?? 'main',
    // Not a count (the agent's rev-list failed, or an older answer): unknown, not 0.
    aheadOfBase: typeof raw.aheadOfBase === 'number' && Number.isInteger(raw.aheadOfBase) && raw.aheadOfBase >= 0 ? raw.aheadOfBase : null,
    pushed: upstream !== null && count(raw.ahead) === 0,
    dirty: raw.dirty === true,
    lastCommitAt: str(raw.lastCommitAt),
    workstream: { projectId: t.projectId, projectName: t.projectName, workstream: t.workstream },
  };
}

export interface BranchSweep {
  branches: BranchState[];
  workstreams: LinkableWorkstream[];
  /** Workstreams that could not be read, by reason, for the response's notes. */
  offline: number;
  outdatedAgent: number;
  /** Reads that failed for another reason: a timeout, a missing worktree. */
  failed: number;
}

export type SendFn = (host: ProjectHost, type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

export async function sweepBranches(
  targets: WorkstreamTarget[],
  deps: { connected: (host: ProjectHost) => boolean; send: SendFn },
): Promise<BranchSweep> {
  const out: BranchSweep = { branches: [], workstreams: [], offline: 0, outdatedAgent: 0, failed: 0 };
  // Once an agent says it has no such RPC, don't ask it again for its other workstreams.
  const outdated = new Set<string>();
  const hostKey = (h: ProjectHost) => h.instanceId ?? `legacy:${h.userId}`;

  const one = async (t: WorkstreamTarget) => {
    const fallback: LinkableWorkstream = {
      projectId: t.projectId, projectName: t.projectName, workstream: t.workstream, branch: t.branch, repo: null,
    };
    if (!deps.connected(t.host)) { out.offline++; out.workstreams.push(fallback); return; }
    if (outdated.has(hostKey(t.host))) { out.outdatedAgent++; out.workstreams.push(fallback); return; }
    try {
      const raw = await deps.send(t.host, 'git-branch-state', { cwd: t.cwd }, RPC_TIMEOUT_MS) as RawBranchState;
      const state = toBranchState(t, raw ?? {});
      if (!state) { out.workstreams.push(fallback); return; }
      out.branches.push(state);
      out.workstreams.push({ ...fallback, branch: state.branch, repo: state.repo });
    } catch (err) {
      if (/Unknown command/i.test((err as Error).message)) { outdated.add(hostKey(t.host)); out.outdatedAgent++; }
      else out.failed++;
      // Either way the workstream still links by branch.
      out.workstreams.push(fallback);
    }
  };

  const queue = [...targets];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await one(t);
  }));
  return out;
}

/** Every live workstream of the user's own (non-MetaTerm) projects, with where it lives. */
export async function workstreamTargets(userId: string): Promise<WorkstreamTarget[]> {
  const rows = await prisma.workstream.findMany({
    // An ask's chat has no checkout of its own (services/askChat.ts).
    where: { archived: false, askThread: null, project: { userId, archived: false, kind: { in: WORK_PROJECT_KINDS } } },
    select: {
      name: true,
      branch: true,
      project: {
        select: {
          id: true, name: true, userId: true, instanceId: true,
          user: { select: { unixUsername: true } },
          instance: { select: { hostHome: true } },
        },
      },
    },
  });
  // A stopped box has no agent connected, so the sweep counts it offline and
  // its workstreams still link by branch.
  return rows.map(w => ({
    host: { userId: w.project.userId, instanceId: w.project.instanceId },
    cwd: projectDirFor(w.project, w.name),
    projectId: w.project.id,
    projectName: w.project.name,
    workstream: w.name,
    branch: w.branch,
  }));
}

export async function readBranches(userId: string): Promise<BranchSweep> {
  return sweepBranches(await workstreamTargets(userId), { connected: isProjectAgentConnected, send: sendForProject });
}
