/**
 * A repo project's setup: the one place that moves `Project.setupStatus`.
 * The decisions are pure (projectSetup.ts); this module runs their effects
 * (the `project-clone` RPC, the pane checkout, the agent launch) and commits
 * the move.
 *
 * Effects run before the commit, and the commit is guarded on the status and
 * attempt it was decided from. A launch the gate admits for the status it
 * leaves (sessionGate.ts) therefore never shows a session to anyone else
 * early. An effect that could not do its part commits `failed` in place of
 * the move, through the same guard. Events for one project run one at a time
 * in this process: two hellos or a hello and a report never decide from the
 * same row.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import {
  type BoxAgentFrame,
  type BoxAgentHelloEvent,
  instanceAgentTransport,
  onBoxAgentFrame,
  onBoxAgentHello,
  sendForProject,
  sendToInstanceAgent,
} from './agentRegistry';
import { ensureAgentSessionsAndLaunch, resolveAgentProvider } from './agentRuntime';
import { claimUpdateRunning, claimUpdateSettled } from './claimUpdateGate';
import { hasGithubCredential } from './boxCreationGate';
import { deliversGithub } from './credentialDelivery';
import { isManagedBox } from './instanceLifecycle';
import { paneCheckoutReady, shouldWaitForPaneCheckout, waitForPaneCheckout } from './paneCheckout';
import { resolveProjectRoot } from './projectPaths';
import { buildCloneCommand, templateForRepoUrl } from './projectTemplates';
import {
  type AgentView,
  decideSetup,
  effectFailure,
  parseCloneStatusFrame,
  type SetupEffect,
  type SetupEvent,
  type SetupStatus,
  type SetupWrite,
  toSetupStatus,
} from './projectSetup';
import type { SetupAdmission } from './sessionGate';
import * as tmux from './tmux';
import { startEnvironmentAfterClone } from './projectEnvironment';
import { staticCheckoutDir, staticLayoutDecision, staticRepoName } from './staticLayout';

export interface SetupTarget {
  projectId: string;
  instanceId: string;
}

export type SetupOutcome =
  | { kind: 'applied'; from: SetupStatus; to: SetupStatus }
  | { kind: 'ignored'; why: string }
  | { kind: 'refused'; error: string }
  // The checkout waits in the background: for the box's GitHub delivery (deferDeliveryWait), or for a claim's update.
  | { kind: 'deferred' };

const CLONE_RPC_TIMEOUT_MS = 30_000;

export function agentView(instanceId: string): AgentView {
  const live = instanceAgentTransport(instanceId);
  if (!live) return { kind: 'absent' };
  if (!live.helloReceived) return { kind: 'awaiting-hello' };
  return { kind: 'present', capabilities: live.capabilities };
}

const tails = new Map<string, Promise<unknown>>();

function serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(projectId) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  tails.set(projectId, tail);
  void tail.then(() => { if (tails.get(projectId) === tail) tails.delete(projectId); });
  return run;
}

async function loadSetupRow(target: SetupTarget) {
  const row = await prisma.project.findFirst({
    where: { id: target.projectId, archived: false, instanceId: target.instanceId },
    include: {
      workflows: { include: { workstream: { select: { name: true } } } },
      workstreams: { where: { name: 'main' }, select: { branch: true } },
      instance: { select: { hostHome: true, kind: true, userId: true } },
      user: { select: { unixUsername: true, defaultAgentProvider: true } },
    },
  });
  if (!row?.instanceId || !row.instance) return null;
  return { ...row, instanceId: row.instanceId, instance: row.instance };
}

type SetupRow = NonNullable<Awaited<ReturnType<typeof loadSetupRow>>>;

function mainAgentWorkflow(row: SetupRow) {
  return row.workflows.find(w => w.type === 'agent' && w.workstream.name === 'main') ?? null;
}

function mainProvider(row: SetupRow): string {
  return resolveAgentProvider(mainAgentWorkflow(row)?.provider, row.user.defaultAgentProvider);
}

function setupSnapshot(row: SetupRow, status: SetupStatus) {
  return { status, attempt: row.setupAttempt, provider: mainProvider(row), hasRepo: row.repoUrl !== null };
}

function projectDir(row: SetupRow): string {
  return tmux.projectDirFor({ name: row.name, user: row.user, instance: row.instance }, 'main');
}

/**
 * The static layout's checkout for this project's clone (services/staticLayout.ts), or null for the project's own
 * directory: only on a box made from an environment for it, whose agent can.
 */
