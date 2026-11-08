/**
 * Claiming an environment pool box.
 *
 * A box made for a pooled shared environment, before the warm pool and the
 * cold path are asked:
 *   1. the claimer's own GitHub credential must read every repository of the
 *      environment, or nothing is taken (access-denied: the cold path's clone
 *      fails as it would anyway);
 *   2. the newest current `env-stopped` row is taken, `FOR UPDATE SKIP LOCKED`,
 *      and moved to `env-starting`;
 *   3. StartInstances. No capacity for its type: startOnFallbackType retypes it
 *      to another of the same shape (boxStartFallback.ts). Still none: the box
 *      goes back to `env-stopped` (nothing is wrong with it) and the next row is
 *      taken from another zone, since a stopped box can't change zone. A start
 *      that fails otherwise, or whose agent doesn't say hello in time, is
 *      abandoned (terminated), unless its hello reached another orchestrator
 *      process (a rolling deploy's overlap: production runs one replica,
 *      the deploy platform), when it is stopped back to env-stopped;
 *   4. once its hello is in, the warm claim's own steps hand it over: the row
 *      becomes `ready` with its owner (the hand-over, not step 2, gives it one:
 *      configureBox rebinds an ownerless connection, as a warm claim's does),
 *      then box-claim, the on-claim settle and welcomeOwner (credentials, SSH
 *      keys, the claim's update).
 * Up to MAX_CLAIM_CANDIDATES rows, then the caller asks the warm pool, then
 * launches cold. The pull and the chain are the project's clone and
 * environment-up afterwards (agent/project-clone.js adopts the prepared
 * checkout and pulls it as the owner; agent/environment-run.js reruns setup
 * when HEAD moved).
 *
 * Production starts from stop are refused for capacity about a quarter of the
 * time (task D's measurements), so the fallback is a main path: its rules are
 * settled by the tests on claimEnvPoolBox's injected effects.
 */

import { EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2';
import type { Instance } from '@prisma/client';
import { prisma } from '../db';
import { awsClientConfig, getBoxConfig, isCapacityRefusal, terminateBox } from './boxProvisioner';
import { startOnFallbackType } from './boxStartFallback';
import { getInstanceAgent, instanceAgentTransport } from './agentRegistry';
import { claimAwaitsOnClaimReport, isNameConflict, MAX_CLAIM_CANDIDATES, prismaClaimEffects, type BoxClaimAck, type ClaimOwner } from './warmPoolClaim';
import { readGithubAccess } from './credentialStore';
import { GITHUB_API } from './githubCredential';
import { noteClaimInFlight, stopBack } from './envPool';
import { recordProductEvent } from './productEvents';
import type { BoxSize } from './boxSize';

export type EnvPoolMissReason = 'empty' | 'stale' | 'start-failed' | 'no-capacity' | 'access-denied' | 'size' | 'name-taken';

export interface EnvClaimRequest {
  owner: ClaimOwner;
  boxName: string;
  environmentId: string;
  setupHash: string;
  parentInstanceId: string | null;
}

export type StartResult = { ok: true; fallbackType: string | null } | { ok: false; capacity: boolean; error: string };

export interface EnvClaimEffects {
  /** The claim statement: the newest current env-stopped row outside `refusedZones`, to env-starting. Null when none. */
  take(req: EnvClaimRequest, refusedZones: string[]): Promise<Instance | null>;
  /** Whether rows for this environment exist on another setup hash (the miss is `stale`, not `empty`). */
  hasStale(req: EnvClaimRequest): Promise<boolean>;
  start(instance: Instance): Promise<StartResult>;
  /** Resolves true once the box's agent has said hello on this process, false after `ms`. */
  waitForHello(instanceId: string, ms: number): Promise<boolean>;
  /** A capacity refusal: the box is still stopped and still prepared, so it goes back to env-stopped. */
  putBack(instance: Instance): Promise<void>;
  /** Anything else: the box is terminated. */
  abandon(instance: Instance, reason: string): Promise<void>;
  /**
   * Whether the box's agent connected since `sinceMs`, but not to this process: in a rolling deploy's overlap the
   * new pod can take its hello. Nothing is wrong with such a box, so it is stopped back to env-stopped.
   */
  connectedElsewhere(instanceId: string, sinceMs: number): Promise<boolean>;
  /** Plain stop, back to env-stopped once EC2 says so; nothing is wrong with the box. */
  stopBack(instance: Instance, why: string): Promise<void>;
  /**
   * env-starting → ready with the owner and the name, the token's user with it. Null when the row moved;
   * `name-taken` when the owner already has a live box of that name (the box is fine, and so is every other one).
   */
  handOver(instance: Instance, req: EnvClaimRequest): Promise<Instance | 'name-taken' | null>;
  configureBox(instance: Instance, owner: ClaimOwner): Promise<BoxClaimAck>;
  /** The warm claim's abandon: ownerless and failed, the socket disowned. */
  abandonClaimed(instanceId: string, reason: string): Promise<void>;
  settleClaim(instanceId: string): Promise<void>;
  welcomeOwner(instance: Instance, owner: ClaimOwner): Promise<Partial<Instance> | void>;
  waitMs: number;
  now(): number;
}

export type EnvClaimOutcome =
  | { claimed: true; instance: Instance; fallback: 'type' | 'zone' | null; startMs: number; helloMs: number; tried: number }
  | { claimed: false; reason: Exclude<EnvPoolMissReason, 'access-denied' | 'size'>; tried: number };

export async function claimEnvPoolBox(req: EnvClaimRequest, fx: EnvClaimEffects): Promise<EnvClaimOutcome> {
  const refusedZones: string[] = [];
  let startFailed = false;
  for (let tried = 0; tried < MAX_CLAIM_CANDIDATES; tried++) {
    const row = await fx.take(req, refusedZones);
    if (!row) {
      const reason = refusedZones.length ? 'no-capacity' : startFailed ? 'start-failed' : tried === 0 && await fx.hasStale(req) ? 'stale' : 'empty';
      return { claimed: false, reason, tried };
    }
    const startAt = fx.now();
    let started: StartResult;
    try {
      started = await fx.start(row);
    } catch (err) {
      started = { ok: false, capacity: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!started.ok) {
      if (started.capacity) {
        // Nothing is wrong with the box: EC2 has no room for its shape in its zone right now.
        await fx.putBack(row);
        refusedZones.push(zoneOf(row));
        console.warn(`[ENV-POOL] claim: no capacity for ${row.id} in ${zoneOf(row)} (${started.error}); trying another zone`);
      } else {
        await fx.abandon(row, `start failed: ${started.error}`);
        startFailed = true;
      }
      continue;
    }
    const startMs = fx.now() - startAt;
    const helloAt = fx.now();
    if (!(await fx.waitForHello(row.id, fx.waitMs))) {
      if (await fx.connectedElsewhere(row.id, startAt)) await fx.stopBack(row, 'its hello reached another orchestrator process');
      else await fx.abandon(row, `no hello within ${Math.round(fx.waitMs / 1000)}s of its start`);
      startFailed = true;
      continue;
    }
    const helloMs = fx.now() - helloAt;
    const owned = await fx.handOver(row, req);
    if (owned === 'name-taken') {
      // Not the box's fault, and the same name would fail on every other: this one goes back, and the claim ends.
      await fx.stopBack(row, `the box name ${req.boxName} is taken`);
      return { claimed: false, reason: 'name-taken', tried: tried + 1 };
    }
    if (!owned) {
      await fx.abandon(row, 'the hand-over found the row moved');
      continue;
    }
    let ack: BoxClaimAck;
    try {
      ack = await fx.configureBox(owned, req.owner);
    } catch {
      await fx.abandonClaimed(owned.id, 'claim RPC failed');
      continue;
    }
    if (!claimAwaitsOnClaimReport(req.owner, ack)) await fx.settleClaim(owned.id);
    const changed = await fx.welcomeOwner(owned, req.owner);
    const fallback = started.fallbackType ? 'type' : refusedZones.length ? 'zone' : null;
    return { claimed: true, instance: changed ? { ...owned, ...changed } : owned, fallback, startMs, helloMs, tried: tried + 1 };
  }
  return { claimed: false, reason: refusedZones.length ? 'no-capacity' : 'start-failed', tried: MAX_CLAIM_CANDIDATES };
}

function zoneOf(row: Pick<Instance, 'availabilityZone' | 'subnetId'>): string {
  return row.availabilityZone ?? row.subnetId ?? 'unknown';
}

// ── The access check ─────────────────────────────────────────────────────────

/**
 * Whether the claimer's own GitHub credential reads every repository, before
 * anything is taken: no pool box is handed to someone who can't read its
 * checkout. No credential is a no.
 */
export async function claimerCanRead(
  userId: string, repos: readonly string[],
  deps: { token(userId: string): Promise<string | null>; canRead(token: string, repo: string): Promise<boolean> } = defaultAccessDeps,
): Promise<boolean> {
  const token = await deps.token(userId);
  if (!token) return false;
  for (const repo of repos) if (!(await deps.canRead(token, repo))) return false;
  return true;
}

const defaultAccessDeps = {
  token: async (userId: string) => (await readGithubAccess(userId))?.token ?? null,
  canRead: async (token: string, repo: string) => {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'termag' },
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => undefined);
      return res.status === 200;
    } catch {
      return false;
    }
  },
};

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * One claim against an environment's pool: a `[ENV-POOL] claim` line and a
 * `box.pool.claim` event with `pool: environment`, beside the warm pool's.
 */
