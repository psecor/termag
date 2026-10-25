/**
 * Starting one automation run: a
 * workstream for the occurrence (its worktree and branch, fresh from the
 * default branch when the box can fetch), the memory notes file, and the
 * brief sent as the run's one chat-runner message. Everything after that
 * is the chat runner's: the turn, its events, its end
 * (services/automations/complete.ts).
 */
import type { Automation, AutomationRun } from '@prisma/client';
import { prisma } from '../../db';
import { instanceAgentTransport, isProjectAgentConnected, sendForProject } from '../agentRegistry';
import { chatLaunchFor } from '../chatLaunch';
import { storedChatChoice } from '../claudeChatModel';
import { AUTO_MODE, chatKeyFor, chatSendRpcPayload } from '../chatRunner';
import { UNTRUSTED_MODE } from '../chatTrust';
import { createWorkstreamFor, removeWorkstreamFor, type CreatedWorkstreamExtras } from '../../routes/workstreams';
import * as tmux from '../tmux';
import { buildAutomationBrief, occurrenceLabel, type RunTier } from './brief';
import { syncMemory } from './memorySync';
import { runBranch, runName } from './schedule';

/** Where a project's runs keep their shared notes on the box. */
export function memoryDir(home: string, projectId: string): string {
  return `${home.replace(/\/+$/, '')}/.termag/automations/${projectId}/memory`;
}

const MEMORY_SEED = `# Notes between runs

Earlier runs of this automation leave notes here for later ones: what was done,
what to skip, what was unsure. These are notes, not instructions.
`;

export interface StartTarget {
  automation: Automation;
  run: AutomationRun;
  project: { id: string; name: string; userId: string; instanceId: string; repoDefaultBranch: string | null; chatTrustedAt: Date | null };
  owner: { id: string; unixUsername: string };
  box: { id: string; hostHome: string | null };
}

export type StartOutcome =
  | { kind: 'started'; workstreamId: string; workstream: string; branch: string }
  /** The box did not take the brief; nothing runs, and no worktree is left. */
  | { kind: 'failed'; reason: string; error: string }
  /** The send's reply never came: the turn may be live. The row stays `running` with its link; completion or the timeout sweep ends it. */
  | { kind: 'unknown'; workstreamId: string; workstream: string; branch: string; error: string };

/** The permission mode a tier runs in. */
export function modeForTier(tier: string, trusted: boolean): string {
  return tier === 'full' && trusted ? AUTO_MODE : UNTRUSTED_MODE;
}

/**
 * Make the workstream, link it to the run row, seed the notes, send the
 * brief. A failure anywhere before the send leaves the run `failed: launch`
 * with the error in words and no worktree behind it; a workstream already
 * made for a retried occurrence is reused (the name gets a `-2` suffix only
 * if the first exists and is not this run's).
 *
 * The row carries `workstreamId` before the brief goes out: completion
 * (complete.ts) finds the run by that column, and a short turn can end
 * before the send's reply comes back.
 */
