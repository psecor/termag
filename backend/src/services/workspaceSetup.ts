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
  decideRepoReport,
  guideRepos,
  isCloneRefusal,
  JOIN_FAILED,
  repoNameError,
  settledSetup,
  WORKSPACE_CLONE_CAPABILITY,
  WORKSPACE_UNSUPPORTED,
  workspaceGuide,
} from './projectRepos';
import { templateForRepoUrl } from './projectTemplates';
import * as tmux from './tmux';
import { WORKSPACE_STATIC_ROOT_CAPABILITY, staticCheckoutRoot, staticLayoutDecision } from './staticLayout';

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
  row: { id: string; name: string; userId: string; instanceId: string | null; user: { unixUsername: string }; instance: { hostHome: string | null } | null },
  repos: ReadonlyArray<{ name: string; url: string; position: number }>,
  workstream = 'main',
  branch = workstream,
  staticRoot: string | null = null,
): Promise<{ staticLayout?: unknown; staticRefused?: unknown } | null> {
  const guide = workspaceGuide({ project: row.name, workstream, branch, repos });
  // staticRoot: the static layout's ~/code, which the project root becomes a link to (services/staticLayout.ts).
  return await sendForProject({ userId: row.userId, instanceId: row.instanceId }, 'init-workspace', {
    dir: workspaceRoot(row, workstream), guide, ...(staticRoot ? { staticRoot, projectId: row.id } : {}),
  }) as { staticLayout?: unknown; staticRefused?: unknown } | null;
}

/**
 * The repositories a workstream root's guide lists, by the worktrees the box
 * finds in it (guideRepos). Read before a rename moves the root; a box that
 * cannot say leaves the guide to the repositories with a checkout.
 */
export async function workstreamGuideRepos<R extends { name: string; setupStatus: string; setupError?: string | null }>(
  host: { userId: string; instanceId: string | null },
  wsRoot: string,
  repos: ReadonlyArray<R>,
): Promise<R[]> {
  try {
    const state = await sendForProject(host, 'workspace-root-state', { wsRoot, repos: repos.map(r => r.name) }, 10_000) as { present?: string[] };
    if (Array.isArray(state?.present)) return guideRepos(repos, { present: state.present });
  } catch { /* the fallback below */ }
  return guideRepos(repos);
}

