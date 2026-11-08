/**
 * The orchestrator host's own Claude Code: `/usr/bin/claude` is root's npm global and
 * runs the Claude Code runner orchestrator, every host user's sessions and
 * this process's Software probe. This process runs as `termag`, so a run
 * crosses to root the way a box's gh update does (#1102): one sudoers line
 * lets it run one root-owned helper with one run id, and the helper starts
 * the templated root unit `claude-orchestrator-update@<run>.service`
 * (deploy/claude-orchestrator-update --run).
 *
 * The policy goes by file, never by argument: before the helper, this writes
 * `{floor, target}` for the run into requests/<run>.json (termag's, 0700),
 * which the root recipe reads as the termag user and validates (an exact
 * version or latest/stable, never below root's own floor file, never a
 * downgrade). The recipe writes its record into runs/<id>.json (root's, read
 * by the termag group) in the shape of a box's tool-update report, and this
 * reads it into `software_update_runs` (syncOrchestratorRuns). The boot run
 * (claude-orchestrator-floor.service, the floor only) writes one as well, with
 * the id `boot<kernel boot id>`, so each deploy's boot run shows on the tab.
 *
 * The runner orchestrator runs no turns, so a run try-restarts it whatever the
 * admin chose; host users' sessions on the old binary are counted, never
 * stopped (the restart choice is `none` only). Gated twice: the tool's own
 * enabled (claude-code-update-policy's mode, for the admin and the
 * orchestrator's fixed box context) and the host's
 * (orchestrator-claude-update-policy's mode, read for the orchestrator's
 * context). The nightly run (leader work, below) needs the host's mode auto
 * and Claude Code's not off, for that context alone (gate.ts). A missing or
 * malformed mode is off.
 */
import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import type { SoftwareUpdateRun, User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { jsonVariationForContext } from '../featureFlags';
import type { FlagBox } from '../featureFlags';
import { selfInventory } from '../software/collector';
import { CLAUDE_UPDATE_POLICY_FLAG, isClaudeVersion, parseClaudeUpdatePolicy, parseUpdateMode, type ClaudeUpdateRestart, type ToolUpdateMode } from '../claudeUpdatePolicy';
import { TOOL_REGISTRY, type ToolDescriptor, type ToolUpdatePolicy } from './components';
import { modeAuto, modeEnabled } from './gate';
import { isInFlight, isRunId, parseToolUpdateReport, reportCreate, reportUpdate, type RunTrigger } from './run';

export const ORCHESTRATOR_HOST = 'orchestrator';
/** The orchestrator host's own policy: `{mode?, target: "x.y.z" | null}`, read for its fixed box context. */
export const ORCHESTRATOR_CLAUDE_POLICY_FLAG = 'orchestrator-claude-update-policy';
/** The orchestrator host as a flag's box context: a manual run reads it with the admin, the nightly run alone. */
export const ORCHESTRATOR_LD_BOX: FlagBox = { id: 'termag-orchestrator', name: 'orchestrator', kind: 'orchestrator' };
export const ORCHESTRATOR_LD_CONTEXT = { kind: 'box', key: ORCHESTRATOR_LD_BOX.id, name: ORCHESTRATOR_LD_BOX.name, instanceKind: ORCHESTRATOR_LD_BOX.kind };

/** What packer/scripts/orchestrator-setup.sh installs; deploy/claude-orchestrator-update.sudoers names the helper. */
export const ORCHESTRATOR_UPDATE_HELPER = '/usr/local/libexec/termag/claude-orchestrator-update-start';
export const ORCHESTRATOR_UPDATE_UNIT_PATH = '/etc/systemd/system/claude-orchestrator-update@.service';
const stateDir = () => process.env.ORCHESTRATOR_CLAUDE_UPDATE_DIR || '/var/lib/claude-orchestrator-update';
const requestsDir = () => path.join(stateDir(), 'requests');
const recordsDir = () => path.join(stateDir(), 'runs');

/** The marker the root recipe writes with a quarantine; the runner orchestrator's unit does not start while it exists. */
export const runnerHeld = (): boolean => existsSync(path.join(stateDir(), 'runner-held'));

/** The argv the sudoers line allows, word for word. */
export const helperArgv = (runId: string): string[] => ['-n', ORCHESTRATOR_UPDATE_HELPER, runId];

/** The host can take a run: the image installed the helper and the unit (an older image, or a container, cannot). */
export function orchestratorCapable(exists: (p: string) => boolean = existsSync): boolean {
  return exists(ORCHESTRATOR_UPDATE_HELPER) && exists(ORCHESTRATOR_UPDATE_UNIT_PATH);
}

/**
 * The two policy flags one decision about the orchestrator host reads, each
 * once: the tool's (claude-code-update-policy, for the admin and the
 * orchestrator's fixed box context, or that context alone for the nightly
 * run) and orchestrator-claude-update-policy's raw value (for the
 * orchestrator's context, as always), whose mode and target are parsed from it.
 */
export interface OrchestratorFlags { shared: ToolUpdatePolicy; host: unknown }

export async function orchestratorFlags(tool: ToolDescriptor, admin: User | null): Promise<OrchestratorFlags> {
  const [shared, host] = await Promise.all([
    admin ? tool.policy(admin, ORCHESTRATOR_LD_BOX) : jsonVariationForContext(CLAUDE_UPDATE_POLICY_FLAG, ORCHESTRATOR_LD_CONTEXT, null).then(v => parseClaudeUpdatePolicy(v)),
    jsonVariationForContext(ORCHESTRATOR_CLAUDE_POLICY_FLAG, ORCHESTRATOR_LD_CONTEXT, null),
  ]);
  return { shared, host };
}

/** orchestrator-claude-update-policy's `mode` (gate.ts): off when it has none, or a malformed one. */
export function parseOrchestratorMode(value: unknown): ToolUpdateMode {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).mode : null;
  return parseUpdateMode(v, ORCHESTRATOR_CLAUDE_POLICY_FLAG);
}

