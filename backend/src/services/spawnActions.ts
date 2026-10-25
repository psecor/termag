/**
 * Park, resume and retire one spawned agent: the
 * acts behind the lifecycle sweep, the parent's dismiss_spawn and the owner's
 * buttons. The rules are services/spawnLifecycle.ts.
 */
import type { AgentSpawn } from '@prisma/client';
import { prisma } from '../db';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { ensureAgentSessionsAndLaunch, paneLockKey, resolveAgentProvider, stopAgentPane, withPaneLock } from './agentRuntime';
import { recordSpawnEvent } from './spawnEvents';
import { setStatus } from './status';
import * as tmux from './tmux';
import { powerStateError } from './boxPowerPolicy';
import { branchStateFromRpc, retireCheck, type RetireCheck } from './spawnLifecycle';
import { archiveOwnedProject } from '../routes/projects';
import { removeWorkstreamFor } from '../routes/workstreams';

export type ActionBy = 'sweep' | 'parent' | 'owner';
export type ActionResult = { ok: true; detail?: string } | { ok: false; status: number; error: string };

async function child(s: AgentSpawn) {
  if (!s.childProjectId) return null;
  const project = await prisma.project.findFirst({
    where: { id: s.childProjectId, userId: s.userId },
    include: {
      user: true,
      instance: { select: { hostHome: true, status: true } },
      workstreams: { where: { name: s.childWorkstream }, include: { workflows: true } },
    },
  });
  const ws = project?.workstreams[0];
  if (!project || !ws) return null;
  const provider = resolveAgentProvider(ws.workflows.find(w => w.type === 'agent')?.provider ?? s.provider, project.user.defaultAgentProvider);
  return { project, ws, provider, host: { userId: s.userId, instanceId: project.instanceId } };
}

type Child = NonNullable<Awaited<ReturnType<typeof child>>>;

/**
 * Why the child's box cannot be acted on now, or null: a stopping, stopped,
 * starting or hibernating box (its agent can stay connected while it powers
 * down, and work started there dies with it), or no connected agent.
 */
function boxRefusal(c: Child): ActionResult | null {
  const parked = c.project.instance ? powerStateError(c.project.instance.status) : null;
  if (parked) return { ok: false, status: 409, error: parked };
  if (c.project.instanceId && !isProjectAgentConnected(c.host)) return { ok: false, status: 503, error: 'Box agent is not connected' };
  return null;
}

export async function parkSpawn(s: AgentSpawn, by: ActionBy): Promise<ActionResult> {
  if (s.retiredAt) return { ok: false, status: 409, error: 'this spawn is already retired' };
  if (s.parkedAt) return { ok: true, detail: 'already parked' };
  const c = await child(s);
  if (!c) return { ok: false, status: 404, error: 'its workstream is gone' };
  const refused = boxRefusal(c);
  if (refused) return refused;
  // Stamp first, then stop: a reconnect between the two must already see the
  // spawn as parked, or reconstruction would relaunch the CLI just stopped.
  const stamp = new Date();
  const claimed = await prisma.agentSpawn.updateMany({ where: { id: s.id, parkedAt: null, retiredAt: null }, data: { parkedAt: stamp } });
  if (claimed.count !== 1) return { ok: true, detail: 'already parked' };
  try {
    await stopAgentPane({
      userId: s.userId, unixUsername: c.project.user.unixUsername, projectName: c.project.name,
      provider: c.provider, instanceId: c.project.instanceId, workstream: c.ws.name,
    });
  } catch (err) {
    // Only the stamp this park wrote: a resume, or another park, may have moved it since.
    await prisma.agentSpawn.updateMany({ where: { id: s.id, parkedAt: stamp }, data: { parkedAt: null } }).catch(() => {});
    return { ok: false, status: 503, error: `could not stop its agent: ${(err as Error).message}` };
  }
  // Killing the pane posts no status of its own: say so, or its last `idle`
  // would read as a live pane and hold off the retire for good.
  setStatus(tmux.sessionName(c.project.user.unixUsername, c.project.name, 'agent', c.ws.name), 'not_running', { milestone: null }, undefined, c.project.instanceId);
  console.log(`[SPAWN] parked ${s.childProjectName}/${s.childWorkstream} (${by}, ${s.id})`);
  await recordSpawnEvent({ kind: 'parked', spawnId: s.id, rootSpawnId: s.rootSpawnId, userId: s.userId, reason: by, instanceId: c.project.instanceId });
  return { ok: true };
}