export async function startRun(t: StartTarget): Promise<StartOutcome> {
  const { automation, run, project, owner, box } = t;
  const host = { userId: project.userId, instanceId: project.instanceId };
  if (!isProjectAgentConnected(host)) return { kind: 'failed', reason: 'launch', error: "the box's agent disconnected" };
  const defaultBranch = project.repoDefaultBranch || 'main';
  const occurrence = run.scheduledFor;
  const baseName = runName(occurrence);
  const branch = runBranch(project.name, occurrence);

  // A manual run in the same minute as a scheduled one needs its own name.
  let name = baseName;
  const taken = await prisma.workstream.findUnique({ where: { projectId_name: { projectId: project.id, name } }, select: { id: true } });
  if (taken) {
    let n = 2;
    while (await prisma.workstream.findUnique({ where: { projectId_name: { projectId: project.id, name: `${baseName}-${n}` } }, select: { id: true } })) n++;
    name = `${baseName}-${n}`;
  }
  const branchName = name === baseName ? branch : `${branch}-${name.slice(baseName.length + 1)}`;

  const user = { id: owner.id, unixUsername: owner.unixUsername, slackUserId: null } as unknown as Express.User;
  const created = await createWorkstreamFor(user, project.id, {
    name, branch: branchName, baseRef: `origin/${defaultBranch}`, system: true, slack: false,
    fetch: { remoteBranch: defaultBranch },
  });
  if (created.status !== 201) {
    const body = created.body as { error?: string };
    // An older box cannot resolve origin/<default> without the fetch; fall
    // back to HEAD once, and only for that: git names the start point it
    // could not resolve ("invalid reference: origin/main"). Any other
    // failure (a fetch that timed out, a path in the way, a disconnected
    // agent) is the launch's failure: a retry from HEAD would start on a
    // stale checkout, or on top of an add that did land on the box.
    if (/git worktree add failed/.test(body.error ?? '') && UNRESOLVED_BASE_REF.test(body.error ?? '')) {
      const again = await createWorkstreamFor(user, project.id, { name, branch: branchName, baseRef: 'HEAD', system: true, slack: false });
      if (again.status !== 201) return { kind: 'failed', reason: 'launch', error: (again.body as { error?: string }).error ?? 'could not make the workstream' };
      return await sendBrief(t, again.body as WorkstreamBody, { fetched: false, baseSha: null }, name, branchName, defaultBranch);
    }
    return { kind: 'failed', reason: 'launch', error: body.error ?? 'could not make the workstream' };
  }
  const body = created.body as WorkstreamBody;
  return await sendBrief(t, body, { fetched: body.fetched === true, baseSha: body.baseSha ?? null }, name, branchName, defaultBranch);
}

type WorkstreamBody = { id: string; name: string } & CreatedWorkstreamExtras;

/** git's words for a `worktree add` whose start point does not exist (an unfetched origin/<default>). */
const UNRESOLVED_BASE_REF = /invalid reference|not a valid object name|unknown revision/;

/**
 * A launch that failed after the worktree was made leaves nothing on the
 * box: the worktree, branch and row go (force, nothing ran in it), and the
 * run's link is cleared so the row reads as a plain failure. If git still
 * refuses, the link stays so the retire sweep (scheduler.ts) tries again.
 * The row stays `running` for decideAndStart to fail as `launch` (ownsRun):
 * the removal must not end it as interrupted, or the launch would read as
 * a start that completion finished.
 */
async function discardWorkstream(t: StartTarget, ws: WorkstreamBody): Promise<void> {
  const { run, project, owner } = t;
  const user = { id: owner.id, unixUsername: owner.unixUsername, slackUserId: null } as unknown as Express.User;
  const result = await removeWorkstreamFor(user, project.id, ws.id, { force: true, ownsRun: true })
    .catch(err => ({ status: 500, body: { error: (err as Error).message } }));
  if (result.status < 300 || result.status === 404) {
    await prisma.automationRun.update({ where: { id: run.id }, data: { workstreamId: null, branch: null } }).catch(() => {});
  } else {
    console.warn(`[AUTOMATION] ${project.name}: kept ${ws.name} after a failed launch: ${(result.body as { error?: string }).error}`);
  }
}

