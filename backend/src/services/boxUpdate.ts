/**
 * Box self-update, the orchestrator's side.
 *
 * A box does not update itself: termag-box-update.service (deploy/) pulls
 * main, runs termag-reconcile and restarts the agent when that is safe, and
 * nothing on the box starts it. This is what does. When a connected box's
 * agent runs a commit other than the one a current box runs, the orchestrator
 * asks it to update through the agent's `box-update` RPC, which starts that
 * unit, so the box-side script decides everything about what is safe; the
 * unit asks this orchestrator for the same flag again before it touches
 * anything (routes/boxUpdatePolicy.ts).
 *
 * What "current" means: the commit the newest published box AMI was baked
 * from (its TermagSha tag). publish-ami.yml's check-box-ami bakes a new box
 * image whenever main changed in a path that executes on a box (agent/, cli/,
 * deploy/, the packer inputs), so a new TermagSha is exactly "main changed in
 * a way that affects boxes", computed from that one path set, with no second
 * copy of the list here and no GitHub credential on the orchestrator. The
 * price is lag: the staleness check runs every three hours and a bake takes
 * about half an hour, so a push follows a merge by up to a few hours, with
 * nobody doing anything. An age-out rebake moves the sha with nothing relevant
 * changed; the box-side script is content-compared and restarts the agent only
 * when agent/ changed, so the push it causes costs one fetch per box.
 *
 * One push per (box, target): a box that cannot pull (a branch, a dirty tree,
 * opted out) is not asked again until the target moves, and a box that
 * updated reports the new commit when its agent reconnects and reads as
 * current. The agent reads its commit once per process, so a box whose
 * script pulled but deferred the restart (a live Claude runner session)
 * keeps reporting the old one until that restart, which is the truth.
 *
 * Gated per user, and per box, by the flag
 * box-auto-update-enabled (default off; the context is the owner + box
 * multi-context, so a rollout can start with one box). Nothing here throws
 * into the registry or the sweep, and nothing here runs when box
 * provisioning is not configured, since there is no AMI to compare against.
 */
import { EC2Client } from '@aws-sdk/client-ec2';
import { prisma } from '../db';
import type { Instance, User } from '@prisma/client';
import {
  type BoxAgentHelloEvent,
  connectedOwnedBoxes,
  instanceAgentTransport,
  onBoxAgentHello,
  sendToInstanceAgent,
} from './agentRegistry';
import { awsClientConfig, discoverLatestAmi, getBoxConfig } from './boxProvisioner';
import { BOX_AUTO_UPDATE_FLAG } from './boxUpdatePolicy';
import { isManagedBox } from './instanceLifecycle';
import { boolVariation } from './featureFlags';
import { ttlMemo } from './ttlMemo';

/** The flag lives with the box's own check of it (boxUpdatePolicy.ts); re-exported for the admin status and the tests. */
export { BOX_AUTO_UPDATE_FLAG };
/** Announced by an agent whose `box-update` RPC starts termag-box-update.service (agent/box-update.js). */
export const BOX_UPDATE_CAPABILITY = 'box-update-v1';
/** Between hellos, connected boxes are compared against the target this often. */
export const BOX_UPDATE_SWEEP_MS = 30 * 60 * 1000;
/**
 * A box that just connected is given this long before it is asked. Its
 * session reconstruction (agentRuntime) starts 2 s after connect, and an
 * agent restart in the middle of it would only make it start over.
 */
export const HELLO_PUSH_DELAY_MS = 60 * 1000;
/** A newly published AMI is noticed within this; the sweep then makes one DescribeImages call per five minutes at most. */
const TARGET_CACHE_MS = 5 * 60 * 1000;

export type BoxUpdateSkip = 'flag-off' | 'not-managed' | 'agent-too-old' | 'no-target' | 'current' | 'already-pushed';
export type BoxUpdateDecision = { push: true } | { push: false; reason: BoxUpdateSkip };

export interface BoxUpdateFacts {
  flagOn: boolean;
  /** A box termag launched (isManagedBox); an external box is the owner's own machine and gets nothing pushed. */
  managed: boolean;
  capabilities: string[];
  /** What the agent said it runs; null from an older agent or outside a git checkout. */
  agentCommit: string | null;
  /** What a current box runs; null when there is no tagged AMI to read it from. */
  targetCommit: string | null;
  /** The target this box was last asked to move to, if any. */
  lastPushedTarget: string | null;
}

/**
 * Whether to ask a box to update. Pure, so the table is a unit test. An agent
 * that announces the capability but no commit is asked once per target: it
 * cannot be told from a stale one, and the script on the box is the one that
 * knows whether there is anything to pull.
 */