/**
 * Both gates, for the admin asking and the orchestrator: the tool's enabled
 * (claude-code-update-policy's mode not off) and the host's
 * (orchestrator-claude-update-policy's mode not off). Pass the flags already
 * read for the decision.
 */
export async function orchestratorUpdateEnabled(tool: ToolDescriptor, admin: User, flags?: OrchestratorFlags): Promise<boolean> {
  const f = flags ?? await orchestratorFlags(tool, admin);
  return modeEnabled(parseOrchestratorMode(f.host)) && await tool.enabled(admin, ORCHESTRATOR_LD_BOX, f.shared);
}

/**
 * Whether the nightly run is on, for the orchestrator's context alone: the
 * host's mode is auto, and Claude Code's own update is on (its mode not off).
 */
export function orchestratorNightlyOn(flags: OrchestratorFlags): boolean {
  return modeAuto(parseOrchestratorMode(flags.host)) && modeEnabled(flags.shared.mode);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── the root side, through sudo and files ───────────────────────────────────

/** `{floor, target}` for the run, where the root recipe reads it: written whole, then renamed into place. */
/**
 * What a run on the orchestrator host is told: the floor is shared with the boxes
 * (claude-code-update-policy's, and the recipe raises it to the image's
 * floor file), and the target comes only from orchestrator-claude-update-policy
 * and is only ever an exact version. Anything else there, a tag included,
 * is no target: the floor only. So nothing reaches the control plane but a
 * version someone pinned on purpose, and a pin below what runs is a way back
 * down (never below the floor).
 */
export interface OrchestratorPolicy { floor: string; target: string | null }

/** orchestrator-claude-update-policy's value: its exact `target`, or null (the floor only). A tag is refused and logged. */
export function parseOrchestratorTarget(value: unknown): string | null {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).target : null;
  if (v === null || v === undefined) return null;
  if (isClaudeVersion(v)) return v;
  console.warn(`[TOOL-UPDATE] orchestrator: ${ORCHESTRATOR_CLAUDE_POLICY_FLAG} target ${JSON.stringify(v).slice(0, 60)} is not an exact version; refused, the floor only`);
  return null;
}

