/**
 * Environment pools: stopped boxes per shared
 * environment, with its repositories cloned at the static layout and its
 * `setup` already run, so a box made from the environment is a ~15 s start
 * instead of a launch and a setup.
 *
 * This is the side-effecting half; envPoolPlanner.ts decides. Each tick (run
 * with the warm pool's, warmPool.ts):
 *   1. settles `env-stopping` boxes EC2 says are stopped to `env-stopped`, and
 *      puts back an `env-starting` box no claim is waiting on any more;
 *   2. per environment in `environment-pool-sizes` (and any still holding
 *      boxes), resolves what it is now (envPoolDefinition: its repositories,
 *      their default-branch heads, `setup`, size and disk, as the pool
 *      credential reads them), plans, and carries the plan out: launch,
 *      retire, fail.
 *
 * A launched box's hello (warm, ownerless) is answered with the
 * `environment-prepare` RPC (agent/environment-prepare.js): the box clones each
 * repository through the GitHub broker, which answers with the pool credential
 * only while the row is `env-preparing` (services/githubAuthz.ts), and runs
 * `setup` with no secrets. Its `environment-status` frames (project `pool`)
 * come here: success records `preparedCommit` and stops the box plainly
 * (`env-stopping`), failure is `env-failed` with the log, and the box is
 * terminated, its row kept for the environment's page.
 *
 * The claim is envPoolClaim.ts.
 *
 * The refresh is step 3 of the tick:
 * each `env-stopped` row is checked every ENV_POOL_REFRESH_MINUTES
 * (planEnvPoolRefresh). Unchanged heads, it is skipped. Moved, it is started
 * again as `env-preparing` (refreshStartedAt), within ENV_POOL_MAX_INFLIGHT
 * with the launches; its hello gets environment-prepare again, which fetches
 * and checks out each default branch's head in the existing checkouts and
 * reruns `setup` on the prepared disk, and its success stops it as a prepare's
 * does. Only the refresh's own success counts (`prepareId`): the agent re-sends
 * the earlier prepare's state at its hello. A start refused (capacity or
 * otherwise) puts the row back `env-stopped` as it was, checked again next
 * interval; a `setup` that fails is `env-failed`, as a prepare's is. A claim
 * takes only `env-stopped` rows, so a box is never handed out half-refreshed.
 */

import { createHash, randomBytes } from 'crypto';
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { Prisma, type Instance } from '@prisma/client';
import { prisma } from '../db';
import { envPoolConfigFromEnv, type EnvPoolConfig } from '../config/env';
import { awsClientConfig, getBoxConfig, isCapacityRefusal, provisionEnvPoolBox, terminateBox } from './boxProvisioner';
import { decideBoxSize, poolDefaultSize, type BoxSize } from './boxSize';
import { decideBoxDisk, defaultDiskGiB } from './boxDiskSize';
import { environmentRepoUrl, prismaEnvironmentStore, reposOutsideOrgs, type EnvironmentRecord, type EnvironmentStore } from './environments';
import { resolveEnvironmentDefinition, type RepoEnvironmentReader } from './repoEnvironment';
import { poolRepoEnvironmentReader } from './poolEnvironmentRepos';
import { poolGithubTokenSource } from './poolCredential';
import { GITHUB_API } from './githubCredential';
import { getGithubBrokerUrl } from './githubBroker';
import { currentPoolSpecHash } from './warmPool';
import { ENV_POOL_STATUSES } from './instanceLifecycle';
import { envPoolTargets } from './envPoolSizes';
import { attemptAt, envPoolRetryAt, nextRefreshAt, planEnvironmentPool, planEnvPoolRefresh, type EnvPoolCurrent, type EnvPoolRowView, type EnvPoolStatus } from './envPoolPlanner';
import { dropInstanceAgent, isInstanceAgentConnected, onPoolBoxFrame, sendToInstanceAgent, type PoolBoxEvent } from './agentRegistry';
import { recordProductEvent } from './productEvents';
import { failRoot } from './tracing/spans';

/** The agent's capability for the environment-prepare RPC (agent/environment-prepare.js). */
export const ENV_PREPARE_CAPABILITY = 'environment-prepare-v1';

/** The project id a pool box's prepare chain reports under: no real project is ever called this. */
export const POOL_PROJECT_ID = 'pool';

const RESOLVE_CACHE_MS = 60_000;
const MAX_LOG_CHARS = 4000;
const PREPARE_RPC_TIMEOUT_MS = 30_000;
/** After a prepare that failed for anything but its setup (a launch, the image, a clone, a timeout), the next launch waits this long. */
export const ENV_POOL_RETRY_MS = 10 * 60 * 1000;

// ── What an environment is now ───────────────────────────────────────────────

/** A repository a pool box prepares, as the row records it (Instance.poolRepos). */
export interface PoolRepo {
  /** owner/name, lower case. */
  repo: string;
  /** Its default branch: a shared environment runs only those. */
  branch: string;
  /** Its directory under the static layout's root (~/code/<name>): the definition's `path`, else the repository's name. */
  name: string;
}

export interface EnvPoolDefinition {
  environmentId: string;
  name: string;
  repos: PoolRepo[];
  /** Each repository's default-branch head now, {"owner/name": sha}. */
  heads: Record<string, string>;
  /** The resolved `setup`, as the hash reads it. */
  setup: string;
  /** The definition the box's chain runs (the file the project would be made with). */
  fileText: string;
  fileRepo: string | null;
  filePath: string;
  size: BoxSize | null;
  diskGiB: number;
  /** The warm pool's spec for the size: image, type, cloud-init shape. */
  poolSpecHash: string;
  /** What makes a row current (Instance.poolSetupHash). */
  setupHash: string;
}