export async function resumeSpawn(s: AgentSpawn): Promise<ActionResult> {
  if (s.retiredAt) return { ok: false, status: 409, error: 'this spawn is retired: its workstream is gone' };
  if (!s.parkedAt) return { ok: true, detail: 'not parked' };
  const c = await child(s);
  if (!c) return { ok: false, status: 404, error: 'its workstream is gone' };
  const refused = boxRefusal(c);
  if (refused) return refused;
  // Unpark first, so the reconnect skip no longer applies to the pane being launched.
  // Only the park we read: a concurrent resume (or a new park) owns any other state.
  const unparked = await prisma.agentSpawn.updateMany({
    where: { id: s.id, parkedAt: s.parkedAt, retiredAt: null }, data: { parkedAt: null, keptReason: null, endedAt: null },
  });
  if (unparked.count !== 1) return { ok: false, status: 409, error: 'it changed meanwhile (resumed, parked or retired): try again' };
  try {
    await ensureAgentSessionsAndLaunch({
      userId: s.userId, unixUsername: c.project.user.unixUsername, projectName: c.project.name, provider: c.provider,
      instanceId: c.project.instanceId, workstream: c.ws.name, hostHome: c.project.instance?.hostHome ?? null, resume: true,
    });
  } catch (err) {
    // Put the park back only if nothing parked it again meanwhile.
    await prisma.agentSpawn.updateMany({ where: { id: s.id, parkedAt: null, retiredAt: null }, data: { parkedAt: s.parkedAt } }).catch(() => {});
    return { ok: false, status: 503, error: `could not start it again: ${(err as Error).message}` };
  }
  await recordSpawnEvent({ kind: 'resumed', spawnId: s.id, rootSpawnId: s.rootSpawnId, userId: s.userId, instanceId: c.project.instanceId });
  return { ok: true };
}

/** The child checkout's state and whether it could be removed without losing work. */
export async function checkoutCheck(s: AgentSpawn): Promise<RetireCheck> {
  const c = await child(s);
  if (!c) return { ok: true, why: 'nothing_beyond_base' }; // nothing left to lose
  const refused = boxRefusal(c);
  if (refused && !refused.ok) return { ok: false, reason: `its box is unavailable (${refused.error})` };
  const cwd = tmux.projectDirFor(c.project, c.ws.name);
  // verifyRemote: origin itself must confirm the branch holds HEAD (ls-remote), so allow for it.
  // base: what it was spawned from, so a local-only checkout can be counted without origin (#453).
  const raw = await sendForProject(c.host, 'git-branch-state', { cwd, verifyRemote: true, ...(s.baseSha ? { base: s.baseSha } : {}) }, 20_000).catch(() => null);
  return retireCheck(branchStateFromRpc(raw));
}

/**
 * Remove the child's workstream (or archive its project, for a project
 * target), after `check` said nothing would be lost. Git refuses a dirty tree
 * and an unmerged branch on its own too: the remove never forces.
 */
export async function retireSpawn(s: AgentSpawn, by: ActionBy, check: RetireCheck): Promise<ActionResult> {
  if (s.retiredAt) return { ok: true, detail: 'already retired' };
  if (!check.ok) {
    if (s.keptReason !== check.reason) {
      await prisma.agentSpawn.update({ where: { id: s.id }, data: { keptReason: check.reason } });
      await recordSpawnEvent({ kind: 'retire_refused', spawnId: s.id, rootSpawnId: s.rootSpawnId, userId: s.userId, reason: by, instanceId: s.childInstanceId, detail: { kept: check.reason } });
    }
    return { ok: false, status: 409, error: `kept: ${check.reason}` };
  }
  const c = await child(s);
  if (c) {
    const refused = boxRefusal(c);
    if (refused) return refused;
    const user = c.project.user;
    // Under the pane's launch lock: a launch into this pane (switch agent, a
    // relaunch) holds it from typing to unparking, so a sweep retire that gets
    // the lock after one sees the spawn unparked and backs off, instead of
    // removing a workstream whose agent was just started.
    const session = tmux.sessionName(user.unixUsername, c.project.name, 'agent', c.ws.name);
    const outcome = await withPaneLock(paneLockKey(c.project.instanceId, session), async (): Promise<ActionResult | null> => {
      const fresh = await prisma.agentSpawn.findUnique({ where: { id: s.id }, select: { parkedAt: true, retiredAt: true } });
      if (!fresh || fresh.retiredAt) return { ok: true, detail: 'already retired' };
      if (by === 'sweep' && !fresh.parkedAt) return { ok: false, status: 409, error: 'it was launched again' };
      const result = c.ws.name === 'main'
        ? await archiveOwnedProject(user, c.project.id)
        : await removeWorkstreamFor(user, c.project.id, c.ws.id, { force: false });
      if (result.status >= 300) {
        const error = (result.body as { error?: string } | undefined)?.error ?? `HTTP ${result.status}`;
        await prisma.agentSpawn.update({ where: { id: s.id }, data: { keptReason: error.slice(0, 200) } });
        return { ok: false, status: result.status, error };
      }
      return null;
    });
    if (outcome) return outcome;
  }
  const now = new Date();
  await prisma.agentSpawn.update({ where: { id: s.id }, data: { retiredAt: now, endedAt: s.endedAt ?? now, parkedAt: s.parkedAt ?? now, keptReason: null } });
  console.log(`[SPAWN] retired ${s.childProjectName}/${s.childWorkstream} (${by}, ${check.why}, ${s.id})`);
  await recordSpawnEvent({ kind: 'retired', spawnId: s.id, rootSpawnId: s.rootSpawnId, userId: s.userId, reason: by, instanceId: s.childInstanceId, detail: { why: check.why } });
  return { ok: true };
}
