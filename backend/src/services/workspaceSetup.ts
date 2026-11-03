/**
 * A multi-repo project's setup: the workspace
 * root, one durable clone per ProjectRepo, and the aggregate
 * Project.setupStatus every existing gate reads. The rules are pure
 * (projectRepos.ts); this module runs them against the database and the box.
 *
 * A repo project's setup stays in projectClone.ts, which drops the frames and
 * hellos this module handles (a frame with `repo`, a workspace row).
 */

import { prisma } from '../db';
import {
  type BoxAgentFrame,
  type BoxAgentHelloEvent,
  onBoxAgentFrame,
  onBoxAgentHello,
  sendForProject,
  sendToInstanceAgent,
} from './agentRegistry';
import { agentView, launchProjectSessions } from './projectClone';
import { claimUpdateRunning, claimUpdateSettled } from './claimUpdateGate';
import { parseCloneStatusFrame, toSetupStatus } from './projectSetup';
import { resolveProjectRoot } from './projectPaths';
import {
  aggregateSetup,
  decideRepoReport,
  isCloneRefusal,
  repoNameError,
  WORKSPACE_CLONE_CAPABILITY,
  WORKSPACE_UNSUPPORTED,
  workspaceGuide,
} from './projectRepos';
import { templateForRepoUrl } from './projectTemplates';
import * as tmux from './tmux';

const CLONE_RPC_TIMEOUT_MS = 30_000;

const tails = new Map<string, Promise<unknown>>();

function serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(projectId) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  tails.set(projectId, tail);
  void tail.then(() => { if (tails.get(projectId) === tail) tails.delete(projectId); });
  return run;
}

async function loadWorkspace(projectId: string) {
  const row = await prisma.project.findFirst({
    where: { id: projectId, archived: false, layout: 'workspace' },
    include: {
      repos: { orderBy: { position: 'asc' } },
      instance: { select: { hostHome: true, kind: true, userId: true } },
      user: { select: { unixUsername: true, defaultAgentProvider: true } },
    },
  });
  if (!row?.instanceId || !row.instance) return null;
  return { ...row, instanceId: row.instanceId, instance: row.instance };
}

type WorkspaceRow = NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>;

export function workspaceRoot(row: { name: string; user: { unixUsername: string }; instance: { hostHome: string | null } | null }, workstream = 'main'): string {
  return tmux.projectDirFor({ name: row.name, user: row.user, instance: row.instance }, workstream);
}

/**
 * init-workspace for one root: the directory, the marker (the agent writes it
 * for a project root only) and the generated guide.
 */
export async function writeGuide(
  row: { name: string; userId: string; instanceId: string | null; user: { unixUsername: string }; instance: { hostHome: string | null } | null },
  repos: ReadonlyArray<{ name: string; url: string; position: number }>,
  workstream = 'main',
  branch = workstream,
): Promise<void> {
  const guide = workspaceGuide({ project: row.name, workstream, branch, repos });
  await sendForProject({ userId: row.userId, instanceId: row.instanceId }, 'init-workspace', {
    dir: workspaceRoot(row, workstream), guide,
  });
}