async function staticDirFor(row: SetupRow): Promise<string | null> {
  if (row.dir) return row.dir;
  const view = agentView(row.instanceId);
  const capabilities = view.kind === 'present' ? view.capabilities : [];
  const others = row.environmentId
    ? await prisma.project.count({ where: { instanceId: row.instanceId, archived: false, id: { not: row.id } } })
    : 0;
  const decision = staticLayoutDecision(row, row.instance, capabilities, others);
  if (!decision.use) {
    if (row.environmentId && decision.why !== 'not-first') console.log(`[CLONE] ${row.id}: not the static layout (${decision.why})`);
    return null;
  }
  const name = staticRepoName(row);
  if (!name) {
    console.log(`[CLONE] ${row.id}: not the static layout (its environment's definition can't be read, so its path is unknown)`);
    return null;
  }
  const home = resolveProjectRoot({ ownerUnixUser: row.user.unixUsername, hostHome: row.instance.hostHome });
  const dir = staticCheckoutDir(home, name);
  // Never a path another project on the box records, an archived one's included: its checkout is that project's.
  if (!dir || await prisma.project.count({ where: { instanceId: row.instanceId, dir, id: { not: row.id } } }) > 0) return null;
  return dir;
}

/**
 * `deferDeliveryWait` is project create's (routes/projects.ts) on a box that
 * is already up: when the checkout would first wait for the box's GitHub
 * delivery (waitForPaneDelivery, up to 30 s), the request does not. The wait
 * and the event go on here and the create answers at once, so the session
 * opens and shows its checkout as pending while it happens.
 */
export async function applySetupEvent(target: SetupTarget, event: SetupEvent, opts: { deferDeliveryWait?: boolean } = {}): Promise<SetupOutcome> {
  // A box just claimed from the pool is updating (claimUpdate.ts), and may
  // restart its agent: the clone or checkout waits for it in the background,
  // with the capabilities the agent has after it, and the create answers now.
  if (event.kind === 'agent-connected' && claimUpdateRunning(target.instanceId)) {
    void claimUpdateSettled(target.instanceId).then(() => {
      const now = agentView(target.instanceId);
      if (now.kind !== 'present') return;
      return applySetupEvent(target, { kind: 'agent-connected', capabilities: now.capabilities }, opts);
    }).catch(err => {
      console.error(`[CLONE] ${target.projectId}: setup after the claim update failed: ${(err as Error).message}`);
    });
    return { kind: 'deferred' };
  }
  if (event.kind === 'agent-connected') {
    if (opts.deferDeliveryWait && await pendingPaneDelivery(target, event)) {
      void applySetupEvent(target, event).catch(err => {
        console.error(`[CLONE] ${target.projectId}: deferred setup failed: ${(err as Error).message}`);
      });
      return { kind: 'deferred' };
    }
    await waitForPaneDelivery(target, event);
  }
  const outcome = await serialize(target.projectId, () => applyNow(target, event));
  if (outcome.kind === 'ignored') {
    console.log(`[CLONE] ${target.projectId}: ${event.kind} ignored: ${outcome.why}`);
  }
  return outcome;
}

/**
 * The pane checkout reads the box's GitHub broker, so a managed box waits for
 * delivery first, as the inline checkout always has. Waited outside the
 * project's queue, so a report for the same project is not held behind it;
 * the decision is made again on a fresh row once the wait is over.
 */
async function waitForPaneDelivery(target: SetupTarget, event: SetupEvent): Promise<void> {
  const pending = await pendingPaneDelivery(target, event);
  if (!pending) return;
  const settled = await waitForPaneCheckout(pending.read, { expectGithub: pending.expectGithub });
  if (settled === 'timeout') {
    console.warn(`[CLONE] ${pending.projectId}: pane checkout proceeded before GitHub delivery settled`);
  }
}