/** `permanent`: no retry can change it (the environment is personal, its definition isn't JSON, its size or disk can't be pooled). */
export type EnvPoolResolution = { ok: true; def: EnvPoolDefinition } | { ok: false; reason: string; permanent?: true };

export interface EnvPoolDeps {
  store: Pick<EnvironmentStore, 'byName' | 'get'>;
  reader: RepoEnvironmentReader;
  /** A default branch's head commit, read with the pool credential. */
  head(repo: string, branch: string): Promise<{ sha: string } | { error: string }>;
  poolSpecHash(size: BoxSize | null): Promise<string>;
  poolSize(): Promise<BoxSize | null>;
}

const POOL_READER_USER = 'environment-pool';

export const defaultEnvPoolDeps: EnvPoolDeps = {
  store: prismaEnvironmentStore,
  reader: poolRepoEnvironmentReader,
  head: (repo, branch) => branchHead(repo, branch),
  poolSpecHash: size => currentPoolSpecHash(size),
  poolSize: () => poolDefaultSize(),
};

/** sha256 of what a prepared box was made for: the `setup`, the pool spec, the disk and the checkouts' places. */
export function envPoolSetupHash(v: { setup: string; poolSpecHash: string; diskGiB: number; repos: PoolRepo[] }): string {
  // Each checkout's place and the branch it was cloned from: a new default branch makes every box stale.
  const repos = v.repos.map(r => `${r.repo}=${r.name}@${r.branch}`).join(',');
  return createHash('sha256').update(`${v.setup}\n${v.poolSpecHash}\ndisk=${v.diskGiB}\nrepos=${repos}`).digest('hex');
}

/**
 * What setup runs, as text the hash reads: the definition's `setup` and its `env` (which setup gets,
 * agent/environment-run.js setupEnv), '' when it has neither. `run`, `seed` and the rest run after claim, so they
 * don't make a prepared box stale.
 */
export function setupTextOf(definition: unknown): string {
  const d = definition && typeof definition === 'object' ? definition as { setup?: unknown; env?: unknown } : {};
  if (d.setup === undefined && d.env === undefined) return '';
  return d.env === undefined ? JSON.stringify(d.setup) : JSON.stringify({ setup: d.setup ?? null, env: d.env });
}

function dirName(repo: string, path: string | undefined): string {
  return path ?? repo.split('/')[1];
}

/**
 * What a shared environment is now, as its pool prepares it. Only a shared
 * environment can be pooled; one whose size is a set of requirements (not a
 * preset) isn't either, since the pool launches presets.
 */
export async function resolveEnvPoolDefinition(env: EnvironmentRecord, deps: EnvPoolDeps = defaultEnvPoolDeps): Promise<EnvPoolResolution> {
  if (env.visibility !== 'shared') return { ok: false, reason: `${env.name} is personal; only a shared environment has a pool`, permanent: true };
  const resolved = await resolveEnvironmentDefinition(POOL_READER_USER, env, deps.reader);
  if (!resolved.repos.length) return { ok: false, reason: `${env.name} resolves to no repositories${resolved.warnings.length ? ` (${resolved.warnings[0]})` : ''}` };
  const fileText = env.kind === 'inline' ? JSON.stringify(env.definition) : resolved.text;
  if (fileText === undefined) return { ok: false, reason: `${env.name}'s file couldn't be read with the pool credential` };
  let parsed: unknown;
  try { parsed = JSON.parse(fileText); } catch { return { ok: false, reason: `${env.name}'s definition is not JSON`, permanent: true }; }
  // Only our GitHub orgs' repositories, as every environment's unattended steps (projectEnvironment.ts
  // environmentUpRequest, `outside-orgs`): the pool clones them with the pool credential and runs setup ownerless.
  const outside = reposOutsideOrgs(resolved.repos.map(r => r.repo));
  if (outside.length) return { ok: false, reason: `${env.name} names ${outside.join(', ')}, outside our GitHub orgs; a pool prepares only theirs`, permanent: true };

  const repos: PoolRepo[] = [];
  const heads: Record<string, string> = {};
  for (const r of resolved.repos) {
    const repo = r.repo.toLowerCase();
    const branch = await deps.reader.defaultBranch(POOL_READER_USER, repo);
    if ('error' in branch) return { ok: false, reason: branch.error };
    const head = await deps.head(repo, branch.branch);
    if ('error' in head) return { ok: false, reason: head.error };
    repos.push({ repo, branch: branch.branch, name: dirName(repo, r.path) });
    heads[repo] = head.sha;
  }

  const sizing = decideBoxSize(undefined, resolved.sizes, await deps.poolSize());
  if (!sizing.ok || sizing.requirements) return { ok: false, reason: `${env.name} asks for a size by requirements; a pool holds presets only`, permanent: true };
  const disk = decideBoxDisk(undefined, resolved.sizes, defaultDiskGiB());
  if (!disk.ok) return { ok: false, reason: disk.error, permanent: true };
  const poolSpecHash = await deps.poolSpecHash(sizing.size);
  const setup = setupTextOf(parsed);
  return {
    ok: true,
    def: {
      environmentId: env.id, name: env.name, repos, heads, setup, fileText,
      fileRepo: env.kind === 'pointer' ? env.file.repo : null,
      filePath: env.kind === 'pointer' ? env.file.path : `${env.name} (inline)`,
      size: sizing.size, diskGiB: disk.diskGiB, poolSpecHash,
      setupHash: envPoolSetupHash({ setup, poolSpecHash, diskGiB: disk.diskGiB, repos }),
    },
  };
}

const resolveCache = new Map<string, { at: number; value: EnvPoolResolution; env: EnvironmentRecord | null }>();