/** The policy for a run on the orchestrator host, from the flags read for the admin asking (the floor's context) or the nightly run. */
export function orchestratorPolicyFrom(flags: OrchestratorFlags): OrchestratorPolicy {
  return { floor: flags.shared.floor, target: parseOrchestratorTarget(flags.host) };
}

/** The same, read now, for the admin asking or the nightly run (null). */
export async function orchestratorPolicy(tool: ToolDescriptor, admin: User | null): Promise<OrchestratorPolicy> {
  return orchestratorPolicyFrom(await orchestratorFlags(tool, admin));
}

const parseVer = (v: string) => v.split('.').map(Number);
/** a >= b for two x.y.z versions. */
export function atLeast(a: string, b: string): boolean {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/**
 * With no pin, a run only brings the host up to the floor: none would install
 * anything while the host is at or above it. Not while a quarantine holds the
 * runner orchestrator: the inventory can still show the last good version,
 * and a floor-only run is what reinstalls, verifies and releases it (Bugbot
 * on #1165).
 */
export function floorOnlyNothingToDo(policy: OrchestratorPolicy, current: string | null, held: boolean = runnerHeld()): boolean {
  return !held && !policy.target && !!current && isClaudeVersion(current) && atLeast(current, policy.floor);
}

export async function writeRequest(runId: string, policy: OrchestratorPolicy): Promise<void> {
  if (!isRunId(runId)) throw new Error('not a run id');
  const dir = requestsDir();
  const tmp = path.join(dir, `.${runId}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ floor: policy.floor, target: policy.target }), { mode: 0o600 });
  await fs.rename(tmp, path.join(dir, `${runId}.json`));
}

/** sudo -n <helper> <run>: the helper starts the unit without waiting. Resolves the refusal's text, or null when started. */
export function startHelper(runId: string): Promise<string | null> {
  return new Promise(resolve => {
    if (!isRunId(runId)) { resolve('not a run id'); return; }
    execFile('sudo', helperArgv(runId), { timeout: 30_000 }, (err, _stdout, stderr) => {
      resolve(err ? (String(stderr).trim() || err.message).slice(0, 500) : null);
    });
  });
}

// ── rows ────────────────────────────────────────────────────────────────────

async function runInFlight(now: number, db: Pick<typeof prisma, 'softwareUpdateRun'> = prisma): Promise<SoftwareUpdateRun | null> {
  const rows = await db.softwareUpdateRun.findMany({ where: { hostKey: ORCHESTRATOR_HOST, component: 'claude', status: { in: ['requested', 'running'] } }, orderBy: { requestedAt: 'desc' } });
  return rows.find(r => isInFlight(r, now)) ?? null;
}

/** As runs.ts claims a box's run: under the same advisory lock, at most one in flight. */
async function claimRun(trigger: RunTrigger, target: string | null, requestedById: string | null, now: number): Promise<SoftwareUpdateRun | null> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tool-update:${ORCHESTRATOR_HOST}:claude`}))`;
    if (await runInFlight(now, tx)) return null;
    return tx.softwareUpdateRun.create({
      data: { hostKey: ORCHESTRATOR_HOST, instanceId: null, component: 'claude', trigger, restart: 'none', status: 'requested', target, requestedById },
    });
  }, { timeout: 20_000, maxWait: 10_000 });
}

// ── the records ─────────────────────────────────────────────────────────────

const imported = new Set<string>();

/**
 * Read the root recipe's records into their runs: a requested run's record
 * ends it (done or failed), a boot run's creates its row once. Then the
 * request file goes and the inventory is asked again. Never throws; returns
 * how many it wrote. A record this process already handled is skipped.
 */
export async function syncOrchestratorRuns(now: Date = new Date()): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(recordsDir()); } catch { return 0; }
  let wrote = 0;
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!isRunId(id) || imported.has(id)) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(recordsDir(), name), 'utf8')) as unknown;
      const r = parseToolUpdateReport(raw);
      if ('error' in r || r.component !== 'claude' || r.run !== id) { console.warn(`[TOOL-UPDATE] orchestrator: record ${id} unreadable: ${'error' in r ? r.error : 'not this run'}`); imported.add(id); continue; }
      const sessions = r.sessions ? { ...r.sessions } : Prisma.DbNull;
      if (r.trigger === 'boot') {
        if (!await prisma.softwareUpdateRun.findUnique({ where: { id } })) {
          // Dated when the boot run wrote it, not when this read it.
          const at = (await fs.stat(path.join(recordsDir(), name))).mtime;
          await prisma.softwareUpdateRun.create({ data: { ...reportCreate(ORCHESTRATOR_HOST, ORCHESTRATOR_HOST, r, at), id, instanceId: null, sessions } });
          wrote++;
        }
      } else {
        const run = await prisma.softwareUpdateRun.findUnique({ where: { id } });
        if (run && run.hostKey === ORCHESTRATOR_HOST) {
          const res = await prisma.softwareUpdateRun.updateMany({
            where: { id, status: { in: ['requested', 'running', 'expired'] } },
            // The trigger the run was asked with stays (the recipe cannot tell manual from nightly).
            data: { ...reportUpdate(run, r, now), sessions },
          });
          wrote += res.count;
        }
        await fs.rm(path.join(requestsDir(), `${id}.json`), { force: true }).catch(() => {});
      }
      imported.add(id);
      console.log(`[TOOL-UPDATE] orchestrator: ${r.trigger} run ${id}: ${r.outcome} ${r.fromVersion ?? '?'} -> ${r.toVersion ?? '?'} (${r.detail ?? ''})`);
    } catch (err) {
      console.warn(`[TOOL-UPDATE] orchestrator: record ${id}: ${errMsg(err)}`);
    }
  }
  if (wrote) void selfInventory().catch(err => console.warn(`[TOOL-UPDATE] orchestrator inventory failed: ${errMsg(err)}`));
  return wrote;
}

/** Follow a started run: read records every 5 s until it has one, at most the run unit's 15 minutes and a margin. */
const FOLLOW_EVERY_MS = 5_000;
const FOLLOW_FOR_MS = 20 * 60_000;
function follow(runId: string): void {
  const until = Date.now() + FOLLOW_FOR_MS;
  const timer = setInterval(() => {
    void (async () => {
      await syncOrchestratorRuns();
      if (imported.has(runId) || Date.now() > until) clearInterval(timer);
    })();
  }, FOLLOW_EVERY_MS);
  timer.unref?.();
}

// ── a run ───────────────────────────────────────────────────────────────────

export type OrchestratorAnswer =
  | { status: 200 | 202; body: Record<string, unknown> }
  | { status: 404 | 409 | 502; body: { code: string; error?: string; runId?: string } };

const OFF = { status: 404 as const, body: { code: 'claude_update_off' } };

/**
 * Start one run with this policy: the row, the request file, the helper. A
 * refusal from sudo or the helper ends the run `refused`; otherwise it is
 * `running` (the unit is started; the record ends it).
 */
async function startRun(trigger: RunTrigger, policy: OrchestratorPolicy, requestedBy: User | null, now: number): Promise<OrchestratorAnswer> {
  if (!orchestratorCapable()) return { status: 409, body: { code: 'not_capable', error: 'this orchestrator image has no claude-orchestrator-update helper' } };
  await syncOrchestratorRuns();
  const run = await claimRun(trigger, policy.target, requestedBy?.id ?? null, now);
  if (!run) return { status: 409, body: { code: 'run_in_flight' } };
  let refused: string | null;
  try {
    await writeRequest(run.id, policy);
    refused = await startHelper(run.id);
  } catch (err) {
    refused = `could not write the run's request: ${errMsg(err)}`;
  }
  if (refused) {
    await prisma.softwareUpdateRun.updateMany({ where: { id: run.id, status: 'requested' }, data: { status: 'refused', finishedAt: new Date(), detail: refused.slice(0, 2000) } });
    await fs.rm(path.join(requestsDir(), `${run.id}.json`), { force: true }).catch(() => {});
    console.warn(`[TOOL-UPDATE] orchestrator: ${trigger} run ${run.id} refused: ${refused}`);
    return { status: 502, body: { code: 'helper_refused', error: refused, runId: run.id } };
  }
  await prisma.softwareUpdateRun.updateMany({ where: { id: run.id, status: 'requested' }, data: { status: 'running', startedAt: new Date() } });
  console.log(`[TOOL-UPDATE] ${requestedBy ? requestedBy.unixUsername : 'the nightly run'} asks the orchestrator host to update Claude Code to ${policy.target ?? 'the floor only'} (floor ${policy.floor}): ${trigger} run ${run.id}`);
  follow(run.id);
  return { status: 202, body: { runId: run.id, acknowledged: true } };
}