/** What waitForPaneDelivery would wait on, or null when the pane checkout may go now (or there is none). */
async function pendingPaneDelivery(target: SetupTarget, event: SetupEvent) {
  const row = await loadSetupRow(target);
  const status = row && toSetupStatus(row.setupStatus);
  if (!row || !status) return null;
  const decision = decideSetup(setupSnapshot(row, status), event);
  if (decision.kind !== 'move' || !decision.effects.includes('pane-checkout')) return null;
  if (!shouldWaitForPaneCheckout({
    hasRepo: row.repoUrl !== null,
    managed: isManagedBox(row.instance),
    hasGithubCredential: await hasGithubCredential(row.userId),
  })) return null;
  const read = () => prisma.instance.findUnique({
    where: { id: row.instanceId },
    select: { githubDeliveredAt: true, onClaimStatus: true },
  });
  const expectGithub = deliversGithub();
  if (paneCheckoutReady(await read(), { expectGithub })) return null;
  return { projectId: row.id, read, expectGithub };
}

async function applyNow(target: SetupTarget, event: SetupEvent): Promise<SetupOutcome> {
  const row = await loadSetupRow(target);
  if (!row) return { kind: 'ignored', why: 'no live project on that box' };
  // With no repoUrl it would read as an empty project and launch in a root
  // that has no marker yet, which tmux-create would git-init.
  if (row.layout === 'workspace') return { kind: 'ignored', why: 'a multi-repo project is set up by workspaceSetup' };
  const status = toSetupStatus(row.setupStatus);
  if (!status) return { kind: 'ignored', why: `unknown setup status ${row.setupStatus}` };

  const decision = decideSetup(setupSnapshot(row, status), event);
  if (decision.kind === 'ignore') return { kind: 'ignored', why: decision.why };
  if (decision.kind === 'refuse') return { kind: 'refused', error: decision.error };

  const admission: SetupAdmission = { projectId: row.id, from: decision.from };
  let move = decision;
  for (const effect of decision.effects) {
    const result = await runEffect(effect, row, admission);
    if (!result.ok) {
      move = effectFailure(decision.from, result.error);
      break;
    }
  }

  if (move.write) {
    // A launch that ran used the replay the create left on the row; one that
    // did not keeps it for the retry.
    const launched = move === decision && decision.effects.includes('launch') && row.launchReplaySessionId !== null;
    const { count } = await prisma.project.updateMany({
      where: {
        id: row.id, instanceId: row.instanceId, archived: false,
        setupStatus: move.from, setupAttempt: row.setupAttempt,
      },
      data: { ...projectData(move.write), ...(launched ? { launchReplaySessionId: null } : {}) },
    });
    if (count === 0) return { kind: 'ignored', why: 'row moved' };
    if (move.mainBranch) {
      await prisma.workstream.updateMany({
        where: { projectId: row.id, name: 'main' },
        data: { branch: move.mainBranch },
      });
    }
  }
  const attempt = move.write?.bumpAttempt ? row.setupAttempt + 1 : row.setupAttempt;
  console.log(`[CLONE] ${row.id} on ${row.instanceId}: ${move.from} -> ${move.to} (attempt ${attempt})`);
  return { kind: 'applied', from: move.from, to: move.to };
}

function projectData(write: SetupWrite): Prisma.ProjectUpdateManyMutationInput {
  const { bumpAttempt, ...columns } = write;
  return bumpAttempt ? { ...columns, setupAttempt: { increment: 1 } } : columns;
}

type EffectResult = { ok: true } | { ok: false; error: string };

const DONE: EffectResult = { ok: true };
const NO_REPOSITORY: EffectResult = { ok: false, error: 'This project has no repository to clone. Start it empty.' };