export function recordEnvPoolClaim(claim: {
  user: { id: string; unixUsername: string };
  environment: string;
  size: BoxSize | null;
  box?: string;
} & (
  | { outcome: 'hit'; fallback: 'type' | 'zone' | null; startMs: number; helloMs: number; tried: number }
  | { outcome: 'miss'; reason: EnvPoolMissReason; tried?: number }
)): void {
  const hit = claim.outcome === 'hit' ? claim : null;
  const reason = claim.outcome === 'miss' ? claim.reason : null;
  console.log(`[ENV-POOL] claim ${claim.outcome} environment=${claim.environment} user=${claim.user.unixUsername}${reason ? ` reason=${reason}` : ''}${hit ? ` fallback=${hit.fallback ?? 'none'} startMs=${hit.startMs} helloMs=${hit.helloMs} tried=${hit.tried}` : ''}`);
  recordProductEvent('box.pool.claim', { user: claim.user.id, box: claim.box ?? null }, {
    pool: 'environment', environment: claim.environment, size: claim.size ?? 'configured', outcome: claim.outcome, reason, via: 'add-box',
    fallback: hit?.fallback ?? null, startMs: hit?.startMs ?? null, helloMs: hit?.helloMs ?? null, candidatesTried: claim.tried ?? null,
  });
}

// ── The Postgres and EC2 effects ─────────────────────────────────────────────

function ec2For(region: string | null): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, region ?? cfg.region));
}