/** The environment named `name`, as its pool sees it now, cached a minute: a claim reads it, and so does each tick. */
export async function envPoolDefinitionByName(name: string, deps: EnvPoolDeps = defaultEnvPoolDeps): Promise<EnvPoolResolution> {
  const hit = resolveCache.get(name);
  if (hit && Date.now() - hit.at < RESOLVE_CACHE_MS) return hit.value;
  let value: EnvPoolResolution;
  try {
    const env = await deps.store.byName(name);
    value = env ? await resolveEnvPoolDefinition(env, deps) : { ok: false, reason: `there is no environment named ${name}` };
  } catch (err) {
    value = { ok: false, reason: errMsg(err) };
  }
  resolveCache.set(name, { at: Date.now(), value, env: null });
  return value;
}

/**
 * The environment as a preparing box's hello needs it: read afresh, past the cache, from the row the hello has, and,
 * when it is a success or a permanent refusal, kept in the cache for the claims and the tick. A stale cached refusal (one an edit has since fixed) must not fail a
 * box that would prepare.
 */
export async function resolveForHello(env: EnvironmentRecord, deps: EnvPoolDeps = defaultEnvPoolDeps): Promise<EnvPoolResolution> {
  let value: EnvPoolResolution;
  try {
    value = await resolveEnvPoolDefinition(env, deps);
  } catch (err) {
    value = { ok: false, reason: errMsg(err) };
  }
  // A success or a permanent refusal is what the environment is; a transient failure (GitHub, the credential) is this
  // hello's alone, and must not hide a ready pool from the claims for the cache's minute.
  if (value.ok || value.permanent) resolveCache.set(env.name, { at: Date.now(), value, env: null });
  return value;
}

/** Test hook. */
export function resetEnvPoolCache(): void {
  resolveCache.clear();
}

/** A branch's head commit, read from GitHub with the pool credential. */
async function branchHead(repo: string, branch: string): Promise<{ sha: string } | { error: string }> {
  const token = await poolGithubTokenSource();
  if (!token) return { error: 'no pool credential is set (PUT /api/admin/pool-credential/github)' };
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/commits/${branch.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.sha', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'termag' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await res.text()).trim();
    if (res.status !== 200 || !/^[0-9a-f]{40}$/.test(text)) return { error: `GitHub answered ${res.status} for ${repo}'s ${branch} with the pool credential` };
    return { sha: text };
  } catch (err) {
    return { error: `GitHub could not be reached for ${repo} (${errMsg(err)})` };
  }
}

// ── The tick ─────────────────────────────────────────────────────────────────

interface EnvPoolRow extends EnvPoolRowView {
  poolEnvironmentId: string;
  ec2InstanceId: string | null;
  region: string | null;
  claimedAt: Date | null;
  cleanedUpAt: Date | null;
}

/** Claims this process is running, by instance id, so the tick never puts back a box one is waiting on. */
const claimsInFlight = new Set<string>();

export function noteClaimInFlight(instanceId: string, inFlight: boolean): void {
  if (inFlight) claimsInFlight.add(instanceId);
  else claimsInFlight.delete(instanceId);
}

/** One tick of every environment pool. Never throws. */
export async function reconcileEnvPools(now = new Date()): Promise<void> {
  if (!getBoxConfig()) return;
  const policy = envPoolConfigFromEnv(process.env);
  try {
    const rows = await selectEnvPoolRows();
    const targets = await envPoolTargets();
    if (!targets.length && rows.every(r => r.status === 'env-failed')) {
      await retireFailedWithoutPool(rows, targets.map(t => t.name));
      return;
    }

    await settleStops(rows.filter(r => r.status === 'env-stopping'));
    await putBackStrandedStarts(rows.filter(r => r.status === 'env-starting'), now, policy);

    // Every environment with a target, then any still holding boxes, at target 0 so its plan drains them.
    const byId = new Map<string, { name: string | null; target: number }>();
    const names = new Map<string, string>();
    for (const t of targets) {
      const env = await prismaEnvironmentStore.byName(t.name);
      if (!env) { console.warn(`[ENV-POOL] ${t.name}: there is no environment by that name; no pool`); continue; }
      byId.set(env.id, { name: env.name, target: t.target });
      names.set(env.id, env.name);
    }
    for (const r of rows) if (!byId.has(r.poolEnvironmentId)) byId.set(r.poolEnvironmentId, { name: null, target: 0 });

    let inFlight = rows.filter(r => r.status === 'env-preparing').length;
    const subnets = (() => { const c = getBoxConfig()!; return [c.subnetId, ...c.fallbackSubnetIds]; })();
    for (const [environmentId, group] of byId) {
      const own = rows.filter(r => r.poolEnvironmentId === environmentId);
      let current: EnvPoolCurrent = { ok: false, reason: 'no longer pooled' };
      let def: EnvPoolDefinition | null = null;
      if (group.name && group.target > 0) {
        const res = await envPoolDefinitionByName(group.name);
        if (res.ok) { def = res.def; current = { ok: true, hash: def.setupHash, heads: def.heads }; }
        else { current = { ok: false, reason: res.reason }; console.warn(`[ENV-POOL] ${group.name}: ${res.reason}; holding its pool as it is`); }
      }
      const plan = planEnvironmentPool({
        rows: own, current, target: group.target,
        headroom: Math.max(0, policy.maxInFlight - inFlight),
        subnets, prepareTimeoutMs: policy.prepareTimeoutMs, retryAfterMs: ENV_POOL_RETRY_MS, now,
      });
      inFlight += plan.launch.length;
      console.log(`[ENV-POOL] tick ${group.name ?? environmentId} target=${group.target} stopped=${plan.supply.stopped} preparing=${plan.supply.preparing} launch=${plan.launch.length} retire=${plan.retire.length} fail=${plan.fail.length}${plan.blocked ? ` blocked-by=${plan.blocked.rowId}` : ''}`);
      for (const f of plan.fail) await failPrepare(f.id, f.reason, null);
      for (const r of plan.retire) await retireRow(own.find(o => o.id === r.id)!, r.reason);
      let launched = 0;
      if (def) for (const l of plan.launch) if (await launchEnvPoolBox(def, l.subnetId, group.target, policy)) launched++;

      // The refresh: what the launches leave of the in-flight cap, oldest prepared first.
      if (!def) continue;
      const check = planEnvPoolRefresh({ rows: own, stoppedRows: plan.stoppedRows, current, blocked: !!plan.blocked, retryAt: plan.retryAt, intervalMs: policy.refreshMs, now, launched });
      if (check.skip.length) {
        await prisma.instance.updateMany({ where: { id: { in: check.skip.map(k => k.id) }, userId: null, status: 'env-stopped' }, data: { refreshCheckedAt: now } });
        for (const k of check.skip) console.log(`[ENV-POOL] refresh ${group.name}: skip ${k.id} (every default branch is where it was prepared)`);
      }
      // Held rows stay due (no refreshCheckedAt): the tick line's blocked-by says why, and they go once it lifts.
      for (const id of check.refresh) {
        if (inFlight >= policy.maxInFlight) {
          console.log(`[ENV-POOL] refresh ${group.name}: ${check.refresh.length - check.refresh.indexOf(id)} due, waiting for the in-flight cap (${policy.maxInFlight})`);
          break;
        }
        if (await refreshEnvPoolBox(own.find(o => o.id === id)!, def, policy, now) === 'started') inFlight++;
      }
    }
  } catch (err) {
    failRoot(err);
    console.error('[ENV-POOL] reconcile failed:', errMsg(err));
  }
}

