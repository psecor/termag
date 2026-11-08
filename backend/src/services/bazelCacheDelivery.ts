/**
 * The `bazel-cache` credential step: the shared Bazel cache's block in a box's
 * /etc/bazel.bazelrc ("How the block
 * reaches boxes"). Unlike the other providers it is sent through one queue per
 * box with a monotonic `seq`, and sent again on its own, without the rest of
 * the delivery, whenever its inputs change: either flag, a new generation, or
 * the flag source becoming ready.
 *
 * The wire format (PR 4, the box side, is written against it):
 *
 *   apply   credentials-apply  {provider: "bazel-cache", payload: {seq, url,
 *           flushGeneration, remoteTimeoutSeconds, remoteRetries, jobs,
 *           downloadOutputs, goHostModcache}}
 *   remove  credentials-remove {provider: "bazel-cache", reason, flushGeneration, seq}
 *
 * `seq` is an integer that only rises (milliseconds since the epoch, or one
 * more than the last when the clock hasn't moved); the box refuses one lower
 * than the last it applied.
 */
import { prisma } from '../db';
import { boolVariationOrUnknown, flagsInitialized, jsonVariationOrUnknown, onFlagUpdate, onFlagsReady } from './featureFlags';
import { connectedOwnedBoxes, instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { isManagedBox } from './instanceLifecycle';
import { QUARANTINED } from './boxQuarantinePolicy';
import { BAZEL_CACHE_CAPABILITY, bazelCacheApply, bazelCacheOriginFromEnv, bazelCacheUrl, parseBazelCacheConfig, type BazelCacheApply } from './bazelCache';
import { currentBazelCacheGeneration, startBazelCacheGenerationReader } from './bazelCacheGeneration';

export { BAZEL_CACHE_CAPABILITY };
export const BAZEL_CACHE_FLAG = 'box-bazel-cache-enabled';
export const BAZEL_CACHE_CONFIG_FLAG = 'box-bazel-cache-config';

export const BAZEL_CACHE_REASONS = {
  noUrl: 'the orchestrator has no shared Bazel cache (BAZEL_CACHE_URL), so Bazel here builds without it',
  off: 'the shared Bazel cache is not enabled for you (flag box-bazel-cache-enabled), so Bazel here builds without it',
};

/** The step before its `seq`. null, from bazelCacheStepFor, means send nothing: the box keeps what it has. */
export type BazelCacheStep =
  | { type: 'credentials-apply'; provider: 'bazel-cache'; payload: BazelCacheApply }
  | { type: 'credentials-remove'; provider: 'bazel-cache'; reason: string; flushGeneration: number };

type Box = { user: Parameters<typeof boolVariationOrUnknown>[1]; instance: { id: string; name: string; kind: string } };

/**
 * The one gate on the block, for a managed owned box whose agent can take it.
 * - the flag source not initialized yet, or either flag's evaluation failed: no
 *   step. A fallback of off would strip every box at each restart, and a
 *   fallback config would overwrite the settings it was sent.
 * - BAZEL_CACHE_URL unset or invalid, or the flag off: remove, still carrying
 *   the flag's flushGeneration, so a flush reaches boxes whose block is off.
 * - The flag on, but no generation read yet: no step.
 * - Otherwise: apply, with the URL from the environment and the generation,
 *   and the settings from box-bazel-cache-config, clamped.
 */
export async function bazelCacheStepFor(box: Box, env: NodeJS.ProcessEnv = process.env): Promise<BazelCacheStep | null> {
  if (!flagsInitialized()) return null;
  const [enabled, config] = await Promise.all([
    boolVariationOrUnknown(BAZEL_CACHE_FLAG, box.user, false, box.instance),
    jsonVariationOrUnknown(BAZEL_CACHE_CONFIG_FLAG, box.user, null, box.instance),
  ]);
  if (enabled === null || config === null) {
    console.warn(`[BAZEL-CACHE] the flags could not be evaluated for instance ${box.instance.id}; sending no step`);
    return null;
  }
  const settings = parseBazelCacheConfig(config.value);
  const origin = bazelCacheOriginFromEnv(env);
  const remove = (reason: string): BazelCacheStep => ({ type: 'credentials-remove', provider: 'bazel-cache', reason, flushGeneration: settings.flushGeneration });
  if (!origin) return remove(BAZEL_CACHE_REASONS.noUrl);
  if (!enabled) return remove(BAZEL_CACHE_REASONS.off);
  const generation = currentBazelCacheGeneration();
  if (!generation) return null;
  return { type: 'credentials-apply', provider: 'bazel-cache', payload: bazelCacheApply(bazelCacheUrl(origin, generation), settings) };
}

let lastSeq = 0;

/**
 * A seq above every one this process has sent, and above the clock's
 * milliseconds. Across processes (a host replacement, an overlapping deploy)
 * it relies on their clocks agreeing to within the time between one
 * process's last send to a box and the next's first: minutes for a
 * replacement, the drain grace for an overlap, against the hosts' sub-
 * millisecond NTP sync (Amazon Time Sync).
 */
export function nextBazelCacheSeq(now: number = Date.now()): number {
  lastSeq = Math.max(now, lastSeq + 1);
  return lastSeq;
}

// The step last sent to each box (without its seq), to skip a redelivery that
// would change nothing (and cost the box Bazel's re-check, tech spec AR23).
const lastSent = new Map<string, string>();
// The delivery running for each box; a request that arrives meanwhile asks it
// to evaluate once more when it's done, so the latest evaluation lands last.
const queues = new Map<string, { again: boolean; force: boolean; run: Promise<void> }>();

/** For tests. */
export function resetBazelCacheDelivery(): void {
  lastSent.clear();
  queues.clear();
  for (const t of scheduled.values()) clearTimeout(t);
  scheduled.clear();
  lastSeq = 0;
}

/** The box as its agent is connected now, if it can take the step at all. */
async function liveBox(instanceId: string): Promise<Box | null> {
  const agent = instanceAgentTransport(instanceId);
  if (!agent || !agent.capabilities.includes(BAZEL_CACHE_CAPABILITY)) return null;
  const conn = agent.conn;
  if (conn.kind !== 'owned-box' || !isManagedBox(conn.instance)) return null;
  // Read now: a box quarantined or terminated since its agent connected gets nothing.
  const row = await prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
  if (!row || row.status === QUARANTINED || row.status === 'terminated') return null;
  return { user: conn.user, instance: conn.instance };
}

async function send(instanceId: string, step: BazelCacheStep, seq: number): Promise<void> {
  if (step.type === 'credentials-apply') {
    await sendToInstanceAgent(instanceId, step.type, { provider: step.provider, payload: { seq, ...step.payload } }, 30_000);
    console.log(`[CRED] applied bazel-cache on instance ${instanceId} (seq ${seq}, ${step.payload.url.replace(/^.*\/g\//, 'generation ')}, flush ${step.payload.flushGeneration})`);
  } else {
    await sendToInstanceAgent(instanceId, step.type, { provider: step.provider, reason: step.reason, flushGeneration: step.flushGeneration, seq }, 30_000);
    console.log(`[CRED] removed bazel-cache on instance ${instanceId} (seq ${seq}, flush ${step.flushGeneration})`);
  }
}

/**
 * Evaluates and sends this box's `bazel-cache` step, one delivery per box at a
 * time. `force` sends even an unchanged step (the agent's connect, whose box
 * may hold anything); otherwise an unchanged step is skipped. A forced pass
 * that sends nothing, or whose send fails, leaves the next delivery to send
 * even an unchanged step. After each send
 * it evaluates again and sends once more if anything changed meanwhile, so
 * the box ends on the latest evaluation. Rejects with the first send's error.
 */
export function deliverBazelCache(instanceId: string, opts: { force?: boolean } = {}): Promise<void> {
  const queued = queues.get(instanceId);
  if (queued) {
    queued.again = true;
    queued.force ||= !!opts.force;
    return queued.run;
  }
  const state = { again: false, force: !!opts.force, run: Promise.resolve() };
  state.run = (async () => {
    // A send that failed is the run's outcome only if nothing asked for
    // another pass meanwhile: an agent that reconnects mid-send fails the old
    // socket's send, and its new connect's forced pass must still run.
    let failure: Error | null = null;
    // Bounded, in case the inputs never settle; the next trigger carries on.
    for (let pass = 0; pass < 5; pass++) {
      const force = state.force;
      state.again = false;
      state.force = false;
      // A forced pass is for a box that may hold anything (a fresh connect), so
      // what was last sent to it no longer says what it has. Forget it here,
      // not only after a send: if this pass sends nothing (the flag source not
      // ready, a flag that failed to evaluate, no generation yet) or its send
      // fails, the next unforced delivery must send rather than skip the step
      // as unchanged.
      if (force) lastSent.delete(instanceId);
      const box = await liveBox(instanceId);
      const step = box && await bazelCacheStepFor(box);
      let sent = false;
      if (step) {
        const key = JSON.stringify(step);
        if (force || lastSent.get(instanceId) !== key) {
          try {
            await send(instanceId, step, nextBazelCacheSeq());
            lastSent.set(instanceId, key);
            sent = true;
            failure = null;
          } catch (err) {
            failure = err as Error;
            if (!state.again) break;
            continue;
          }
        }
      }
      if (!sent && !state.again) break;
    }
    // A forced request that arrived after the last pass began, past the bound:
    // nobody will run it, so the next delivery must not trust lastSent either.
    if (state.force) lastSent.delete(instanceId);
    if (failure) throw failure;
  })().finally(() => { queues.delete(instanceId); });
  queues.set(instanceId, state);
  return state.run;
}

const scheduled = new Map<string, NodeJS.Timeout>();
export const REDELIVERY_SPREAD_MS = 60_000;

/**
 * Sends the `bazel-cache` step again to every connected box that can take it,
 * each at a random moment within a minute so a fleet-wide change doesn't
 * burst. A box already waiting for one isn't scheduled twice: its turn reads
 * the inputs as they are then. Returns how many were scheduled.
 */
export function redeliverBazelCache(why: string, random: () => number = Math.random): number {
  let n = 0;
  for (const b of connectedOwnedBoxes()) {
    const id = b.instance.id;
    if (!b.capabilities.includes(BAZEL_CACHE_CAPABILITY) || !isManagedBox(b.instance) || scheduled.has(id)) continue;
    const timer = setTimeout(() => {
      scheduled.delete(id);
      deliverBazelCache(id).catch(err => console.error(`[BAZEL-CACHE] redelivery to instance ${id} failed:`, (err as Error).message));
    }, Math.floor(random() * REDELIVERY_SPREAD_MS));
    timer.unref?.();
    scheduled.set(id, timer);
    n++;
  }
  if (n) console.log(`[BAZEL-CACHE] ${why}: redelivering to ${n} box(es) over the next minute`);
  return n;
}

/**
 * At startup: redeliver on either flag's change and when the flag source becomes
 * ready, and, with BAZEL_CACHE_URL set, read the generation every 5 minutes
 * and redeliver when it changes. Returns the reader's stop.
 */
export function startBazelCacheDelivery(env: NodeJS.ProcessEnv = process.env): () => void {
  onFlagUpdate([BAZEL_CACHE_FLAG, BAZEL_CACHE_CONFIG_FLAG], () => { redeliverBazelCache('a bazel-cache flag changed'); });
  onFlagsReady(() => { redeliverBazelCache('the flag source is ready'); });
  const origin = bazelCacheOriginFromEnv(env);
  if (!origin) return () => {};
  return startBazelCacheGenerationReader(origin, () => { redeliverBazelCache('a new cache generation'); });
}