async function runEffect(effect: SetupEffect, row: SetupRow, admission: SetupAdmission): Promise<EffectResult> {
  const host = { userId: row.userId, instanceId: row.instanceId };
  switch (effect) {
    case 'dispatch': {
      if (!row.repoUrl) return NO_REPOSITORY;
      const home = resolveProjectRoot({ ownerUnixUser: row.user.unixUsername, hostHome: row.instance.hostHome });
      const referenceDir = templateForRepoUrl(row.repoUrl)?.referenceDir?.replace(/^\$HOME(?=\/|$)/, () => home);
      const staticDir = await staticDirFor(row);
      const payload = {
        projectId: row.id,
        instanceId: row.instanceId,
        dir: projectDir(row),
        url: row.repoUrl,
        branch: row.workstreams[0]?.branch ?? 'HEAD',
        attempt: row.setupAttempt,
        sizeKb: null,
        ...(referenceDir ? { referenceDir } : {}),
        ...(staticDir ? { staticDir } : {}),
      };
      try {
        const answer = await sendToInstanceAgent(row.instanceId, 'project-clone', payload, CLONE_RPC_TIMEOUT_MS) as { staticLayout?: unknown; staticRefused?: unknown } | null;
        // The box took the static path, or kept the project's own directory (a path already taken there): record which.
        if (staticDir && answer?.staticLayout === true && row.dir !== staticDir) {
          await prisma.project.update({ where: { id: row.id }, data: { dir: staticDir } });
          console.log(`[CLONE] ${row.id}: checkout at ${staticDir}, linked from ${projectDir(row)}`);
        } else if (staticDir && answer && answer.staticLayout !== true) {
          // Refused (the path is taken on this box, say a project moved onto one that has it), or an agent that ignores
          // staticDir: the clone goes to the project's own directory, so a recorded static path is forgotten and the
          // launch's environment steps run there.
          console.warn(`[CLONE] ${row.id}: not the static layout: ${String(answer.staticRefused ?? 'the box did not take it')}`);
          if (row.dir) {
            await prisma.project.updateMany({ where: { id: row.id, instanceId: row.instanceId, dir: row.dir }, data: { dir: null } });
            row.dir = null;
          }
        }
      } catch (err) {
        // The move writes nothing, so the next hello sends it again.
        console.error(`[CLONE] ${row.id}: project-clone to ${row.instanceId} failed:`, (err as Error).message);
      }
      return DONE;
    }
    case 'pane-checkout': {
      if (!row.repoUrl) return NO_REPOSITORY;
      if (!mainAgentWorkflow(row)) {
        return { ok: false, error: 'This project has no agent to run the checkout in. Start it empty.' };
      }
      const outcome = await ensureAgentSessionsAndLaunch({
        userId: row.userId,
        unixUsername: row.user.unixUsername,
        projectName: row.name,
        provider: mainProvider(row),
        instanceId: row.instanceId,
        workstream: 'main',
        hostHome: row.instance.hostHome,
        preLaunch: buildCloneCommand(row.repoUrl, templateForRepoUrl(row.repoUrl)?.referenceDir, {
          blankGlobalGitconfig: isManagedBox(row.instance),
        }),
        admission,
      });
      if (outcome !== 'unknown') return DONE;
      return {
        ok: false,
        error: "The box's agent did not say whether the terminal was free, so the checkout was not typed. Retry it or start empty.",
      };
    }
    case 'launch': {
      for (const wf of row.workflows) {
        const workstream = wf.workstream.name;
        if (wf.type === 'agent') {
          const outcome = await ensureAgentSessionsAndLaunch({
            userId: row.userId,
            unixUsername: row.user.unixUsername,
            projectName: row.name,
            provider: resolveAgentProvider(wf.provider, row.user.defaultAgentProvider),
            instanceId: row.instanceId,
            workstream,
            hostHome: row.instance.hostHome,
            // The replay the create came from, kept on the row for this
            // deferred launch; the commit below clears it.
            replaySessionId: workstream === 'main' ? row.launchReplaySessionId : null,
            admission,
          });
          // The sessions exist by now, so the move commits even when the probe
          // left the agent untyped, as every other launch path does.
          if (outcome === 'unknown') {
            console.warn(`[CLONE] ${row.id}: ${row.name}/${workstream} launched without typing the agent: its pane could not be read`);
          }
        } else {
          const cwd = tmux.projectDirFor({ name: row.name, user: row.user, instance: row.instance }, workstream);
          for (const role of ['data', 'data-ctrl'] as const) {
            await sendForProject(host, 'tmux-create', {
              sessionName: tmux.sessionName(row.user.unixUsername, row.name, role, workstream), cwd,
            });
          }
        }
      }
      // The environment file's steps, on a box made for this project (services/projectEnvironment.ts).
      // Its real checkout, so the box keys the steps by ~/code/<repo> in the static layout (the agent resolves a link too).
      void startEnvironmentAfterClone({ ...row, dir: row.dir ?? projectDir(row) });
      return DONE;
    }
    case 'empty-dir': {
      const dir = projectDir(row);
      // Starting empty (a chosen start, or after a failed clone) abandons the
      // repository: clear it so a chat does not wait forever for a checkout
      // that will never land (chatRequireCheckout keys off repoUrl).
      // Its static checkout, if it had one, is abandoned with it: the project's own directory is what it has now.
      const abandoned = row.dir;
      if (row.repoUrl !== null || row.dir !== null) {
        await prisma.project.update({ where: { id: row.id }, data: { repoUrl: null, repoDefaultBranch: null, dir: null } });
        // The effects after this one (start empty's launch, its environment-up) read this row, not the database.
        Object.assign(row, { repoUrl: null, repoDefaultBranch: null, dir: null });
      }
      // The project directory may be the static layout's link into that checkout: the box removes the link first,
      // so the empty directory is the project's own and init-wiki never writes into the clone, which stays on disk.
      await sendForProject(host, 'mkdir', { dir, ...(abandoned ? { dropLinkTo: abandoned } : {}) });
      sendForProject(host, 'init-wiki', { dir, slug: row.name, username: row.user.unixUsername }).catch(() => {});
      return DONE;
    }
  }
}