/** The Software tab's preview of the orchestrator row: what a run would do. */
export async function orchestratorPreview(tool: ToolDescriptor, admin: User, current: string | null, now: number = Date.now()): Promise<OrchestratorAnswer> {
  const flags = await orchestratorFlags(tool, admin);
  if (!await orchestratorUpdateEnabled(tool, admin, flags)) return OFF;
  await syncOrchestratorRuns();
  const policy = orchestratorPolicyFrom(flags);
  const run = await runInFlight(now);
  return {
    status: 200,
    body: {
      hostKey: ORCHESTRATOR_HOST, kind: 'orchestrator', connected: true, capable: orchestratorCapable(), current, target: policy.target, floor: policy.floor,
      // No pin in orchestrator-claude-update-policy: a run only brings the host up to the floor, and
      // with the host at or above it there is nothing to offer (the row says how to move it).
      floorOnly: !policy.target, nothingToDo: floorOnlyNothingToDo(policy, current),
      liveSessions: 0, busySessions: 0, restarts: ['none'],
      // The root recipe's hold: an install it could neither verify nor put back was quarantined, and the
      // runner orchestrator is stopped and kept from starting until a run installs a verified version.
      runnerHeld: runnerHeld(),
      runInFlight: run ? { id: run.id, status: run.status, trigger: run.trigger, requestedAt: run.requestedAt.toISOString() } : null,
    },
  };
}