/** The claim statement: environment, current setup hash, outside the refused zones, newest prepared first. */
async function take(req: EnvClaimRequest, refusedZones: string[]): Promise<Instance | null> {
  const rows = await prisma.$queryRaw<Instance[]>`
    UPDATE instances
    SET status = 'env-starting', "claimedAt" = now()
    WHERE id = (
      SELECT id FROM instances
      WHERE status = 'env-stopped'
        AND "userId" IS NULL
        AND "poolEnvironmentId" = ${req.environmentId}
        AND "poolSetupHash" = ${req.setupHash}
        AND ("availabilityZone" IS NULL OR NOT ("availabilityZone" = ANY(${refusedZones}::text[])))
      ORDER BY "preparedAt" DESC NULLS LAST, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  const row = rows[0] ?? null;
  if (row) noteClaimInFlight(row.id, true);
  return row;
}

async function hasStale(req: EnvClaimRequest): Promise<boolean> {
  return (await prisma.instance.count({
    where: { userId: null, status: 'env-stopped', poolEnvironmentId: req.environmentId, NOT: { poolSetupHash: req.setupHash } },
  })) > 0;
}

async function start(instance: Instance): Promise<StartResult> {
  const ec2 = ec2For(instance.region);
  try {
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instance.ec2InstanceId!] }));
    return { ok: true, fallbackType: null };
  } catch (err) {
    if (!isCapacityRefusal(err)) return { ok: false, capacity: false, error: errMsg(err) };
    try {
      return { ok: true, fallbackType: await startOnFallbackType(ec2, instance, err) };
    } catch (again) {
      return { ok: false, capacity: isCapacityRefusal(again), error: errMsg(again) };
    }
  }
}

/** A hello on this process after the start: a socket that predates it belonged to the box before its stop. */
async function waitForHello(instanceId: string, ms: number): Promise<boolean> {
  const before = getInstanceAgent(instanceId);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const now = getInstanceAgent(instanceId);
    if (now && now !== before && instanceAgentTransport(instanceId)?.helloReceived) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function putBack(instance: Instance): Promise<void> {
  noteClaimInFlight(instance.id, false);
  // StartInstances was refused, so EC2 has it stopped: straight back, no stop to wait for.
  await prisma.instance.updateMany({ where: { id: instance.id, userId: null, status: 'env-starting' }, data: { status: 'env-stopped', claimedAt: null } })
    .catch(err => console.error(`[ENV-POOL] ${instance.id}: putting it back failed:`, errMsg(err)));
}

async function abandon(instance: Instance, reason: string): Promise<void> {
  noteClaimInFlight(instance.id, false);
  const changed = await prisma.instance.updateMany({
    where: { id: instance.id, userId: null, status: 'env-starting' },
    data: { status: 'terminated', terminatedAt: new Date(), provisioningError: reason.slice(0, 1000) },
  }).catch(() => ({ count: 0 }));
  console.warn(`[ENV-POOL] claim: abandon ${instance.id}: ${reason}`);
  if (changed.count) void terminateBox(instance);
}

async function connectedElsewhere(instanceId: string, sinceMs: number): Promise<boolean> {
  const row = await prisma.instance.findUnique({ where: { id: instanceId }, select: { lastConnectedAt: true } }).catch(() => null);
  return !!row?.lastConnectedAt && row.lastConnectedAt.getTime() >= sinceMs && !getInstanceAgent(instanceId);
}

async function stopBackEffect(instance: Instance, why: string): Promise<void> {
  noteClaimInFlight(instance.id, false);
  await stopBack(instance.id, instance.ec2InstanceId, instance.region, 'env-starting', why);
}

async function handOver(instance: Instance, req: EnvClaimRequest): Promise<Instance | 'name-taken' | null> {
  noteClaimInFlight(instance.id, false);
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Instance[]>`
        UPDATE instances
        SET "userId" = ${req.owner.id}, name = ${req.boxName}, "parentInstanceId" = ${req.parentInstanceId},
            status = 'ready', "claimedAt" = now(), "onClaimStatus" = 'pending'
        WHERE id = ${instance.id} AND status = 'env-starting' AND "userId" IS NULL
        RETURNING *
      `;
      const owned = rows[0];
      if (!owned) return null;
      await tx.agentToken.updateMany({ where: { instanceId: owned.id, revokedAt: null }, data: { userId: req.owner.id } });
      return owned;
    });
  } catch (err) {
    if (isNameConflict(err)) return 'name-taken';
    throw err;
  }
}

export function prismaEnvClaimEffects(waitMs: number): EnvClaimEffects {
  return {
    take, hasStale, start, waitForHello, putBack, abandon, handOver, connectedElsewhere, stopBack: stopBackEffect,
    configureBox: prismaClaimEffects.configureBox,
    abandonClaimed: prismaClaimEffects.abandonBox,
    settleClaim: prismaClaimEffects.settleClaim,
    welcomeOwner: prismaClaimEffects.welcomeOwner,
    waitMs,
    now: () => Date.now(),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