/**
 * The sessions of every workflow the project has, as a finished clone starts
 * them: what a multi-repo project's last repository landing runs
 * (services/workspaceSetup.ts). `admission` lets the launch through while the
 * aggregate status is still leaving `from`.
 */
export async function launchProjectSessions(target: SetupTarget, admission: SetupAdmission): Promise<boolean> {
  const row = await loadSetupRow(target);
  if (!row) return false;
  const result = await runEffect('launch', row, admission);
  return result.ok;
}

/**
 * Drive every project on this box that is still waiting for, or in the middle
 * of, its clone. Runs on each hello: the box's agent may have restarted
 * mid-clone, or may only now have connected for a project picked while the
 * box was cold. The clone RPC is idempotent on the box, keyed by attempt.
 */
export async function redispatchClones(ev: BoxAgentHelloEvent): Promise<void> {
  await ev.settled;
  const rows = await prisma.project.findMany({
    where: {
      instanceId: ev.instance.id, userId: ev.user.id, archived: false,
      setupStatus: { in: ['pending', 'cloning'] },
    },
    select: { id: true, layout: true },
  });
  // A multi-repo project's repositories are driven by services/workspaceSetup.ts.
  await Promise.all(rows.filter(r => r.layout !== 'workspace').map(async ({ id }) => {
    const live = agentView(ev.instance.id);
    if (live.kind !== 'present') return;
    try {
      await applySetupEvent({ projectId: id, instanceId: ev.instance.id }, {
        kind: 'agent-connected', capabilities: live.capabilities,
      });
    } catch (err) {
      console.error(`[CLONE] ${id}: redispatch on ${ev.instance.id} failed:`, (err as Error).message);
    }
  }));
}

function onCloneStatus({ instance, msg }: BoxAgentFrame): void {
  // One repository of a multi-repo project: services/workspaceSetup.ts.
  if (msg && typeof msg === 'object' && 'repo' in msg && (msg as { repo?: unknown }).repo != null) return;
  const frame = parseCloneStatusFrame(msg);
  if (!frame) {
    console.warn(`[CLONE] dropped an unreadable project-clone-status from ${instance.id}`);
    return;
  }
  if (frame.instanceId !== instance.id) {
    console.warn(`[CLONE] dropped ${frame.projectId}'s status from ${instance.id}: it names box ${frame.instanceId}`);
    return;
  }
  applySetupEvent({ projectId: frame.projectId, instanceId: instance.id }, {
    kind: 'report', attempt: frame.attempt, report: frame.report,
  }).catch(err => {
    console.error(`[CLONE] ${frame.projectId}: applying ${frame.report.status} from ${instance.id} failed:`, (err as Error).message);
  });
}

/**
 * Every process listens, not just the lease holder: a box's hello and its
 * reports arrive on whichever process holds its socket.
 */
export function startProjectClone(): () => void {
  const offHello = onBoxAgentHello(ev => {
    redispatchClones(ev).catch(err => {
      console.error(`[CLONE] redispatch on ${ev.instance.id} failed:`, (err as Error).message);
    });
  });
  const offFrame = onBoxAgentFrame('project-clone-status', onCloneStatus);
  return () => { offHello(); offFrame(); };
}