/** POST /api/admin/software/hosts/orchestrator/update. Only restart none: host sessions are counted, not stopped. */
export async function requestOrchestratorUpdate(tool: ToolDescriptor, restart: ClaudeUpdateRestart, admin: User, now: number = Date.now(), current: string | null = null): Promise<OrchestratorAnswer> {
  const flags = await orchestratorFlags(tool, admin);
  if (!await orchestratorUpdateEnabled(tool, admin, flags)) return OFF;
  if (restart !== 'none') return { status: 409, body: { code: 'restart_not_supported', error: 'the orchestrator host restarts only its runner orchestrator; host users’ sessions keep running (restart none)' } };
  if (!orchestratorCapable()) return { status: 409, body: { code: 'not_capable', error: 'this orchestrator image has no claude-orchestrator-update helper' } };
  const policy = orchestratorPolicyFrom(flags);
  if (floorOnlyNothingToDo(policy, current)) return { status: 409, body: { code: 'floor_only', error: `no version is pinned in ${ORCHESTRATOR_CLAUDE_POLICY_FLAG}, and the host is at or above the floor ${policy.floor}: nothing to install` } };
  return startRun('manual', policy, admin, now);
}

// ── the nightly run ─────────────────────────────────────────────────────────

export const NIGHTLY_EVERY_MS = 24 * 3600_000;
const SWEEP_MS = 5 * 60_000;

