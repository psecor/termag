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
 * (`env-stopping`); failure terminates the box, its row kept `terminated`
 * with the log for the environment's page (failPrepare).
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
 * interval; a refresh that fails is terminated, as a prepare's is. A claim
 * takes only `env-stopped` rows, so a box is never handed out half-refreshed.
 */

import { ec2For, startBox } from './ec2Box';
import { createHash, randomBytes } from 'crypto';
import { DescribeInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { Prisma, type Instance } from '@prisma/client';
import { prisma } from '../db';
import { envPoolConfigFromEnv, type EnvPoolConfig } from '../config/env';
import { getBoxConfig, isCapacityRefusal, provisionEnvPoolBox, terminateBox } from './boxProvisioner';
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
import { attemptAt, failureHold, holdingFailure, nextRefreshAt, planEnvironmentPool, planEnvPoolRefresh, type EnvPoolCurrent, type EnvPoolFailureView, type EnvPoolRowView, type EnvPoolStatus } from './envPoolPlanner';
import { dropInstanceAgent, isInstanceAgentConnected, onPoolBoxFrame, sendToInstanceAgent, type PoolBoxEvent } from './agentRegistry';
import { recordProductEvent } from './productEvents';
import { describeOnWarmRun, envPoolOnWarmUpdate, parseOnWarmReport } from './onWarmStatus';
import { failRoot } from './tracing/spans';

/** The agent's capability for the environment-prepare RPC (agent/environment-prepare.js). */
export const ENV_PREPARE_CAPABILITY = 'environment-prepare-v1';

/** The project id a pool box's prepare chain reports under: no real project is ever called this. */
export const POOL_PROJECT_ID = 'pool';

const MAX_LOG_CHARS = 4000;
const PREPARE_RPC_TIMEOUT_MS = 30_000;
/** How long a failed prepare or refresh holds its pool at the setup hash and heads it ran at (envPoolPlanner failureHold). */
export const ENV_POOL_RETRY_MS = 60 * 60 * 1000;

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

/**
 * Each pooled environment's resolution from the tick's last pass, by name (as lastWarmPoolTick() is the warm pool's):
 * what a claim (POST /api/instances) and the polled GET /api/environments/:id/pool read, so neither waits on GitHub.
 * The tick replaces it every pass; a stale hash only makes a claim miss, since the claim statement filters on it.
 */
/** Keyed by name; `of` is the `updatedAt` of the environment row each was resolved from. */
const lastResolutions = new Map<string, { of: Date; value: EnvPoolResolution }>();

/**
 * The tick's last resolution of the environment; null before the tick has resolved it, and null when the environment's
 * row changed after (an edit of its setup, repositories or size): a box must never be prepared, nor claimed, for a
 * definition the environment no longer has. A hello then resolves afresh; a claim misses until the next tick.
 * `updatedAt` is the row's as the caller read it.
 */
export function lastEnvPoolResolution(env: Pick<EnvironmentRecord, 'name' | 'updatedAt'>): EnvPoolResolution | null {
  const stored = lastResolutions.get(env.name);
  if (!stored || stored.of.getTime() < env.updatedAt.getTime()) return null;
  return stored.value;
}

/** Resolve the environment now (GitHub, with the pool credential) and keep it for the readers above. The tick's only. */
export async function resolveForTick(env: EnvironmentRecord, deps: EnvPoolDeps = defaultEnvPoolDeps): Promise<EnvPoolResolution> {
  let value: EnvPoolResolution;
  try {
    value = await resolveEnvPoolDefinition(env, deps);
  } catch (err) {
    value = { ok: false, reason: errMsg(err) };
  }
  // Stamped with the row it was resolved from: any edit after that row, landing before or during the resolve, is newer,
  // so the readers above take this resolution as stale.
  lastResolutions.set(env.name, { of: env.updatedAt, value });
  return value;
}

/** Test hook: what the tick would have stored. */
export function setLastEnvPoolResolutionForTests(name: string, value: EnvPoolResolution | null, of: Date = new Date()): void {
  if (value) lastResolutions.set(name, { of, value });
  else lastResolutions.delete(name);
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

/**
 * Rows an earlier pool left `env-failed` (a status the one failure rule replaced): moved to `terminated`, as the rule
 * writes a failure, so the teardown sweep cleans up what they hold and nothing else reads them. Done by the tick, not
 * only the migration, since deploys sync the schema with `prisma db push`. How many it moved.
 */
export async function retireEnvFailedRows(db: { instance: { updateMany(q: Prisma.InstanceUpdateManyArgs): Promise<{ count: number }> } }, now: Date): Promise<number> {
  const stamped = await db.instance.updateMany({ where: { status: 'env-failed', terminatedAt: null }, data: { status: 'terminated', terminatedAt: now } });
  const rest = await db.instance.updateMany({ where: { status: 'env-failed' }, data: { status: 'terminated' } });
  return stamped.count + rest.count;
}

/** One tick of every environment pool. Never throws. */
export async function reconcileEnvPools(now = new Date()): Promise<void> {
  if (!getBoxConfig()) return;
  const policy = envPoolConfigFromEnv(process.env);
  try {
    const legacy = await retireEnvFailedRows(prisma, now);
    if (legacy) console.log(`[ENV-POOL] ${legacy} env-failed row(s) moved to terminated; the teardown sweep cleans them up`);
    const rows = await selectEnvPoolRows();
    const targets = await envPoolTargets();
    if (!targets.length && !rows.length) return;

    await settleStops(rows.filter(r => r.status === 'env-stopping'));
    await putBackStrandedStarts(rows.filter(r => r.status === 'env-starting'), now, policy);

    // Every environment with a target, then any still holding boxes, at target 0 so its plan drains them.
    const byId = new Map<string, { env: EnvironmentRecord | null; target: number }>();
    for (const t of targets) {
      const env = await prismaEnvironmentStore.byName(t.name);
      if (!env) { console.warn(`[ENV-POOL] ${t.name}: there is no environment by that name; no pool`); continue; }
      byId.set(env.id, { env, target: t.target });
    }
    for (const r of rows) if (!byId.has(r.poolEnvironmentId)) byId.set(r.poolEnvironmentId, { env: null, target: 0 });

    let inFlight = rows.filter(r => r.status === 'env-preparing').length;
    const subnets = (() => { const c = getBoxConfig()!; return [c.subnetId, ...c.fallbackSubnetIds]; })();
    for (const [environmentId, group] of byId) {
      const own = rows.filter(r => r.poolEnvironmentId === environmentId);
      let current: EnvPoolCurrent = { ok: false, reason: 'no longer pooled' };
      let def: EnvPoolDefinition | null = null;
      const name = group.env?.name ?? null;
      if (group.env && group.target > 0) {
        const res = await resolveForTick(group.env);
        if (res.ok) { def = res.def; current = { ok: true, hash: def.setupHash, heads: def.heads }; }
        else { current = { ok: false, reason: res.reason }; console.warn(`[ENV-POOL] ${name}: ${res.reason}; holding its pool as it is`); }
      }
      const plan = planEnvironmentPool({
        rows: own, current, target: group.target,
        headroom: Math.max(0, policy.maxInFlight - inFlight),
        subnets, prepareTimeoutMs: policy.prepareTimeoutMs,
        lastFailure: def ? await lastFailureOf(environmentId, now, current) : null, holdMs: ENV_POOL_RETRY_MS, now,
      });
      inFlight += plan.launch.length;
      console.log(`[ENV-POOL] tick ${name ?? environmentId} target=${group.target} stopped=${plan.supply.stopped} preparing=${plan.supply.preparing} launch=${plan.launch.length} retire=${plan.retire.length} fail=${plan.fail.length}${plan.held ? ` held-by=${plan.held.rowId} until=${plan.held.until.toISOString()}` : ''}`);
      for (const f of plan.fail) await failPrepare(f.id, f.reason, null);
      for (const r of plan.retire) await retireRow(own.find(o => o.id === r.id)!, r.reason);
      let launched = 0;
      if (def) for (const l of plan.launch) if (await launchEnvPoolBox(def, l.subnetId, group.target, policy)) launched++;

      // The refresh: what the launches leave of the in-flight cap, oldest prepared first.
      if (!def) continue;
      const check = planEnvPoolRefresh({ rows: own, stoppedRows: plan.stoppedRows, current, held: plan.held, intervalMs: policy.refreshMs, now, launched });
      if (check.skip.length) {
        await prisma.instance.updateMany({ where: { id: { in: check.skip.map(k => k.id) }, userId: null, status: 'env-stopped' }, data: { refreshCheckedAt: now } });
        for (const k of check.skip) console.log(`[ENV-POOL] refresh ${name}: skip ${k.id} (every default branch is where it was prepared)`);
      }
      // Held rows stay due (no refreshCheckedAt): the tick line's blocked-by says why, and they go once it lifts.
      for (const id of check.refresh) {
        if (inFlight >= policy.maxInFlight) {
          console.log(`[ENV-POOL] refresh ${name}: ${check.refresh.length - check.refresh.indexOf(id)} due, waiting for the in-flight cap (${policy.maxInFlight})`);
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
      id: true, status: true, poolSetupHash: true, preparedCommit: true, preparedAt: true, createdAt: true, subnetId: true,
      poolEnvironmentId: true, ec2InstanceId: true, region: true, claimedAt: true, cleanedUpAt: true,
      refreshStartedAt: true, refreshCheckedAt: true,
    },
  });
  return rows.map(r => ({
    ...r,
    status: r.status as EnvPoolStatus,
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

/**
 * A failed prepare or refresh of a pool: a `terminated` row of the environment that keeps the reason and the log it
 * failed with (failPrepare, and boxProvisioner's markFailed for a launch). A retired row has no reason; a claim's
 * abandoned start clears the log (envPoolClaim.ts). Ownerless only: a claimed box keeps its pool columns, and a
 * failure after its claim is its owner's box's, not the pool's.
 */
export function poolFailureWhere(environmentId: string, since: Date): Prisma.InstanceWhereInput {
  return { userId: null, poolEnvironmentId: environmentId, status: 'terminated', provisioningError: { not: null }, poolLog: { not: null }, terminatedAt: { gte: since } };
}

/**
 * The failure within the hold at what the environment is now (its setup hash and heads), for the planner's one failure
 * rule: the newest of those, not the newest overall, so a branch reset to heads that failed is still held after a
 * newer failure at other heads.
 */
async function lastFailureOf(environmentId: string, now: Date, current: EnvPoolCurrent): Promise<EnvPoolFailureView | null> {
  if (!current.ok) return null;
  const rows = await prisma.instance.findMany({
    where: { ...poolFailureWhere(environmentId, new Date(now.getTime() - ENV_POOL_RETRY_MS)), poolSetupHash: current.hash },
    orderBy: { terminatedAt: 'desc' },
    select: { id: true, poolSetupHash: true, preparedCommit: true, terminatedAt: true },
  });
  return holdingFailure(rows.flatMap(r => r.terminatedAt
    ? [{ id: r.id, poolSetupHash: r.poolSetupHash, preparedCommit: commitsOf(r.preparedCommit), failedAt: r.terminatedAt }] : []), current);
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
      const ec2 = ec2For(r);
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
    if (ec2InstanceId) await ec2For({ region }).send(new StopInstancesCommand({ InstanceIds: [ec2InstanceId] }));
    console.log(`[ENV-POOL] ${id}: stopping (${why})`);
    return true;
  } catch (err) {
    console.error(`[ENV-POOL] ${id}: stop (${why}) failed:`, errMsg(err));
    return false;
  }
}

async function retireRow(row: EnvPoolRow, reason: string): Promise<void> {
  const changed = await prisma.instance.updateMany({
    where: { id: row.id, userId: null, status: { in: ['env-preparing', 'env-stopping', 'env-stopped'] } },
    // No reason: a retired box is no failure (poolFailureWhere).
    data: { status: 'terminated', terminatedAt: new Date(), provisioningError: null },
  });
  if (!changed.count) return;
  console.log(`[ENV-POOL] retire ${row.id}: ${reason}`);
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
        // preparedCommit is what this attempt is at, as a launch's is: a failed refresh keeps it with the hash, and holds
        // the pool at them (envPoolPlanner failureHold).
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
    // The same start as a claim's: no capacity for its type tries another of the same shape (ec2Box.startBox).
    const box = await prisma.instance.findUnique({ where: { id: row.id } });
    if (!box) throw new Error('its row is gone');
    const { fallbackType } = await startBox(ec2For(box), box);
    if (fallbackType) console.log(`[ENV-POOL] refresh ${row.id}: started on fallback ${fallbackType}`);
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
  // The tick's last resolution, else one now: a restart loses it, and an edit of the environment since the tick makes
  // it stale. A retry reads it again, so it sees what the next tick resolved.
  const res = env ? lastEnvPoolResolution(env) ?? await resolveForTick(env) : null;
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
export function parsePoolStatus(msg: Record<string, unknown>): { state: string; setup: string; setupCommit: Record<string, string> | null; log: string; error: string | null; exitCode: number | null; prepareId: string | null; onWarm: { onWarmStatus: string; onWarmSeconds: number } | null } | null {
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
    // This prepare's own on-warm outcome (a refresh's skip included), from an agent that sends it.
    onWarm: onWarmOfFrame(s.onWarm),
  };
}

function onWarmOfFrame(v: unknown): { onWarmStatus: string; onWarmSeconds: number } | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (typeof w.state !== 'string' || !['succeeded', 'failed', 'skipped'].includes(w.state)) return null;
  return { onWarmStatus: w.state, onWarmSeconds: typeof w.seconds === 'number' && Number.isFinite(w.seconds) ? Math.max(0, Math.round(w.seconds)) : 0 };
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

/**
 * A preparing box's on-warm run (the warm pool's hook, which its prepare runs before setup): recorded on the row,
 * never failing it. A failure is kept with the box when it stops (poolLog), for the pool page.
 */
async function onPoolOnWarm(ev: PoolBoxEvent): Promise<void> {
  const report = parseOnWarmReport(ev.msg);
  if (!report) return;
  const changed = await prisma.instance.updateMany(envPoolOnWarmUpdate(ev.instance.id, report));
  if (!changed.count || report.state === 'running') return;
  console.log(`[ENV-POOL] ${ev.instance.id}: on-warm ${describeOnWarmRun(report)}`);
  // A failure that arrives after the box was prepared (its setup was quicker than the forwarder): kept for the page.
  if (report.state === 'failed') {
    const row = await prisma.instance.findUnique({ where: { id: ev.instance.id }, select: { onWarmStatus: true, onWarmLog: true } });
    if (row) await prisma.instance.updateMany({ where: { id: ev.instance.id, userId: null, status: { in: ['env-stopping', 'env-stopped'] } }, data: { poolLog: onWarmPoolLog(row) } });
  }
}

/** What the pool page keeps of a prepared box's on-warm run: its failure, with the log; nothing when it succeeded. */
export function onWarmPoolLog(row: { onWarmStatus: string | null; onWarmLog: string | null }): string | null {
  return row.onWarmStatus === 'failed' ? `termag's warm-up (on-warm) failed; the box was prepared anyway\n\n${row.onWarmLog ?? ''}`.slice(-MAX_LOG_CHARS) : null;
}

/**
 * The pool page's view of a box's on-warm run, from its own on-warm columns (which every on-warm frame writes), so a
 * failure's log shows whatever the box's poolLog holds. Null when none ran.
 */
export function onWarmView(row: { onWarmStatus: string | null; onWarmSeconds: number | null; onWarmLog: string | null }): EnvPoolView['onWarm'] {
  if (!row.onWarmStatus) return null;
  return { state: row.onWarmStatus, seconds: row.onWarmSeconds, log: onWarmPoolLog(row) };
}

/** The on-warm run's part of a prepare event: whether it ran, how it ended, how long it took. */
export function onWarmEventProps(row: { onWarmStatus: string | null; onWarmSeconds: number | null }): { onWarm: string; onWarmSec: number | null } {
  return { onWarm: row.onWarmStatus ?? 'none', onWarmSec: row.onWarmSeconds ?? null };
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
      preparedCommit: commits, preparedAt, poolLog: onWarmPoolLog(row), refreshStartedAt: null,
    });
    if (stopped) {
      const took = Math.round((preparedAt.getTime() - (refreshing ?? row.createdAt).getTime()) / 1000);
      console.log(`[ENV-POOL] ${row.id}: ${refreshing ? 'refreshed' : 'prepared'} at ${Object.entries(commits).map(([r, s]) => `${r}@${s.slice(0, 7)}`).join(' ')} in ${took}s`);
      // The prepare's own on-warm outcome when its frame says it; else the on-warm columns as they are now (its frames
      // come separately, and the settled one may have landed since `row`).
      const onWarm = await prisma.instance.findUnique({ where: { id: row.id }, select: { onWarmStatus: true, onWarmSeconds: true } }).catch(() => null);
      recordProductEvent('environment.setup', { user: null, box: row.id }, {
        outcome: 'succeeded', where: refreshing ? 'refresh' : 'pool', incremental: !!refreshing, environmentId: row.poolEnvironmentId, prepareSec: took,
        ...onWarmEventProps(status.onWarm ?? onWarm ?? row),
      });
    }
    return;
  }
  if (outcome === 'failed') {
    // Only a setup step that ran and exited says the setup is broken (and holds the pool until it or a head changes).
    await failPrepare(row.id, status.error ?? 'setup failed', status.log || null, { onWarm: status.onWarm });
  }
}

/**
 * A failed prepare or refresh: `env-preparing` → `terminated`, keeping the reason, the log, and the setup hash and
 * heads it ran at, and the box goes. Whatever failed (the image, the environment not resolving, a clone, setup, a
 * timeout), it holds the pool at that hash and heads until either changes or ENV_POOL_RETRY_MS passes
 * (envPoolPlanner failureHold), and the environment's page shows its log.
 */
async function failPrepare(id: string, reason: string, log: string | null, opts: { onWarm?: { onWarmStatus: string; onWarmSeconds: number } | null } = {}): Promise<void> {
  const changed = await prisma.instance.updateMany({
    where: { id, userId: null, status: 'env-preparing' },
    data: {
      status: 'terminated', provisioningError: reason.slice(0, 1000), poolLog: (log ? `${reason}\n\n${log}` : reason).slice(-MAX_LOG_CHARS), terminatedAt: new Date(),
    },
  });
  if (!changed.count) return;
  console.warn(`[ENV-POOL] ${id}: prepare failed: ${reason}`);
  const row = await prisma.instance.findUnique({ where: { id } });
  const refresh = !!row?.refreshStartedAt;
  recordProductEvent('environment.setup', { user: null, box: id }, {
    outcome: 'failed', where: refresh ? 'refresh' : 'pool', incremental: refresh, environmentId: row?.poolEnvironmentId ?? null,
    // The prepare's own on-warm outcome when its frame says it (a refresh's skip), else the box's last run.
    ...(opts.onWarm ? onWarmEventProps(opts.onWarm) : row ? onWarmEventProps(row) : {}),
  });
  dropInstanceAgent(id, 'its environment prepare failed');
  if (row) void terminateBox(row);
}

let stopListening: (() => void) | null = null;

/** Every process listens: a pool box's frames arrive on whichever process holds its socket. */
export function startEnvPool(): () => void {
  if (stopListening) return stopListening;
  const offHello = onPoolBoxFrame('hello', ev => { onPoolHello(ev).catch(err => console.error('[ENV-POOL] hello:', errMsg(err))); });
  const offStatus = onPoolBoxFrame('environment-status', ev => { onPoolStatus(ev).catch(err => console.error('[ENV-POOL] status:', errMsg(err))); });
  const offOnWarm = onPoolBoxFrame('on-warm-status', ev => { onPoolOnWarm(ev).catch(err => console.error('[ENV-POOL] on-warm:', errMsg(err))); });
  stopListening = () => { offHello(); offStatus(); offOnWarm(); stopListening = null; };
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
  /** The newest ready box's on-warm run (the warm pool's hook, run during its prepare); null when none recorded one. */
  onWarm: { state: string; seconds: number | null; log: string | null } | null;
  /** When its stopped boxes are next checked for a refresh (ENV_POOL_REFRESH_MINUTES after each was prepared or last checked); null with none. */
  nextRefreshAt: string | null;
}

/**
 * The rows a claim would take now, newest prepared first: `env-stopped` at the current setup hash. The claim
 * (routes/instances.ts) takes from the tick's last resolution only, and misses without one (a restart, a new replica,
 * before the first tick) or with an unresolved one, so the pool card counts none ready then either.
 */
export function claimableRows<R extends { status: string; poolSetupHash: string | null; preparedAt: Date | null }>(rows: R[], res: EnvPoolResolution | null): R[] {
  if (!res?.ok) return [];
  const hash = res.def.setupHash;
  return rows.filter(r => r.status === 'env-stopped' && r.poolSetupHash === hash)
    .sort((a, b) => (b.preparedAt?.getTime() ?? 0) - (a.preparedAt?.getTime() ?? 0));
}

export async function envPoolView(environmentId: string, name: string, updatedAt: Date): Promise<EnvPoolView | null> {
  const target = (await envPoolTargets()).find(t => t.name === name)?.target ?? 0;
  const rows = await prisma.instance.findMany({
    where: { userId: null, poolEnvironmentId: environmentId, status: { in: ['env-preparing', 'env-stopping', 'env-stopped'] } },
    select: {
      status: true, preparedAt: true, preparedCommit: true, poolLog: true, createdAt: true, poolSetupHash: true, refreshCheckedAt: true, refreshStartedAt: true,
      onWarmStatus: true, onWarmSeconds: true, onWarmLog: true,
    },
  });
  if (target <= 0 && !rows.length) return null;
  // The tick's last resolution: this is polled by every open page, and never reads GitHub.
  const res = target > 0 ? lastEnvPoolResolution({ name, updatedAt }) : null;
  const ready = claimableRows(rows, res);
  // The newest failure of the last week, until a box prepares after it.
  const failure = await prisma.instance.findFirst({
    where: poolFailureWhere(environmentId, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)), orderBy: { terminatedAt: 'desc' }, select: { terminatedAt: true, poolLog: true },
  });
  const failed = failure?.terminatedAt && !(ready[0]?.preparedAt && ready[0].preparedAt > failure.terminatedAt) ? failure : null;
  // The tick checks nothing while a failure holds the pool (planEnvPoolRefresh): nor does the page.
  const now = new Date();
  const current: EnvPoolCurrent | null = res?.ok ? { ok: true, hash: res.def.setupHash, heads: res.def.heads } : null;
  const held = current ? failureHold({ current, lastFailure: await lastFailureOf(environmentId, now, current), holdMs: ENV_POOL_RETRY_MS, now }) : null;
  return {
    target,
    ready: ready.length,
    preparing: rows.filter(r => r.status === 'env-preparing' || r.status === 'env-stopping').length,
    preparedAt: ready[0]?.preparedAt?.toISOString() ?? null,
    preparedCommit: commitsOf(ready[0]?.preparedCommit),
    lastFailure: failed?.terminatedAt ? { at: failed.terminatedAt.toISOString(), log: failed.poolLog ?? '' } : null,
    onWarm: ready[0] ? onWarmView(ready[0]) : null,
    nextRefreshAt: target > 0 ? nextRefreshAt(ready, envPoolConfigFromEnv(process.env).refreshMs, now, held?.until ?? null)?.toISOString() ?? null : null,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
