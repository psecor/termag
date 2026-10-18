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
import { hasGithubCredential } from './boxCreationGate';
import { isManagedBox } from './instanceLifecycle';
import { shouldWaitForPaneCheckout, waitForPaneCheckout } from './paneCheckout';
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

export interface SetupTarget {
  projectId: string;
  instanceId: string;
}

export type SetupOutcome =
  | { kind: 'applied'; from: SetupStatus; to: SetupStatus }
  | { kind: 'ignored'; why: string }
  | { kind: 'refused'; error: string };

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

export async function applySetupEvent(target: SetupTarget, event: SetupEvent): Promise<SetupOutcome> {
  if (event.kind === 'agent-connected') await waitForPaneDelivery(target, event);
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
  const row = await loadSetupRow(target);
  const status = row && toSetupStatus(row.setupStatus);
  if (!row || !status) return;
  const decision = decideSetup(setupSnapshot(row, status), event);
  if (decision.kind !== 'move' || !decision.effects.includes('pane-checkout')) return;
  if (!shouldWaitForPaneCheckout({
    hasRepo: row.repoUrl !== null,
    managed: isManagedBox(row.instance),
    hasGithubCredential: await hasGithubCredential(row.userId),
  })) return;
  const settled = await waitForPaneCheckout(() => prisma.instance.findUnique({
    where: { id: row.instanceId },
    select: { githubDeliveredAt: true, onClaimStatus: true },
  }));
  if (settled === 'timeout') {
    console.warn(`[CLONE] ${row.id}: pane checkout proceeded before GitHub delivery settled`);
  }
}

async function applyNow(target: SetupTarget, event: SetupEvent): Promise<SetupOutcome> {
  const row = await loadSetupRow(target);
  if (!row) return { kind: 'ignored', why: 'no live project on that box' };
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
      const payload = {
        projectId: row.id,
        instanceId: row.instanceId,
        dir: projectDir(row),
        url: row.repoUrl,
        branch: row.workstreams[0]?.branch ?? 'HEAD',
        attempt: row.setupAttempt,
        sizeKb: null,
        ...(referenceDir ? { referenceDir } : {}),
      };
      try {
        await sendToInstanceAgent(row.instanceId, 'project-clone', payload, CLONE_RPC_TIMEOUT_MS);
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
      return DONE;
    }
    case 'empty-dir': {
      const dir = projectDir(row);
      // Starting empty (a chosen start, or after a failed clone) abandons the
      // repository: clear it so a chat does not wait forever for a checkout
      // that will never land (chatRequireCheckout keys off repoUrl).
      if (row.repoUrl !== null) {
        await prisma.project.update({ where: { id: row.id }, data: { repoUrl: null, repoDefaultBranch: null } });
      }
      await sendForProject(host, 'mkdir', { dir });
      sendForProject(host, 'init-wiki', { dir, slug: row.name, username: row.user.unixUsername }).catch(() => {});
      return DONE;
    }
  }
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
    select: { id: true },
  });
  await Promise.all(rows.map(async ({ id }) => {
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