/** A failed run (a target that did not resolve, a runner that did not stay up) is tried again this much later. */
export const NIGHTLY_RETRY_MS = 3600_000;

/**
 * Whether the nightly run is due: the host can take one, none is in flight,
 * no manual or nightly run that did not fail started in the last 24 hours (a
 * boot run only applies the floor, so it does not count), and none that
 * failed in the last hour. A failed run is not the day's run: the next
 * try comes an hour later, not a day. Pure.
 */
export function nightlyDue(input: { capable: boolean; inFlight: boolean; lastRunAt: Date | null; lastFailedAt?: Date | null; now: number }): boolean {
  if (!input.capable || input.inFlight) return false;
  if (input.lastFailedAt && input.now - input.lastFailedAt.getTime() < NIGHTLY_RETRY_MS) return false;
  return !input.lastRunAt || input.now - input.lastRunAt.getTime() >= NIGHTLY_EVERY_MS;
}

/**
 * Leader work every 5 minutes: read the root recipe's records (the boot run's
 * included), then, when orchestrator-claude-update-policy's mode is auto and
 * claude-code-update-policy's is not off, for the orchestrator's context,
 * start the nightly run once in 24 hours. The
 * target is the policy's for that context. The runner orchestrator runs no
 * turns, so any hour will do. Never throws.
 */
export async function orchestratorNightlyTick(now: number = Date.now()): Promise<'off' | 'not-due' | 'floor-only' | 'started' | 'refused'> {
  try {
    await syncOrchestratorRuns(new Date(now));
    const flags = await orchestratorFlags(TOOL_REGISTRY.claude, null);
    if (!orchestratorNightlyOn(flags)) return 'off';
    const runs = { hostKey: ORCHESTRATOR_HOST, component: 'claude', trigger: { in: ['manual', 'nightly'] } };
    const last = await prisma.softwareUpdateRun.findFirst({ where: { ...runs, status: { notIn: ['refused', 'expired', 'failed'] } }, orderBy: { requestedAt: 'desc' } });
    const lastFailed = await prisma.softwareUpdateRun.findFirst({ where: { ...runs, status: 'failed' }, orderBy: { requestedAt: 'desc' } });
    if (!nightlyDue({ capable: orchestratorCapable(), inFlight: !!await runInFlight(now), lastRunAt: last?.requestedAt ?? null, lastFailedAt: lastFailed?.requestedAt ?? null, now })) return 'not-due';
    const policy = orchestratorPolicyFrom(flags);
    // No pin, and the host is at or above the floor (the boot run sees to that): nothing to run.
    const current = (await prisma.hostSoftware.findFirst({ where: { hostKey: ORCHESTRATOR_HOST, component: 'claude', ok: true }, select: { version: true } }))?.version ?? null;
    if (floorOnlyNothingToDo(policy, current)) return 'floor-only';
    const answer = await startRun('nightly', policy, null, now);
    return answer.status === 202 ? 'started' : 'refused';
  } catch (err) {
    console.error(`[TOOL-UPDATE] orchestrator nightly run failed: ${errMsg(err)}`);
    return 'refused';
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
export function startOrchestratorClaudeSweep(): void {
  if (sweepTimer) return;
  // The boot run's record is there before this process starts: read it a minute in.
  firstTimer = setTimeout(() => { void orchestratorNightlyTick(); }, 60_000);
  firstTimer.unref?.();
  sweepTimer = setInterval(() => { void orchestratorNightlyTick(); }, SWEEP_MS);
  sweepTimer.unref?.();
}
export function stopOrchestratorClaudeSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
}

/** Tests: forget which records were read. */
export function resetOrchestratorRecordsForTest(): void { imported.clear(); }