async function selectEnvPoolRows(): Promise<EnvPoolRow[]> {
  const rows = await prisma.instance.findMany({
    where: { userId: null, status: { in: [...ENV_POOL_STATUSES] }, poolEnvironmentId: { not: null } },
    select: {
      id: true, status: true, poolSetupHash: true, preparedCommit: true, preparedAt: true, createdAt: true, subnetId: true, terminatedAt: true,
      poolSetupFailed: true,
      poolEnvironmentId: true, ec2InstanceId: true, region: true, claimedAt: true, cleanedUpAt: true,
      refreshStartedAt: true, refreshCheckedAt: true,
    },
  });
  return rows.map(r => ({
    ...r,
    status: r.status as EnvPoolStatus,
    setupFailed: r.poolSetupFailed,
    poolEnvironmentId: r.poolEnvironmentId!,
    preparedCommit: commitsOf(r.preparedCommit),
  }));
}

export function commitsOf(v: Prisma.JsonValue | null | undefined): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, sha] of Object.entries(v)) if (typeof sha === 'string') out[k] = sha;
  return out;
}

/** With no pool wanted anywhere, a failed row has nothing left to explain once a day has passed. */
async function retireFailedWithoutPool(rows: EnvPoolRow[], _names: string[]): Promise<void> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const r of rows) if (r.status === 'env-failed' && r.createdAt.getTime() < dayAgo) await retireRow(r, 'drain');
}

function ec2For(region: string | null): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, region ?? cfg.region));
}

/** `env-stopping` → `env-stopped` once EC2 says the box is stopped. */
/**
 * What an `env-stopping` box needs, by its EC2 state: settle it once stopped; send the stop again while it runs (its
 * StopInstances failed, or never landed, and nothing else would stop it); retire it when EC2 has gone from it; else
 * wait. Pure, for the tests.
 */
export function stopSettlement(state: string | undefined): 'settle' | 'restop' | 'gone' | 'wait' {
  if (state === 'stopped') return 'settle';
  if (state === 'running') return 'restop';
  if (state === 'terminated' || state === 'shutting-down') return 'gone';
  return 'wait';
}

/**
 * Sends the stop again only while the row is still `env-stopping`, read now: the tick's snapshot may predate a settle
 * and a claim's start, and a box someone has just been handed must not be stopped. Whether it sent it.
 */
export async function restopIfStillStopping(fx: { stillStopping(): Promise<boolean>; stop(): Promise<void> }): Promise<boolean> {
  if (!(await fx.stillStopping())) return false;
  await fx.stop();
  return true;
}

/** `env-stopping` → `env-stopped` once EC2 says the box is stopped; the stop is sent again to one still running. */
async function settleStops(rows: EnvPoolRow[]): Promise<void> {
  for (const r of rows) {
    if (!r.ec2InstanceId) continue;
    try {
      const ec2 = ec2For(r.region);
      const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [r.ec2InstanceId] }));
      const next = stopSettlement(res.Reservations?.[0]?.Instances?.[0]?.State?.Name);
      if (next === 'restop') {
        const id = r.id;
        const instanceId = r.ec2InstanceId;
        const sent = await restopIfStillStopping({
          stillStopping: async () => (await prisma.instance.count({ where: { id, userId: null, status: 'env-stopping' } })) > 0,
          stop: async () => { await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] })); },
        });
        if (sent) console.log(`[ENV-POOL] ${r.id}: still running while stopping; stop sent again`);
      } else if (next === 'settle') {
        const moved = await prisma.instance.updateMany({ where: { id: r.id, userId: null, status: 'env-stopping' }, data: { status: 'env-stopped' } });
        if (moved.count) console.log(`[ENV-POOL] ${r.id}: stopped, claimable`);
      } else if (next === 'gone') {
        await retireRow(r, 'EC2 terminated it while it was stopping');
      }
    } catch (err) {
      console.warn(`[ENV-POOL] ${r.id}: settling the stop failed:`, errMsg(err));
    }
  }
}

/**
 * An `env-starting` box no claim here waits on, well past the claim's wait:
 * its claim died with its process. Nothing of anybody's is on it (the hand-over
 * is what gives it an owner), so it goes back to being prepared: stopped again.
 */