export function boxUpdateDecision(f: BoxUpdateFacts): BoxUpdateDecision {
  if (!f.flagOn) return { push: false, reason: 'flag-off' };
  if (!f.managed) return { push: false, reason: 'not-managed' };
  if (!f.capabilities.includes(BOX_UPDATE_CAPABILITY)) return { push: false, reason: 'agent-too-old' };
  if (!f.targetCommit) return { push: false, reason: 'no-target' };
  if (f.agentCommit === f.targetCommit) return { push: false, reason: 'current' };
  if (f.lastPushedTarget === f.targetCommit) return { push: false, reason: 'already-pushed' };
  return { push: true };
}

// ── the target ────────────────────────────────────────────────────────────────

/** The commit a current box runs and when its image was created, for the Fleet table's "behind" marker. */
export interface BoxUpdateTarget { commit: string | null; imageCreatedAt: string | null }
const NO_TARGET: BoxUpdateTarget = { commit: null, imageCreatedAt: null };

let targetLoader: (() => Promise<BoxUpdateTarget>) | null = null;
let lastTarget: BoxUpdateTarget = NO_TARGET;

async function loadTarget(): Promise<BoxUpdateTarget> {
  const cfg = getBoxConfig();
  if (!cfg) return NO_TARGET;
  const ami = await discoverLatestAmi(new EC2Client(awsClientConfig(cfg)), cfg);
  return { commit: ami.termagSha, imageCreatedAt: ami.createdAt ?? null };
}

/** The newest box image's commit and date, cached; nulls when they cannot be known, which is a reason to do nothing. */
export async function boxUpdateTarget(): Promise<BoxUpdateTarget> {
  if (!targetLoader) targetLoader = ttlMemo(loadTarget, TARGET_CACHE_MS);
  try {
    lastTarget = await targetLoader();
  } catch (err) {
    // ttlMemo forgets a rejection, so the next call asks again.
    console.warn('[BOX-UPDATE] could not read the newest box AMI; no box is asked to update:', errMsg(err));
    lastTarget = NO_TARGET;
  }
  return lastTarget;
}

/** The commit a current box runs; null when it cannot be known. */
export async function targetBoxCommit(): Promise<string | null> {
  return (await boxUpdateTarget()).commit;
}

/** Drops the cached target and the pushed set; a test's target loader takes the AMI lookup's place. */
export function resetBoxUpdateCache(target?: () => Promise<string | null>): void {
  targetLoader = target ? ttlMemo(async () => ({ commit: await target(), imageCreatedAt: null }), TARGET_CACHE_MS) : null;
  lastTarget = NO_TARGET;
  pushed.clear();
  lastSweepAt = null;
}

// ── deciding and pushing ─────────────────────────────────────────────────────

export interface BoxUpdateCandidate {
  instance: Pick<Instance, 'id' | 'name' | 'kind' | 'userId'>;
  user: User;
  agentCommit: string | null;
  capabilities: string[];
}

/** instance id → the target it was last asked to move to. Per process; a restart asks once more, which is harmless. */
const pushed = new Map<string, string>();
let lastSweepAt: Date | null = null;

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'unknown');

/**
 * Decide for one connected box and, when due, ask it. The flag is read
 * first (a local evaluation) and the AMI only when it matters, so a fleet
 * with the flag off costs no AWS call. The push is recorded before it is
 * sent: a box that cannot run the unit (its checkout predates it) is told so
 * once per target, not every sweep. Never throws.
 */
export async function considerBoxUpdate(c: BoxUpdateCandidate, trigger: 'hello' | 'sweep'): Promise<BoxUpdateDecision> {
  const box = { id: c.instance.id, name: c.instance.name, kind: c.instance.kind };
  const flagOn = await boolVariation(BOX_AUTO_UPDATE_FLAG, c.user, false, box);
  const managed = isManagedBox(c.instance);
  const capable = c.capabilities.includes(BOX_UPDATE_CAPABILITY);
  const targetCommit = flagOn && managed && capable ? await targetBoxCommit() : null;
  const decision = boxUpdateDecision({
    flagOn, managed, capabilities: c.capabilities, agentCommit: c.agentCommit, targetCommit,
    lastPushedTarget: pushed.get(c.instance.id) ?? null,
  });
  if (!decision.push || !targetCommit) return decision;

  pushed.set(c.instance.id, targetCommit);
  console.log(`[BOX-UPDATE] ${c.instance.name} (${c.user.unixUsername}) runs ${short(c.agentCommit)}, a current box runs ${short(targetCommit)}; asking it to update (${trigger})`);
  try {
    const reply = await sendToInstanceAgent(c.instance.id, 'box-update', { target: targetCommit }, 15_000);
    console.log(`[BOX-UPDATE] ${c.instance.name}: ${reply?.unit ?? 'the update unit'} started`);
  } catch (err) {
    console.error(`[BOX-UPDATE] ${c.instance.name}: box-update failed; not retried before the target changes: ${errMsg(err)}`);
  }
  return decision;
}

