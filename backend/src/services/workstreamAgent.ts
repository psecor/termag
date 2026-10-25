// Give an existing workstream an agent: the agent workflow row plus its
// sessions, continuing the last conversation in the checkout. Used when a
// project is un-archived (archiving deletes every workflow but keeps the
// workstreams) and by the sidebar's "Start agent…" on a workstream with none.
//
// Only into a checkout that is really there: `tmux-create` makes a missing
// folder and git-inits it, which leaves an empty repo where the worktree was
// (and an agent stuck on Claude's folder-trust prompt inside it).

import { prisma } from '../db';
import { sendForProject } from './agentRegistry';
import { ensureAgentSessionsAndLaunch, type LaunchOutcome } from './agentRuntime';
import * as tmux from './tmux';

export type WorkstreamAgentOutcome = LaunchOutcome | 'no-checkout';

type AgentRuntimeContext = Parameters<typeof ensureAgentSessionsAndLaunch>[0];

export interface WorkstreamAgentDeps {
  branchState: (host: { userId: string; instanceId: string | null }, cwd: string) => Promise<unknown>;
  recordAgent: (projectId: string, workstreamId: string, provider: string, backend: string | null, model: string | null) => Promise<void>;
  launch: (ctx: AgentRuntimeContext) => Promise<LaunchOutcome>;
}

const defaultDeps: WorkstreamAgentDeps = {
  branchState: (host, cwd) => sendForProject(host, 'git-branch-state', { cwd }, 10_000),
  recordAgent: async (projectId, workstreamId, provider, backend, model) => {
    await prisma.workflow.upsert({
      where: { workstreamId_type: { workstreamId, type: 'agent' } },
      create: { projectId, workstreamId, type: 'agent', provider, backend, model },
      update: {},
    });
  },
  launch: ensureAgentSessionsAndLaunch,
};

/** A git checkout with at least one commit: what a worktree folder looks like. */
export function isUsableCheckout(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  return typeof (state as { lastCommitAt?: unknown }).lastCommitAt === 'string';
}

export interface WorkstreamAgentTarget {
  projectId: string;
  workstreamId: string;
  userId: string;
  unixUsername: string;
  projectName: string;
  instanceId: string | null;
  hostHome: string | null;
  workstream: string;
  provider: string;
  /** The model backend (Workflow.backend); absent = the harness's default. */
  backend?: string | null;
  /** The model (Workflow.model); absent = the backend's default. */
  model?: string | null;
}

/**
 * Check the checkout and record the agent workflow. Returns the launch to
 * run, or null when there is no usable checkout (nothing recorded).
 */
export async function adoptWorkstreamAgent(
  target: WorkstreamAgentTarget,
  deps: WorkstreamAgentDeps = defaultDeps,
): Promise<AgentRuntimeContext | null> {
  const host = { userId: target.userId, instanceId: target.instanceId };
  const cwd = tmux.projectDirFor(
    { name: target.projectName, user: { unixUsername: target.unixUsername }, instance: { hostHome: target.hostHome } },
    target.workstream,
  );
  // A folder that is missing, not a repo, or a repo with no commit (the
  // empty git-init above) all fail here; so does a box agent too old to answer.
  const state = await deps.branchState(host, cwd).catch(() => null);
  if (!isUsableCheckout(state)) return null;

  const backend = target.backend ?? null;
  const model = target.model ?? null;
  await deps.recordAgent(target.projectId, target.workstreamId, target.provider, backend, model);
  return {
    userId: target.userId,
    unixUsername: target.unixUsername,
    projectName: target.projectName,
    provider: target.provider,
    instanceId: target.instanceId,
    workstream: target.workstream,
    hostHome: target.hostHome,
    resume: true,
    backend,
    model,
  };
}

/** Adopt, then launch: continue the checkout's last conversation in a fresh pane. */
export async function startWorkstreamAgent(
  target: WorkstreamAgentTarget,
  deps: WorkstreamAgentDeps = defaultDeps,
): Promise<WorkstreamAgentOutcome> {
  const ctx = await adoptWorkstreamAgent(target, deps);
  if (!ctx) return 'no-checkout';
  return deps.launch(ctx);
}