/** Sends one repository's clone. Null once sent, or lost in transit (the next hello sends it again); the box's refusal otherwise. */
async function dispatchRepo(row: WorkspaceRow, repo: WorkspaceRow['repos'][number]): Promise<string | null> {
  const home = resolveProjectRoot({ ownerUnixUser: row.user.unixUsername, hostHome: row.instance.hostHome });
  const referenceDir = templateForRepoUrl(repo.url)?.referenceDir?.replace(/^\$HOME(?=\/|$)/, () => home);
  const payload = {
    projectId: row.id,
    repo: repo.name,
    instanceId: row.instanceId,
    dir: `${workspaceRoot(row)}/${repo.name}`,
    url: repo.url,
    branch: repo.defaultBranch ?? 'HEAD',
    attempt: repo.setupAttempt,
    sizeKb: null,
    ...(referenceDir ? { referenceDir } : {}),
  };
  try {
    await sendToInstanceAgent(row.instanceId, 'project-clone', payload, CLONE_RPC_TIMEOUT_MS);
    return null;
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[WORKSPACE] ${row.id}/${repo.name}: project-clone to ${row.instanceId} failed:`, message);
    return isCloneRefusal(message) ? message : null;
  }
}

/**
 * The box's agent is here: make the workspace root (never `git init`) and send a clone for every repository still pending or cloning. Each
 * clone is idempotent on the box, keyed by its attempt.
 */
export async function dispatchWorkspace(projectId: string): Promise<'dispatched' | 'unsupported' | 'absent' | 'nothing'> {
  return serialize(projectId, async () => {
    const row = await loadWorkspace(projectId);
    if (!row) return 'nothing';
    const view = agentView(row.instanceId);
    if (view.kind !== 'present') return 'absent';
    // A box just claimed from the pool is updating and may restart its agent
    // (claimUpdate.ts): the clones go out once it has, from its capabilities then.
    if (claimUpdateRunning(row.instanceId)) {
      void claimUpdateSettled(row.instanceId).then(() => dispatchWorkspace(projectId))
        .catch(err => console.error(`[WORKSPACE] ${projectId}: dispatch after the claim update failed: ${(err as Error).message}`));
      return 'absent';
    }
    if (!view.capabilities.includes(WORKSPACE_CLONE_CAPABILITY)) {
      // Cloning too: an agent that lost the capability (a box rolled back) will never report, so the spinner would not end.
      // The repositories keep their status, so Retry or the next hello of an updated agent sends them again.
      await prisma.project.updateMany({
        where: { id: row.id, setupStatus: { in: ['pending', 'cloning'] } },
        data: { setupStatus: 'failed', setupError: WORKSPACE_UNSUPPORTED },
      });
      return 'unsupported';
    }
    const todo = row.repos.filter(r => r.setupStatus === 'pending' || r.setupStatus === 'cloning');
    if (todo.length === 0) return 'nothing';
    await writeGuide(row, row.repos);
    let refused = 0;
    for (const repo of todo) {
      const refusal = await dispatchRepo(row, repo);
      if (refusal === null) continue;
      // The box will refuse the same request on every hello: fail it, so Retry and the error show.
      const { count } = await prisma.projectRepo.updateMany({
        where: { id: repo.id, setupStatus: repo.setupStatus, setupAttempt: repo.setupAttempt },
        data: { setupStatus: 'failed', setupError: refusal },
      });
      refused += count;
    }
    if (refused > 0) await settleAggregate(row.id);
    return 'dispatched';
  });
}

/**
 * The aggregate after one repository moved. When it reaches ready
 * the project's sessions start, admitted for the status they leave, and only
 * then is ready committed, guarded on that status.
 */
async function settleAggregate(projectId: string): Promise<void> {
  const row = await loadWorkspace(projectId);
  if (!row) return;
  const next = aggregateSetup(row.repos);
  const from = row.setupStatus;
  if (next.status === from && (next.error ?? null) === (row.setupError ?? null)) return;
  if (next.status === 'ready' && from !== 'ready') {
    await writeGuide(row, row.repos).catch(() => {});
    const launched = await launchProjectSessions(
      { projectId: row.id, instanceId: row.instanceId },
      { projectId: row.id, from: toSetupStatus(from) ?? 'pending' },
    ).catch(err => {
      console.error(`[WORKSPACE] ${row.name}: launch failed: ${(err as Error).message}`);
      return false;
    });
    if (!launched) console.warn(`[WORKSPACE] ${row.name}: sessions not all started; reconnect reconstruction picks them up`);
  }
  const { count } = await prisma.project.updateMany({
    where: { id: row.id, setupStatus: from },
    data: { setupStatus: next.status, setupError: next.error },
  });
  if (count > 0) console.log(`[WORKSPACE] ${row.id} on ${row.instanceId}: ${from} -> ${next.status}`);
}

/** One repository's report from the box. */
export async function applyRepoReport(instanceId: string, msg: Record<string, unknown>): Promise<void> {
  const frame = parseCloneStatusFrame(msg);
  const repoName = msg.repo;
  if (!frame || typeof repoName !== 'string' || repoNameError(repoName)) {
    console.warn(`[WORKSPACE] dropped an unreadable repository status from ${instanceId}`);
    return;
  }
  if (frame.instanceId !== instanceId) return;
  await serialize(frame.projectId, async () => {
    const repo = await prisma.projectRepo.findFirst({
      where: { projectId: frame.projectId, name: repoName, project: { instanceId, archived: false, layout: 'workspace' } },
    });
    if (!repo) return;
    const report = frame.report;
    const decision = decideRepoReport(repo, {
      attempt: frame.attempt,
      status: report.status,
      error: report.status === 'failed' ? report.error : null,
      branch: report.status === 'ready' ? report.branch : null,
    });
    if (decision.kind === 'ignore') return;
    const { count } = await prisma.projectRepo.updateMany({
      where: { id: repo.id, setupStatus: repo.setupStatus, setupAttempt: repo.setupAttempt },
      data: {
        setupStatus: decision.status,
        setupError: decision.error,
        ...(decision.branch && !repo.defaultBranch ? { defaultBranch: decision.branch } : {}),
      },
    });
    if (count === 0) return;
    console.log(`[WORKSPACE] ${frame.projectId}/${repoName}: ${repo.setupStatus} -> ${decision.status}`);
    await settleAggregate(frame.projectId);
  });
}

/**
 * Retry: every failed repository goes back to pending on a new attempt, then
 * dispatch. With none failed, the dispatch alone is the retry: a box that had
 * no workspace capability left every repository pending.
 */
export async function retryWorkspace(projectId: string): Promise<{ retried: string[]; dispatch: Awaited<ReturnType<typeof dispatchWorkspace>> }> {
  const failed = await prisma.projectRepo.findMany({ where: { projectId, setupStatus: 'failed' } });
  for (const r of failed) {
    await prisma.projectRepo.updateMany({
      where: { id: r.id, setupStatus: 'failed' },
      data: { setupStatus: 'pending', setupError: null, setupAttempt: { increment: 1 } },
    });
  }
  await serialize(projectId, () => settleAggregate(projectId));
  const dispatch = await dispatchWorkspace(projectId);
  return { retried: failed.map(r => r.name), dispatch };
}

async function onHello(ev: BoxAgentHelloEvent): Promise<void> {
  await ev.settled;
  const rows = await prisma.project.findMany({
    where: { instanceId: ev.instance.id, userId: ev.user.id, archived: false, layout: 'workspace', repos: { some: { setupStatus: { in: ['pending', 'cloning'] } } } },
    select: { id: true },
  });
  for (const { id } of rows) {
    await dispatchWorkspace(id).catch(err => console.error(`[WORKSPACE] ${id}: redispatch failed: ${(err as Error).message}`));
  }
}

function onFrame({ instance, msg }: BoxAgentFrame): void {
  if (msg.repo == null) return;
  applyRepoReport(instance.id, msg).catch(err => {
    console.error(`[WORKSPACE] applying a repository status from ${instance.id} failed:`, (err as Error).message);
  });
}

export function startWorkspaceSetup(): () => void {
  const offHello = onBoxAgentHello(ev => { void onHello(ev).catch(() => {}); });
  const offFrame = onBoxAgentFrame('project-clone-status', onFrame);
  return () => { offHello(); offFrame(); };
}