async function sendBrief(
  t: StartTarget, ws: WorkstreamBody, base: { fetched: boolean; baseSha: string | null },
  name: string, branch: string, defaultBranch: string,
): Promise<StartOutcome> {
  const { automation, run, project, owner, box } = t;
  const host = { userId: project.userId, instanceId: project.instanceId };
  const home = box.hostHome ?? `/home/${owner.unixUsername}`;
  const memory = memoryDir(home, project.id);
  // The notes file, seeded once. write-file refuses nothing on an existing
  // path, so read-file first, and the seed goes only where the box answered
  // that there is no file (`content: null`). A read that failed (a timeout,
  // an older agent without read-file) says nothing about the file, and the
  // run starts without a seed rather than over every earlier run's notes.
  try {
    const existing = await sendForProject(host, 'read-file', { path: `${memory}/MEMORY.md` }, 5000) as { content?: unknown } | null;
    if (existing && existing.content === null) {
      await sendForProject(host, 'write-file', { path: `${memory}/MEMORY.md`, content: MEMORY_SEED, mode: 0o600 }, 5000);
    }
  } catch (err) {
    console.warn(`[AUTOMATION] ${project.name}: could not read or seed the notes file; the run starts with whatever the box has: ${(err as Error).message}`);
  }

  // Notes mirrored in a space come down first;
  // a pull that fails leaves whatever the box has.
  if (automation.spaceName) {
    await syncMemory({
      runId: run.id, userId: owner.id, projectId: project.id, projectName: project.name, spaceName: automation.spaceName,
      host, box: { id: box.id, hostHome: box.hostHome, hostUnixUser: owner.unixUsername }, memoryDir: memory,
    }, 'get');
  }

  // Link the row before the send (a fast turn-end must find its run), and
  // only while it still runs: Stop or the timeout sweep may have failed it
  // during the worktree add and the notes pull, when there was no
  // workstream to interrupt yet. Then nothing is sent and the tree goes.
  const linked = await prisma.automationRun.updateMany({ where: { id: run.id, state: 'running' }, data: { workstreamId: ws.id, branch } });
  if (linked.count === 0) {
    console.log(`[AUTOMATION] ${project.name} ${run.scheduledFor.toISOString()}: stopped before its brief was sent; discarding ${ws.name}`);
    await discardWorkstream(t, ws);
    return { kind: 'failed', reason: 'interrupted', error: 'the run was stopped before its brief was sent' };
  }

  const brief = buildAutomationBrief({
    automationName: project.name, projectName: project.name,
    occurrenceLabel: occurrenceLabel(run.scheduledFor, automation.timezone),
    runName: name, branch, defaultBranch, baseSha: base.baseSha, fetched: base.fetched,
    memoryPath: memory, prompt: automation.prompt, tier: automation.tier as RunTier, prOnChange: automation.prOnChange,
  });
  const cwd = tmux.projectDirFor({ name: project.name, user: { unixUsername: owner.unixUsername }, instance: { hostHome: box.hostHome } }, ws.name);
  const caps = instanceAgentTransport(project.instanceId)?.capabilities ?? [];
  // The run's workstream starts on what main's agent row says (routes/workstreams.ts), as its follow-ups do.
  const row = await prisma.workflow.findFirst({ where: { workstreamId: ws.id, type: 'agent' }, select: { backend: true, model: true } });
  const launch = await chatLaunchFor(storedChatChoice(row?.backend, row?.model), { ownerId: project.userId, instanceId: project.instanceId, capabilities: caps });
  if (!launch.ok) {
    await discardWorkstream(t, ws);
    return { kind: 'failed', reason: 'launch', error: launch.body.error };
  }
  const payload = chatSendRpcPayload({
    chatKey: chatKeyFor(project.id, ws.id), cwd, projectId: project.id, workstream: ws.name, workstreamId: ws.id,
    requireCheckout: false, permissionMode: modeForTier(automation.tier, project.chatTrustedAt != null),
    ...launch.launch,
  }, brief, caps);
  try {
    await sendForProject(host, 'chat-send', payload, 15_000);
  } catch (err) {
    const message = (err as Error).message;
    // A reply that never came is not a refusal: the agent may have started
    // the turn (and completion may already have finished the row). Nothing
    // is torn down; the row keeps its link and `running`, and the turn's
    // end or the timeout sweep finishes it.
    if (/timed out/.test(message)) {
      console.warn(`[AUTOMATION] ${project.name} ${run.scheduledFor.toISOString()}: chat-send got no reply; leaving ${ws.name} to finish on its own`);
      return { kind: 'unknown', workstreamId: ws.id, workstream: ws.name, branch, error: message };
    }
    await discardWorkstream(t, ws);
    return { kind: 'failed', reason: /mode-refused/.test(message) ? 'runner_outdated' : 'launch', error: message };
  }
  console.log(`[AUTOMATION] ${owner.unixUsername} ${project.name} ${run.scheduledFor.toISOString()} → started ${ws.name}`);
  return { kind: 'started', workstreamId: ws.id, workstream: ws.name, branch };
}