/** One pass over every connected owned box. Never throws. */
export async function runBoxUpdateSweep(): Promise<void> {
  lastSweepAt = new Date();
  for (const box of connectedOwnedBoxes()) {
    try {
      await considerBoxUpdate(box, 'sweep');
    } catch (err) {
      console.error(`[BOX-UPDATE] ${box.instance.name}: sweep failed:`, errMsg(err));
    }
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

let sweepTimer: NodeJS.Timeout | null = null;
let unsubscribeHello: (() => void) | null = null;
let helloDelayMs = HELLO_PUSH_DELAY_MS;
// Hello timers not yet fired, so stopping clears them: a process that lost
// the lease keeps its agent sockets open through the drain grace, and a
// timer left armed would push from the process that is no longer serving.
const pendingHellos = new Set<NodeJS.Timeout>();

function onHello(ev: BoxAgentHelloEvent): void {
  const timer = setTimeout(() => {
    pendingHellos.delete(timer);
    if (!sweepTimer) return;
    // The agent that said hello has to still be the one connected, running
    // the same code; a box that reconnected since gets its own hello.
    const live = instanceAgentTransport(ev.instance.id);
    if (!live || live.agentCommit !== ev.agentCommit) return;
    considerBoxUpdate({ instance: ev.instance, user: ev.user, agentCommit: live.agentCommit, capabilities: live.capabilities }, 'hello')
      .catch(err => console.error(`[BOX-UPDATE] ${ev.instance.name}: hello check failed:`, errMsg(err)));
  }, helloDelayMs);
  timer.unref?.();
  pendingHellos.add(timer);
}

/**
 * Leader work (index.ts): the hello hook and the sweep. Sockets are per
 * process, so only the process holding a box's agent can push to it, and
 * that is the serving one once a drain has handed the agents over.
 */
export function startBoxUpdateSweep(opts: { sweepMs?: number; helloDelayMs?: number } = {}): void {
  if (sweepTimer) return;
  helloDelayMs = opts.helloDelayMs ?? HELLO_PUSH_DELAY_MS;
  unsubscribeHello = onBoxAgentHello(onHello);
  sweepTimer = setInterval(() => {
    runBoxUpdateSweep().catch(err => console.error('[BOX-UPDATE] sweep failed:', errMsg(err)));
  }, opts.sweepMs ?? BOX_UPDATE_SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopBoxUpdateSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (unsubscribeHello) { unsubscribeHello(); unsubscribeHello = null; }
  for (const timer of pendingHellos) clearTimeout(timer);
  pendingHellos.clear();
}

/**
 * For the admin System page: what a current box runs and what this process
 * has asked for. The target is read here (memoized, so at most one
 * DescribeImages per five minutes, and only when the page is loaded) rather
 * than taken from the last decision, so the rollout check "does the
 * orchestrator see the newest AMI's commit" works before any box has the
 * flag on.
 */
export async function boxUpdateStatus() {
  const target = await boxUpdateTarget();
  // What the boxes reported back in the last day (services/boxUpdateReport.ts): the result side of the pushes.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const reports = await prisma.instance.groupBy({ by: ['lastUpdateOutcome'], where: { lastUpdateAt: { gte: since }, lastUpdateOutcome: { not: null } }, _count: true });
  return {
    flag: BOX_AUTO_UPDATE_FLAG,
    targetCommit: target.commit,
    targetImageCreatedAt: target.imageCreatedAt,
    lastSweepAt: lastSweepAt?.toISOString() ?? null,
    pushedThisProcess: pushed.size,
    // Each box row keeps its LAST report only, so this is boxes by latest outcome, not runs:
    // a box that failed at 09:00 and succeeded at 10:00 counts once, as updated.
    boxesByLastOutcome24h: Object.fromEntries(reports.map(r => [r.lastUpdateOutcome ?? 'unknown', r._count])) as Record<string, number>,
    note: 'pushes are in-memory, one per box and target, reset on restart; boxes are counted by the last outcome they reported, not by run',
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