/** The static layout's root (~/code) for this workspace, or null for its own directory (services/staticLayout.ts). */
async function staticRootFor(row: WorkspaceRow, capabilities: readonly string[]): Promise<string | null> {
  if (row.dir) return row.dir;
  const others = row.environmentId
    ? await prisma.project.count({ where: { instanceId: row.instanceId, archived: false, id: { not: row.id } } })
    : 0;
  if (!staticLayoutDecision(row, row.instance, capabilities, others, WORKSPACE_STATIC_ROOT_CAPABILITY).use) return null;
  const root = staticCheckoutRoot(resolveProjectRoot({ ownerUnixUser: row.user.unixUsername, hostHome: row.instance.hostHome }));
  // Never a root another project on the box records, an archived one's included (the box checks its owner file too).
  if (await prisma.project.count({ where: { instanceId: row.instanceId, dir: root, id: { not: row.id } } }) > 0) return null;
  return root;
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
    // A ready project's root is there; its guides are rewritten once an added repository has joined (joinRepo).
    if (row.setupStatus !== 'ready') {
      // On a box made from an environment for this project the root is ~/code, the project's directory a link to it,
      // so every clone below lands at ~/code/<repo> (services/staticLayout.ts). Asked before the first clone.
      const staticRoot = await staticRootFor(row, view.capabilities);
      const answer = await writeGuide(row, row.repos, 'main', 'main', staticRoot);
      if (staticRoot && answer?.staticLayout === true && row.dir !== staticRoot) {
        await prisma.project.update({ where: { id: row.id }, data: { dir: staticRoot } });
        console.log(`[WORKSPACE] ${row.id}: root at ${staticRoot}, linked from ${workspaceRoot(row)}`);
      } else if (staticRoot && answer && answer.staticLayout !== true) {
        // Refused, or an agent that ignores staticRoot: the root is the project's own folder, so a recorded ~/code is
        // forgotten and the steps run there.
        console.warn(`[WORKSPACE] ${row.id}: not the static layout: ${String(answer.staticRefused ?? 'the box did not take it')}`);
        if (row.dir) await prisma.project.update({ where: { id: row.id }, data: { dir: null } });
      }
    }
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
  const from = row.setupStatus;
  const next = settledSetup(from, row.setupError ?? null, row.repos);
  if (!next) return;
  if (next.status === 'ready') {
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
      include: { project: { select: { setupStatus: true } } },
    });
    if (!repo) return;
    const report = frame.report;
    let decision = decideRepoReport(repo, {
      attempt: frame.attempt,
      status: report.status,
      error: report.status === 'failed' ? report.error : null,
      branch: report.status === 'ready' ? report.branch : null,
    });
    if (decision.kind === 'ignore') return;
    // Added to a project already in use: ready only once every workstream has a worktree of it.
    // Until then the row stays cloning, so a reconnect's resent report joins it again.
    if (decision.status === 'ready' && repo.project.setupStatus === 'ready') {
      const joined = await joinRepo(frame.projectId, repoName);
      if (joined) decision = { ...decision, status: 'failed', error: joined };
    }
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
 * A repository added to a project in use, once cloned: a worktree of it in
 * every workstream root on that workstream's branch (branched off its
 * checkout's HEAD, as Branch off does), then every generated guide rewritten
 * to list it. A workstream whose root is not on the box is skipped. Null when
 * it all went, else what failed; the worktrees made stay, and Retry, whose
 * clone finds the checkout already there, joins the rest (an existing
 * worktree on the branch is reused).
 */
async function joinRepo(projectId: string, repoName: string): Promise<string | null> {
  const row = await loadWorkspace(projectId);
  if (!row) return null;
  const host = { userId: row.userId, instanceId: row.instanceId };
  const root = workspaceRoot(row);
  const workstreams = await prisma.workstream.findMany({
    // An ask's chat has no tree of its own (services/askChat.ts).
    where: { projectId, name: { not: 'main' }, askThread: null }, select: { name: true, branch: true }, orderBy: { createdAt: 'asc' },
  });
  const failures: string[] = [];
  const present: Array<{ name: string; branch: string; repos: string[] }> = [];
  const names = row.repos.map(r => r.name);
  for (const ws of workstreams) {
    const wsRoot = workspaceRoot(row, ws.name);
    let state: { exists?: boolean; present?: string[] } | undefined;
    try {
      state = await sendForProject(host, 'workspace-root-state', { wsRoot, repos: names }, 10_000) as typeof state;
      if (state?.exists !== true) continue;
      const here = { ...ws, repos: (state.present ?? []).filter(n => n !== repoName) };
      present.push(here);
      await sendForProject(host, 'git-worktree-add', {
        projectDir: `${root}/${repoName}`, worktreeName: ws.name, worktreePath: `${wsRoot}/${repoName}`, branch: ws.branch, baseRef: 'HEAD', initRepo: false,
      }, 30_000);
      here.repos.push(repoName);
    } catch (err) {
      failures.push(`${ws.name}: ${(err as Error).message}`);
    }
  }
  await writeGuide(row, guideRepos(row.repos, { joined: repoName })).catch(() => {});
  for (const ws of present) await writeGuide(row, guideRepos(row.repos, { present: ws.repos }), ws.name, ws.branch).catch(() => {});
  if (failures.length > 0) {
    console.error(`[WORKSPACE] ${projectId}/${repoName}: joining workstreams failed: ${failures.join('; ')}`);
    return `${JOIN_FAILED} ${failures.join('; ')}`;
  }
  console.log(`[WORKSPACE] ${projectId}/${repoName}: joined ${present.length} workstream(s)`);
  return null;
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