async function putBackStrandedStarts(rows: EnvPoolRow[], now: Date, policy: EnvPoolConfig): Promise<void> {
  for (const r of rows) {
    if (claimsInFlight.has(r.id)) continue;
    if (!r.claimedAt || now.getTime() - r.claimedAt.getTime() < policy.claimWaitMs * 2 + 60_000) continue;
    await stopBack(r.id, r.ec2InstanceId, r.region, 'env-starting', 'its claim never finished');
  }
}

/** Plain StopInstances and `env-stopping`, from `from`; the tick settles it to `env-stopped`. Never throws. */
export async function stopBack(id: string, ec2InstanceId: string | null, region: string | null, from: EnvPoolStatus, why: string, data: Prisma.InstanceUpdateManyMutationInput = {}): Promise<boolean> {
  try {
    const moved = await prisma.instance.updateMany({ where: { id, userId: null, status: from }, data: { ...data, status: 'env-stopping', claimedAt: null } });
    if (!moved.count) return false;
    if (ec2InstanceId) await ec2For(region).send(new StopInstancesCommand({ InstanceIds: [ec2InstanceId] }));
    console.log(`[ENV-POOL] ${id}: stopping (${why})`);
    return true;
  } catch (err) {
    console.error(`[ENV-POOL] ${id}: stop (${why}) failed:`, errMsg(err));
    return false;
  }
}

async function retireRow(row: EnvPoolRow, reason: string): Promise<void> {
  const changed = await prisma.instance.updateMany({
    where: { id: row.id, userId: null, status: { in: ['env-preparing', 'env-stopping', 'env-stopped', 'env-failed'] } },
    data: { status: 'terminated', terminatedAt: new Date() },
  });
  if (!changed.count) return;
  console.log(`[ENV-POOL] retire ${row.id}: ${reason}`);
  // A failed box was terminated when it failed; the teardown is idempotent, and the provisioning sweep retries what's left.
  if (row.status === 'env-failed' && row.cleanedUpAt) return;
  const instance = await prisma.instance.findUnique({ where: { id: row.id } });
  if (instance) void terminateBox(instance);
}

