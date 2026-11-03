/**
 * Bringing a claimed pool box up to the orchestrator's commit before its first
 * launch.
 *
 * A pool box runs the commit its image was baked from, and the box update
 * (boxUpdate.ts) only moves a box that is behind the newest box image, so a
 * box claimed between a merge and the next bake ran without it: on 2026-10-30
 * four claimed boxes launched without #1099's Fireworks /model menu. Here a
 * claim whose box's agent runs another commit than this orchestrator asks it
 * to update (the agent's `box-update` RPC: termag-box-update pulls main, runs
 * termag-reconcile and restarts the agent), waits for the run's report and,
 * when it restarted the agent or reinstalled what the agent's capabilities are
 * read from, for the agent's next hello, and only then lets a launch through.
 *
 * The target is this orchestrator's own commit (termagVersion.ts), not
 * origin/main and not the box image's: the orchestrator has no GitHub
 * credential to read main with, the box pulls origin/main itself whatever
 * target it is handed, and the commit the orchestrator runs is the newest code
 * that knows which box capabilities to use. A box on another commit is
 * usually behind it (the case this exists for); one ahead of it pulls and
 * reports `current` in seconds.
 *
 * Never blocks the person: the whole wait is bounded by
 * CLAIM_UPDATE_TIMEOUT_MS, and on a timeout, a failed RPC or a failed run the
 * launch goes ahead on the commit the box has, with the reason logged and on
 * the box row (`claimUpdateStatus`, `claimUpdateDetail`), which both chat
 * views' setup steps read. No flag: the box's own policy check
 * (boxUpdatePolicy.ts, claimUpdateOpensPolicy) says yes for a box whose claim update is under
 * way, whatever box-auto-update-enabled says.
 *
 * A launch waits through `claimUpdateSettled` (claimUpdateGate.ts: the pane
 * launch, the clone, a chat turn, a cloud runner's placement), and an ask through the claim's settled connection
 * (agentRegistry.settleClaimedOwner), which warmPoolClaim.ts marks only once
 * this is done. The claim has no live session to defer the restart for: this
 * runs before anything is launched on the box.
 */
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { dropInstanceAgent, instanceAgentSettled, instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { BOX_UPDATE_CAPABILITY, noteClaimUpdated } from './boxUpdate';
import { isManagedBox } from './instanceLifecycle';
import { CLAIM_UPDATE_POLICY_MS } from './boxUpdatePolicy';
import { CLAIM_UPDATE_TIMEOUT_MS, trackClaimUpdate } from './claimUpdateGate';

export { CLAIM_UPDATE_TIMEOUT_MS };
import { termagVersion } from './termagVersion';

const POLL_MS = 1_000;
/** Less than this left of the bound when the delivery ends, and no update is sent: a run takes about half of it. */
export const CLAIM_UPDATE_MIN_RUN_MS = 60_000;

/**
 * On the box row while a claim's update runs, then how it ended. `updating`
 * is also what the policy route reads (boxUpdatePolicy.claimUpdateOpensPolicy).
 */
export type ClaimUpdateStatus = 'updating' | 'updated' | 'current' | 'skipped' | 'failed' | 'timed-out';

export type ClaimUpdateDecision =
  | { update: true }
  | { update: false; status: 'current' | 'skipped'; reason: string };

/** Whether a claimed box is asked to update. Pure, so the table is a unit test. */
export function claimUpdateDecision(f: {
  managed: boolean;
  capabilities: readonly string[];
  agentCommit: string | null;
  targetCommit: string | null;
}): ClaimUpdateDecision {
  if (!f.managed) return { update: false, status: 'skipped', reason: 'not a box termag launched' };
  if (!f.targetCommit) return { update: false, status: 'skipped', reason: 'the orchestrator does not know its own commit' };
  if (f.agentCommit === f.targetCommit) return { update: false, status: 'current', reason: `runs ${short(f.targetCommit)}, as the orchestrator does` };
  if (!f.capabilities.includes(BOX_UPDATE_CAPABILITY)) return { update: false, status: 'skipped', reason: `the agent predates ${BOX_UPDATE_CAPABILITY}` };
  return { update: true };
}

/** What a box's update run reported (boxUpdateReport.ts), as read off the row. */
export interface ClaimUpdateReport { outcome: string; detail: string | null; commit: string | null }

export interface ClaimUpdateResult {
  status: Exclude<ClaimUpdateStatus, 'updating'>;
  detail: string;
  ms: number;
}

/** The live agent on the box, as far as this needs it. `conn` is compared by identity: a new connection is a new hello. */
export interface LiveAgent { conn: object; capabilities: string[]; agentCommit: string | null; helloReceived: boolean }

export interface ClaimUpdateEffects {
  now(): number;
  sleep(ms: number): Promise<void>;
  targetCommit(): Promise<string | null>;
  agent(instanceId: string): LiveAgent | null;
  /** The owner's credentials have landed on the agent holding the box (agentRegistry.instanceAgentSettled). */
  settled(instanceId: string): boolean;
  /** The row says `updating`. */
  begin(instanceId: string, detail: string): Promise<void>;
  /** The RPC, with updatePushedAt set first so the report (which clears it) can be told apart from an older one. */
  sendUpdate(instanceId: string, target: string): Promise<void>;
  /** The run's report once it has landed (updatePushedAt cleared), else null. */
  report(instanceId: string): Promise<ClaimUpdateReport | null>;
  /** Close the agent's socket so it says hello again with what reconcile installed. */
  redial(instanceId: string, reason: string): void;
  finish(instanceId: string, result: ClaimUpdateResult): Promise<void>;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'unknown');

/** A report token's value: `agent=restarted` in `pull=… agent=restarted …`. */
function token(detail: string | null, key: string): string | null {
  const m = new RegExp(`(?:^| )${key}=(\\S+)`).exec(detail ?? '');
  return m ? m[1] : null;
}

/**
 * Update one claimed box and wait for it, or say why not. Never throws; every
 * ending is a result the caller logs and the row keeps. `onDecided` hears
 * whether there is an update as soon as that is known and on the row; the RPC
 * then waits for `before`.
 */
export async function runClaimUpdate(
  instance: Pick<Instance, 'id' | 'name' | 'kind' | 'userId'>,
  fx: ClaimUpdateEffects,
  opts: { before?: Promise<unknown>; onDecided?: (updating: boolean) => void } = {},
): Promise<ClaimUpdateResult> {
  const started = fx.now();
  const deadline = started + CLAIM_UPDATE_TIMEOUT_MS;
  const end = async (status: ClaimUpdateResult['status'], detail: string): Promise<ClaimUpdateResult> => {
    const result = { status, detail, ms: fx.now() - started };
    await fx.finish(instance.id, result).catch(() => {});
    return result;
  };
  try {
    const before = fx.agent(instance.id);
    if (!before) {
      opts.onDecided?.(false);
      return await end('skipped', 'the agent is not connected here');
    }
    const target = await fx.targetCommit();
    const decision = claimUpdateDecision({
      managed: isManagedBox(instance), capabilities: before.capabilities, agentCommit: before.agentCommit, targetCommit: target,
    });
    if (!decision.update) {
      opts.onDecided?.(false);
      return await end(decision.status, decision.reason);
    }

    await fx.begin(instance.id, `${short(before.agentCommit)} → ${short(target)}`);
    opts.onDecided?.(true);
    await opts.before?.catch(() => undefined);
    // The bound runs from the claim. Near it the hold is about to go, and an
    // update sent now would restart the agent under the launch it let through.
    if (deadline - fx.now() < CLAIM_UPDATE_MIN_RUN_MS) {
      return await end('timed-out', `the credential delivery left under ${CLAIM_UPDATE_MIN_RUN_MS / 1000} s of the ${CLAIM_UPDATE_TIMEOUT_MS / 1000} s bound; no update sent`);
    }
    try {
      await fx.sendUpdate(instance.id, target!);
    } catch (err) {
      return await end('failed', `box-update failed: ${errMsg(err)}`);
    }

    let report: ClaimUpdateReport | null = null;
    while (!(report = await fx.report(instance.id))) {
      if (fx.now() >= deadline) return await end('timed-out', `no report from termag-box-update within ${CLAIM_UPDATE_TIMEOUT_MS / 1000} s`);
      await fx.sleep(POLL_MS);
    }

    const restarted = token(report.detail, 'agent') === 'restarted';
    const reconciled = token(report.detail, 'reconcile') === 'reconciled';
    const what = `${report.outcome} (${report.detail ?? 'no detail'})`;
    // The capabilities a launch reads come from the agent's hello. A restart
    // brings one; a reconcile without a restart (deploy/ changed, agent/ did
    // not) installed scripts whose markers the old hello never saw.
    if (restarted || reconciled) {
      if (!restarted) fx.redial(instance.id, 'claim update reinstalled box scripts; hello again for their capabilities');
      for (;;) {
        const now = fx.agent(instance.id);
        if (now && now.conn !== before.conn && now.helloReceived && fx.settled(instance.id)) break;
        if (fx.now() >= deadline) return await end('timed-out', `${what}, but the agent did not say hello again within ${CLAIM_UPDATE_TIMEOUT_MS / 1000} s`);
        await fx.sleep(POLL_MS);
      }
    }
    switch (report.outcome) {
      case 'updated': return await end('updated', `${short(before.agentCommit)} → ${short(fx.agent(instance.id)?.agentCommit ?? report.commit)}`);
      case 'current': return await end('current', `nothing to pull: ${what}`);
      case 'failed': return await end('failed', what);
      default: return await end('skipped', what);
    }
  } catch (err) {
    return end('failed', errMsg(err));
  }
}

// ── starting one ─────────────────────────────────────────────────────────────

/**
 * Start the update for a box just claimed. Resolves once it is known whether
 * there is one (`updating`, already on the row, so the claim's answer can say
 * so), with `done` for the rest; the RPC waits for `before`, the claim's
 * credential delivery, since the pull may need the owner's GitHub credential.
 * The box is held from this call (claimUpdateGate.ts), so a launch asked for
 * at once waits. Never rejects.
 */
export async function startClaimUpdate(
  instance: Pick<Instance, 'id' | 'name' | 'kind' | 'userId'>,
  owner: Pick<User, 'unixUsername'>,
  before: Promise<unknown>,
  fx: ClaimUpdateEffects = prismaClaimUpdateEffects,
): Promise<{ updating: boolean; done: Promise<ClaimUpdateResult> }> {
  let decided!: (updating: boolean) => void;
  const decision = new Promise<boolean>(resolve => { decided = resolve; });
  const done = runClaimUpdate(instance, fx, { before, onDecided: decided }).then(result => {
    const line = `[CLAIM-UPDATE] ${instance.name} (${owner.unixUsername}): ${result.status} after ${Math.round(result.ms / 100) / 10}s: ${result.detail}`;
    if (result.status === 'failed' || result.status === 'timed-out') console.warn(`${line}; launching on the commit it has`);
    else console.log(line);
    if (result.status === 'updated' || result.status === 'current') noteClaimUpdated(instance.id);
    return result;
  });
  trackClaimUpdate(instance.id, done);
  return { updating: await Promise.race([decision, done.then(() => false)]), done };
}

/**
 * A row still `updating` past CLAIM_UPDATE_POLICY_MS was left by an
 * orchestrator that stopped mid-update (a restart, a deploy): its hold went
 * with it, so nothing waits on the box, and this tells the box feed and both
 * UIs so. The warm-pool tick runs it (warmPool.ts). Never throws.
 */
export async function expireStaleClaimUpdates(now: Date, db: Pick<typeof prisma, 'instance'> = prisma): Promise<void> {
  try {
    await db.instance.updateMany({
      where: { claimUpdateStatus: 'updating', claimUpdateStartedAt: { lt: new Date(now.getTime() - CLAIM_UPDATE_POLICY_MS) } },
      data: { claimUpdateStatus: 'timed-out', claimUpdateDetail: 'the orchestrator running it stopped before it finished' },
    });
  } catch (err) {
    console.error('[CLAIM-UPDATE] could not expire stale claim updates:', errMsg(err));
  }
}

// ── effects ──────────────────────────────────────────────────────────────────

export const prismaClaimUpdateEffects: ClaimUpdateEffects = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  targetCommit: async () => (await termagVersion()).sha,
  agent: id => instanceAgentTransport(id),
  settled: id => instanceAgentSettled(id),
  begin: async (id, detail) => {
    await prisma.instance.updateMany({
      where: { id },
      data: { claimUpdateStatus: 'updating', claimUpdateDetail: detail, claimUpdateStartedAt: new Date() },
    });
  },
  sendUpdate: async (id, target) => {
    // Stamped as the RPC goes out, not at begin: a run that ends before it
    // (too little of the bound left) has nothing for a report to clear, and
    // the lifecycle sweep reads the stamp as an update in flight
    // (boxLifecycle.ts). The report clears it, which is also how `report`
    // below tells this run's report from an older one.
    const stamp = new Date();
    await prisma.instance.updateMany({ where: { id }, data: { updatePushedAt: stamp } });
    try {
      await sendToInstanceAgent(id, 'box-update', { target }, 15_000);
    } catch (err) {
      // No run started, so none will report: take back this stamp, and only this one.
      await prisma.instance.updateMany({ where: { id, updatePushedAt: stamp }, data: { updatePushedAt: null } })
        .catch(e => console.warn(`[CLAIM-UPDATE] ${id}: could not take back the push stamp: ${errMsg(e)}`));
      throw err;
    }
  },
  report: async id => {
    const row = await prisma.instance.findUnique({
      where: { id },
      select: { updatePushedAt: true, lastUpdateOutcome: true, lastUpdateDetail: true, lastUpdateCommit: true },
    });
    if (!row || row.updatePushedAt || !row.lastUpdateOutcome) return null;
    return { outcome: row.lastUpdateOutcome, detail: row.lastUpdateDetail, commit: row.lastUpdateCommit };
  },
  redial: (id, reason) => { dropInstanceAgent(id, reason); },
  finish: async (id, result) => {
    await prisma.instance.updateMany({
      where: { id },
      data: { claimUpdateStatus: result.status, claimUpdateDetail: result.detail.slice(0, 500) },
    });
  },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