/** Whether it launched a box: the transaction's limits can decline (another replica's tick launched meanwhile). */
async function launchEnvPoolBox(def: EnvPoolDefinition, subnetId: string | null, target: number, policy: EnvPoolConfig): Promise<boolean> {
  const rawToken = 'tmag_' + randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const name = `envpool-${randomBytes(4).toString('hex')}`;
  let instance: Instance | null;
  try {
    instance = await prisma.$transaction(async (tx) => {
      // Both of the planner's limits again, inside the insert: another replica's tick may have launched meanwhile.
      const supply = await tx.instance.count({
        where: { userId: null, poolEnvironmentId: def.environmentId, poolSetupHash: def.setupHash, status: { in: ['env-preparing', 'env-stopping', 'env-stopped'] } },
      });
      if (supply >= target) return null;
      if (await tx.instance.count({ where: { userId: null, status: 'env-preparing' } }) >= policy.maxInFlight) return null;
      const created = await tx.instance.create({
        data: {
          userId: null, name, kind: 'ec2', status: 'env-preparing', size: def.size,
          poolEnvironmentId: def.environmentId, poolSetupHash: def.setupHash,
          // The heads it was launched at: a failure at the same ones holds the pool (envPoolPlanner).
          preparedCommit: def.heads, poolRepos: def.repos as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.agentToken.create({ data: { userId: null, instanceId: created.id, name: `env pool: ${name}`, tokenHash, tokenPrefix: rawToken.substring(0, 13) + '...' } });
      return created;
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2034') return false;
    throw err;
  }
  if (!instance) return false;
  console.log(`[ENV-POOL] launch ${instance.id} (${name}) for ${def.name} setup=${def.setupHash.slice(0, 12)} size=${def.size ?? 'configured'} disk=${def.diskGiB} subnet=${subnetId ?? 'rotation'}`);
  void provisionEnvPoolBox({
    instance, token: rawToken, poolSpecHash: def.poolSpecHash, environmentId: def.environmentId,
    size: def.size, diskGiB: def.diskGiB, subnetId,
  });
  return true;
}

// ── Refreshing ───────────────────────────────────────────────────────────────

/** The id a refresh's prepare carries, and its setup's success must echo: from when it started. */
export function refreshPrepareId(refreshStartedAt: Date): string {
  return `refresh-${refreshStartedAt.getTime()}`;
}

export type RefreshOutcome = 'started' | 'taken' | 'capped' | 'put-back';

/**
 * Start an `env-stopped` row again to bring it to its default branches' heads.
 * `env-stopped` → `env-preparing` first, in one guarded statement under the
 * in-flight cap, so a claim and a refresh never both take a row; then
 * StartInstances. A refused start puts it back exactly as it was, with only
 * refreshCheckedAt moved, so it is tried at the next check, not every tick.
 * Never throws.
 */
export async function refreshEnvPoolBox(row: EnvPoolRow, def: EnvPoolDefinition, policy: EnvPoolConfig, now: Date): Promise<RefreshOutcome> {
  let took: boolean;
  try {
    took = await prisma.$transaction(async (tx) => {
      if (await tx.instance.count({ where: { userId: null, status: 'env-preparing' } }) >= policy.maxInFlight) return false;
      const moved = await tx.instance.updateMany({
        where: { id: row.id, userId: null, status: 'env-stopped', poolSetupHash: def.setupHash },
        // preparedCommit is what this attempt is at, as a launch's is: a failed refresh keeps it with the hash, and
        // failPrepare's poolSetupFailed says whether it holds the pool (setup ran) or only delays a retry (envPoolPlanner).
        data: { status: 'env-preparing', refreshStartedAt: now, refreshCheckedAt: now, preparedCommit: def.heads },
      });
      return moved.count > 0;
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2034') return 'capped';
    console.error(`[ENV-POOL] refresh ${row.id}: taking it failed:`, errMsg(err));
    return 'capped';
  }
  if (!took) {
    const still = await prisma.instance.findUnique({ where: { id: row.id }, select: { status: true } }).catch(() => null);
    return still?.status === 'env-stopped' ? 'capped' : 'taken';
  }
  const moved = Object.entries(def.heads).filter(([repo, sha]) => row.preparedCommit?.[repo] !== sha)
    .map(([repo, sha]) => `${repo} ${row.preparedCommit?.[repo]?.slice(0, 7) ?? 'none'}→${sha.slice(0, 7)}`).join(', ');
  try {
    if (!row.ec2InstanceId) throw new Error('it has no EC2 instance');
    await ec2For(row.region).send(new StartInstancesCommand({ InstanceIds: [row.ec2InstanceId] }));
  } catch (err) {
    const why = isCapacityRefusal(err) ? 'no capacity' : 'start failed';
    // Back as it was: still stopped, still prepared at its old commits.
    await prisma.instance.updateMany({
      where: { id: row.id, userId: null, status: 'env-preparing', refreshStartedAt: now },
      data: { status: 'env-stopped', refreshStartedAt: null, preparedCommit: row.preparedCommit ?? undefined },
    }).catch(e => console.error(`[ENV-POOL] refresh ${row.id}: putting it back failed:`, errMsg(e)));
    console.warn(`[ENV-POOL] refresh ${row.id}: ${why} (${errMsg(err)}); left stopped, tried again at the next check`);
    return 'put-back';
  }
  console.log(`[ENV-POOL] refresh ${row.id} for ${def.name}: started (${moved})`);
  return 'started';
}

// ── Preparing ────────────────────────────────────────────────────────────────

/** What the environment-prepare RPC carries (agent/environment-prepare.js). */
export function prepareRequest(instanceId: string, def: Pick<EnvPoolDefinition, 'environmentId' | 'repos' | 'fileText' | 'fileRepo' | 'filePath'>, refreshStartedAt: Date | null = null): Record<string, unknown> {
  return {
    instanceId,
    // A refresh: the box has its checkouts, so the agent fetches and checks out each head, and the chain's state
    // carries prepareId so only this setup's success stops the box.
    ...(refreshStartedAt ? { prepareId: refreshPrepareId(refreshStartedAt) } : {}),
    environmentId: def.environmentId,
    repos: def.repos.map(r => ({ repo: r.repo, branch: r.branch, name: r.name, url: environmentRepoUrl(r.repo) })),
    fileText: def.fileText,
    ...(def.fileRepo ? { fileRepo: def.fileRepo } : {}),
    filePath: def.filePath,
    // The broker the box's git goes through: it has had no credential delivery, so no rewrite is in its gitconfig yet.
    ...(getGithubBrokerUrl() ? { githubBroker: getGithubBrokerUrl() } : {}),
  };
}

/** How long a preparing box whose environment couldn't be resolved at its hello waits before asking again. */
const HELLO_RETRY_MS = 60_000;

/**
 * What a preparing box's hello does, by what its environment resolves to now: prepare it; retry later when the
 * environment couldn't be resolved just now (GitHub, the pool credential), as the tick holds the pool rather than
 * failing it; fail it, with the cause, when no retry can change that (`permanent`); retire it when the environment is
 * gone, or moved on since its launch (it would be stale on arrival).
 * Pure, for the tests.
 */
export function helloAction(rowSetupHash: string | null, res: EnvPoolResolution | null):
  { kind: 'prepare' } | { kind: 'retry'; reason: string } | { kind: 'retire'; reason: string } | { kind: 'fail'; reason: string } {
  if (!res) return { kind: 'retire', reason: 'its environment is gone' };
  // No retry changes a permanent one: the box fails now, with the cause on the environment's page.
  if (!res.ok) return res.permanent ? { kind: 'fail', reason: res.reason } : { kind: 'retry', reason: res.reason };
  if (res.def.setupHash !== rowSetupHash) return { kind: 'retire', reason: 'stale before it prepared' };
  return { kind: 'prepare' };
}

/** A pool box said hello: send environment-prepare if it is still preparing. Re-sent on a reconnect; the agent's start is idempotent. */
async function onPoolHello(ev: PoolBoxEvent): Promise<void> {
  const row = await prisma.instance.findUnique({ where: { id: ev.instance.id } });
  if (!row || row.status !== 'env-preparing' || row.userId || !row.poolEnvironmentId) return;
  if (!ev.capabilities.includes(ENV_PREPARE_CAPABILITY)) {
    await failPrepare(row.id, `the box's agent can't prepare (no ${ENV_PREPARE_CAPABILITY}); the box image is older than environment pools`, null);
    return;
  }
  const env = await prismaEnvironmentStore.get(row.poolEnvironmentId);
  const res = env ? await resolveForHello(env) : null;
  const action = helloAction(row.poolSetupHash, res);
  if (action.kind === 'retire') {
    await retireRow({ ...(row as unknown as EnvPoolRow), status: 'env-preparing' }, action.reason);
    return;
  }
  if (action.kind === 'fail') {
    await failPrepare(row.id, `the environment can't be pooled: ${action.reason}`, null);
    return;
  }
  if (action.kind === 'retry') {
    // The tick holds the pool for the same error; this box keeps its place and asks again, until the prepare timeout.
    console.warn(`[ENV-POOL] ${row.id}: couldn't resolve the environment at its hello (${action.reason}); trying again in ${HELLO_RETRY_MS / 1000}s`);
    setTimeout(() => { onPoolHello(ev).catch(err => console.error('[ENV-POOL] hello retry:', errMsg(err))); }, HELLO_RETRY_MS).unref?.();
    return;
  }
  if (!res?.ok) return;
  // Only to a socket this process holds: a hello on another process (a rolling deploy) prepares the box there.
  if (!isInstanceAgentConnected(row.id)) {
    console.log(`[ENV-POOL] ${row.id}: its agent isn't connected here; its next hello prepares it`);
    return;
  }
  const outcome = prepareSendOutcome(await sendToInstanceAgent(row.id, 'environment-prepare', prepareRequest(row.id, res.def, row.refreshStartedAt), PREPARE_RPC_TIMEOUT_MS)
    .then(answer => ({ answer: answer as Record<string, unknown> | null }), (thrown: unknown) => ({ thrown })));
  if (outcome.kind === 'fail') { await failPrepare(row.id, outcome.reason, null); return; }
  if (outcome.kind === 'wait') {
    console.warn(`[ENV-POOL] ${row.id}: environment-prepare didn't reach its agent (${outcome.reason}); its next hello sends it again`);
    return;
  }
  console.log(`[ENV-POOL] ${row.id}: ${row.refreshStartedAt ? 'refreshing' : 'preparing'} ${res.def.name} (${outcome.running ? 'already running' : 'started'})`);
}

/**
 * What an environment-prepare send means for the box: the agent's own refusal (`{ error }`) fails it; a send that
 * didn't reach the agent (the socket dropped, an RPC timeout) leaves it for its next hello, and the prepare timeout
 * bounds it; anything else is started. Pure, for the tests.
 */
export function prepareSendOutcome(sent: { answer: Record<string, unknown> | null } | { thrown: unknown }):
  { kind: 'fail'; reason: string } | { kind: 'wait'; reason: string } | { kind: 'started'; running: boolean } {
  if ('thrown' in sent) return { kind: 'wait', reason: errMsg(sent.thrown) };
  if (sent.answer && typeof sent.answer.error === 'string') return { kind: 'fail', reason: sent.answer.error };
  return { kind: 'started', running: sent.answer?.running === true };
}

/** The pool chain's own environment-status (project `pool`): setup done stops the box, failed fails it. */
export function parsePoolStatus(msg: Record<string, unknown>): { state: string; setup: string; setupCommit: Record<string, string> | null; log: string; error: string | null; exitCode: number | null; prepareId: string | null } | null {
  if (msg.projectId !== POOL_PROJECT_ID || !msg.status || typeof msg.status !== 'object') return null;
  const s = msg.status as Record<string, unknown>;
  const setup = s.setup && typeof s.setup === 'object' ? s.setup as Record<string, unknown> : {};
  return {
    state: typeof s.state === 'string' ? s.state : 'none',
    setup: typeof setup.state === 'string' ? setup.state : 'none',
    setupCommit: commitsOf(s.setupCommit as Prisma.JsonValue),
    log: typeof s.log === 'string' ? s.log.slice(-MAX_LOG_CHARS) : '',
    error: typeof setup.error === 'string' ? setup.error : null,
    // Set only when a setup step ran and exited: a clone or start failure before the chain carries none.
    exitCode: typeof setup.exitCode === 'number' && Number.isInteger(setup.exitCode) ? setup.exitCode : null,
    prepareId: typeof s.prepareId === 'string' ? s.prepareId : null,
  };
}

/**
 * What a pool chain's frame means for its box: prepared (the chain finished, its setup succeeded or the environment
 * has none), failed, or still going. Pure, for the tests.
 */
export function poolStatusOutcome(status: NonNullable<ReturnType<typeof parsePoolStatus>>): 'prepared' | 'failed' | 'pending' {
  // Only a settled chain (`ready`: environment-run.js sets it once its setup has run). While it is pending or running,
  // its state still carries the last chain's setup result: a refresh's starts from the prepare's `succeeded`.
  if ((status.setup === 'succeeded' || status.setup === 'none') && status.state === 'ready') return 'prepared';
  if (status.state === 'failed' || status.setup === 'failed') return 'failed';
  return 'pending';
}

async function onPoolStatus(ev: PoolBoxEvent): Promise<void> {
  const status = parsePoolStatus(ev.msg);
  if (!status) return;
  const row = await prisma.instance.findUnique({ where: { id: ev.instance.id } });
  if (!row || row.status !== 'env-preparing' || row.userId) return;
  // A refreshed box's agent re-sends the last prepare's state (setup succeeded, or none with the chain ready) at its
  // hello, before the refresh has run: only a frame from this refresh's own chain counts.
  const refreshing = row.refreshStartedAt;
  if (refreshing && status.prepareId !== refreshPrepareId(refreshing)) return;
  const outcome = poolStatusOutcome(status);
  if (outcome === 'prepared') {
    const preparedAt = new Date();
    // The commits setup ran at; an agent that didn't record them (an empty setup on an older one) leaves the heads the
    // box launched (or a refresh started) at.
    const commits = status.setupCommit ?? commitsOf(row.preparedCommit) ?? {};
    const why = status.setup === 'none' ? 'cloned; the environment has no setup' : 'setup succeeded';
    const stopped = await stopBack(row.id, row.ec2InstanceId, row.region, 'env-preparing', refreshing ? `refresh: ${why}` : why, {
      preparedCommit: commits, preparedAt, poolLog: null, refreshStartedAt: null,
    });
    if (stopped) {
      const took = Math.round((preparedAt.getTime() - (refreshing ?? row.createdAt).getTime()) / 1000);
      console.log(`[ENV-POOL] ${row.id}: ${refreshing ? 'refreshed' : 'prepared'} at ${Object.entries(commits).map(([r, s]) => `${r}@${s.slice(0, 7)}`).join(' ')} in ${took}s`);
      recordProductEvent('environment.setup', { user: null, box: row.id }, {
        outcome: 'succeeded', where: refreshing ? 'refresh' : 'pool', incremental: !!refreshing, environmentId: row.poolEnvironmentId, prepareSec: took,
      });
    }
    return;
  }
  if (outcome === 'failed') {
    // Only a setup step that ran and exited says the setup is broken (and holds the pool until it or a head changes).
    await failPrepare(row.id, status.error ?? 'setup failed', status.log || null, { setupRan: status.exitCode !== null });
  }
}

/**
 * `env-preparing` → `env-failed` with its log, and the box goes; the row stays for the environment's page, with the
 * hash and heads it launched at. A failure of setup itself (`setupRan`, Instance.poolSetupFailed) holds the pool
 * until the setup or a head changes (envPoolPlanner); anything else (an old image, the environment not resolving, a
 * clone, a timeout) only delays the next launch for that same hash and heads (ENV_POOL_RETRY_MS).
 */
async function failPrepare(id: string, reason: string, log: string | null, opts: { setupRan?: boolean } = {}): Promise<void> {
  const changed = await prisma.instance.updateMany({
    where: { id, userId: null, status: 'env-preparing' },
    data: {
      status: 'env-failed', provisioningError: reason.slice(0, 1000), poolLog: (log ? `${reason}\n\n${log}` : reason).slice(-MAX_LOG_CHARS), terminatedAt: new Date(),
      poolSetupFailed: opts.setupRan === true,
    },
  });
  if (!changed.count) return;
  console.warn(`[ENV-POOL] ${id}: prepare failed: ${reason}`);
  const row = await prisma.instance.findUnique({ where: { id } });
  const refresh = !!row?.refreshStartedAt;
  recordProductEvent('environment.setup', { user: null, box: id }, { outcome: 'failed', where: refresh ? 'refresh' : 'pool', incremental: refresh, environmentId: row?.poolEnvironmentId ?? null });
  dropInstanceAgent(id, 'its environment prepare failed');
  if (row) void terminateBox(row);
}

let stopListening: (() => void) | null = null;

/** Every process listens: a pool box's frames arrive on whichever process holds its socket. */
export function startEnvPool(): () => void {
  if (stopListening) return stopListening;
  const offHello = onPoolBoxFrame('hello', ev => { onPoolHello(ev).catch(err => console.error('[ENV-POOL] hello:', errMsg(err))); });
  const offStatus = onPoolBoxFrame('environment-status', ev => { onPoolStatus(ev).catch(err => console.error('[ENV-POOL] status:', errMsg(err))); });
  stopListening = () => { offHello(); offStatus(); stopListening = null; };
  return stopListening;
}

// ── What people see ──────────────────────────────────────────────────────────

/** An environment's pool, for its page and the create dialogs (GET /api/environments/:name). Null: it has none. */
export interface EnvPoolView {
  target: number;
  ready: number;
  preparing: number;
  /** The newest ready box's: when it was prepared, and at which commits. */
  preparedAt: string | null;
  preparedCommit: Record<string, string> | null;
  lastFailure: { at: string; log: string } | null;
  /** When its stopped boxes are next checked for a refresh (ENV_POOL_REFRESH_MINUTES after each was prepared or last checked); null with none. */
  nextRefreshAt: string | null;
}

export async function envPoolView(environmentId: string, name: string): Promise<EnvPoolView | null> {
  const target = (await envPoolTargets()).find(t => t.name === name)?.target ?? 0;
  const rows = await prisma.instance.findMany({
    where: { userId: null, poolEnvironmentId: environmentId, status: { in: ['env-preparing', 'env-stopping', 'env-stopped', 'env-failed'] } },
    select: {
      id: true, status: true, preparedAt: true, preparedCommit: true, poolLog: true, createdAt: true, poolSetupHash: true, refreshCheckedAt: true, refreshStartedAt: true,
      subnetId: true, terminatedAt: true, poolSetupFailed: true,
    },
  });
  if (target <= 0 && !rows.length) return null;
  const res = target > 0 ? await envPoolDefinitionByName(name) : null;
  const hash = res?.ok ? res.def.setupHash : null;
  const ready = rows.filter(r => r.status === 'env-stopped' && (!hash || r.poolSetupHash === hash))
    .sort((a, b) => (b.preparedAt?.getTime() ?? 0) - (a.preparedAt?.getTime() ?? 0));
  // The tick checks nothing while a failure that wasn't setup's is being waited out (planEnvPoolRefresh): nor does the page.
  const now = new Date();
  const views: EnvPoolRowView[] = rows.map(r => ({ ...r, status: r.status as EnvPoolStatus, preparedCommit: commitsOf(r.preparedCommit), setupFailed: r.poolSetupFailed }));
  const retryAt = res?.ok ? envPoolRetryAt(views, { ok: true, hash: res.def.setupHash, heads: res.def.heads }, ENV_POOL_RETRY_MS, now) : null;
  // A refresh's failure dates from the refresh, not the box's launch.
  const failed = rows.filter(r => r.status === 'env-failed').sort((a, b) => attemptAt(b).getTime() - attemptAt(a).getTime())[0];
  return {
    target,
    ready: ready.length,
    preparing: rows.filter(r => r.status === 'env-preparing' || r.status === 'env-stopping').length,
    preparedAt: ready[0]?.preparedAt?.toISOString() ?? null,
    preparedCommit: commitsOf(ready[0]?.preparedCommit),
    lastFailure: failed ? { at: attemptAt(failed).toISOString(), log: failed.poolLog ?? '' } : null,
    nextRefreshAt: target > 0 ? nextRefreshAt(ready, envPoolConfigFromEnv(process.env).refreshMs, now, retryAt)?.toISOString() ?? null : null,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
