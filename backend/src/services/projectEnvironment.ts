/**
 * A project's environment steps on its box ("The
 * steps"): `setup` once when a box made for the project has cloned it, then
 * `run`, the wait for `ports` to be healthy, and `seed`. The box does the work
 * (agent/environment-run.js, `termag-env`); the orchestrator asks for it after
 * the clone's launch (services/projectClone.ts) and keeps the box's reports on
 * the project (`Project.environmentStatus`), which both UIs show.
 *
 * Which file: an environment's own (`Project.environmentFile`, recorded when
 * the project was made from one), else a single repository's
 * `.termag/environment.json`. A multi-repo project made without an
 * environment runs nothing (the design's "no setup or run"). The box reads the
 * file in its checkout: the commit the steps run against. A repository's own
 * file is held, never run unattended: its owner's `termag-env up` runs it.
 *
 * When: only on a box made for the project, i.e. the box's first project (a
 * warm claim or a cold launch for it). A project added to a box that already
 * has others doesn't start anything on its own; `termag-env up` in its
 * checkout does.
 */
import { prisma } from '../db';
import { onBoxAgentFrame, projectAgentCapabilities, sendToInstanceAgent, type BoxAgentFrame } from './agentRegistry';
import { recordProductEvent } from './productEvents';
import { notifyWorkspaceChange } from './workspaceEvents';
import { repoEnvironment, type RepoEnvironmentReader } from './repoEnvironment';
import { repoKey } from './projectTemplates';
import { reposOutsideOrgs } from './environments';
import { boolVariation } from './featureFlags';

export const ENVIRONMENT_CAPABILITY = 'environment-v1';
const RPC_TIMEOUT_MS = 30_000;

/** Project.environmentFile (services/environments.ts environmentFileRecord): an inline file's text, or where the file is. */
export interface EnvironmentFileRef { name?: string; repo?: string; branch?: string; path?: string; text?: string; editedBy?: string }

const MAX_FILE_BYTES = 16 * 1024;

/** Project.environmentFile as stored, or null for anything else. */
export function parseEnvironmentFileRef(value: unknown): EnvironmentFileRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === 'string' ? { name: v.name } : {};
  const editedBy = typeof v.editedBy === 'string' && v.editedBy ? { editedBy: v.editedBy } : {};
  // Text over the cap is dropped. For a pointer only its pin is lost, so it stays that pointer, read from the box's
  // checkout (environmentUpRequest), never "no environment" (Bugbot, #998); an inline file has nothing left.
  const text = typeof v.text === 'string' && Buffer.byteLength(v.text, 'utf8') <= MAX_FILE_BYTES ? { text: v.text } : {};
  const pointer = typeof v.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v.repo)
    && typeof v.path === 'string' && !!v.path && !v.path.startsWith('/') && !v.path.split('/').some(p => p === '..' || p === '.' || p === '');
  // Inline: the text alone. A pointer: where it is, and its text when it was frozen at creation (freezeEnvironmentFile).
  if (!pointer) return 'text' in text ? { ...name, ...text, ...editedBy } : null;
  const branch = typeof v.branch === 'string' && /^[\w./-]+$/.test(v.branch) && !v.branch.includes('..') ? { branch: v.branch } : {};
  return { ...name, repo: v.repo as string, path: v.path as string, ...branch, ...text, ...editedBy };
}

/** How the file reads in the box's state and the UIs: `repo:branch:path`, or the environment's name for an inline one. */
function fileLabel(file: EnvironmentFileRef): string {
  if (!file.repo) return `${file.name ?? 'the environment'}'s file`;
  return `${file.repo}:${file.branch ?? '(default branch)'}:${file.path}`;
}

/**
 * The `environment-up` request for a project whose clone has landed, or why
 * none is sent: `automation` (never on its own), `not-first` (the box was not
 * made for it), `no-file` (a multi-repo project with no environment),
 * `outside-orgs` (its environment names a repository outside our GitHub
 * orgs). `fileText`: the file as the orchestrator read it (an inline file's
 * own, or a pointer's at its branch); without it the box reads the file in its
 * checkout.
 *
 * Picking an environment for a project is the consent for its steps (decision
 * #58, #998): an environment's definition starts on its own, with no trust
 * tick (the chat's Read only or Full access is its own). Only the project
 * owner's own personal environment, or a shared one, can be picked, and a
 * shared one runs only files on its repositories' default branches
 * (services/environments.ts sharedRuleError). A repository's own
 * `.termag/environment.json`, which nobody picked, is held: the box keeps it
 * and the owner's `termag-env up` runs it.
 */
export function environmentUpRequest(project: {
  id: string; instanceId: string; layout: string; environmentFile: unknown; dir: string; otherProjectsOnBox: number; chatTrustedAt?: Date | null; userId?: string; kind?: string;
}): { payload: Record<string, unknown> } | { skip: 'not-first' | 'no-file' | 'automation' | 'outside-orgs' } {
  const file = parseEnvironmentFileRef(project.environmentFile);
  if (file && reposOutsideOrgs(fileRepos(file)).length) return { skip: 'outside-orgs' };
  const where = (f: EnvironmentFileRef) => ({
    ...(f.repo ? { fileRepo: f.repo } : {}),
    filePath: f.text !== undefined ? fileLabel(f) : f.path,
    ...(f.text !== undefined ? { fileText: f.text } : {}),
  });
  // An automation starts nothing on its own, nor a project added to a box made for another. Either still gets its
  // environment's definition, held, so the owner's termag-env up runs what was chosen, not the checkout's file.
  const startsNothing = project.kind === 'automation' ? 'automation' : project.otherProjectsOnBox > 0 ? 'not-first' : null;
  if (startsNothing) {
    if (file?.text === undefined) return { skip: startsNothing };
    return { payload: { projectId: project.id, instanceId: project.instanceId, dir: project.dir, trusted: true, hold: startsNothing, ...where(file) } };
  }
  if (!file && project.layout === 'workspace') return { skip: 'no-file' };
  // `trusted` tells the box this request may run the steps: the project's environment was picked for it.
  const base = { projectId: project.id, instanceId: project.instanceId, dir: project.dir, trusted: true };
  if (!file) return { payload: { ...base, hold: 'checkout' } };
  return { payload: { ...base, ...where(file) } };
}

/** The repositories an environment file names: a pointer's own, and an inline or frozen definition's `repos`. */
function fileRepos(file: EnvironmentFileRef): string[] {
  const out = file.repo ? [file.repo] : [];
  if (file.text !== undefined) {
    try {
      const data = JSON.parse(file.text) as { repos?: unknown };
      if (Array.isArray(data.repos)) {
        for (const r of data.repos) {
          const name = typeof r === 'string' ? r : r && typeof r === 'object' && typeof (r as { repo?: unknown }).repo === 'string' ? (r as { repo: string }).repo : null;
          if (name) out.push(name.toLowerCase());
        }
      }
    } catch { /* not JSON: the box says so */ }
  }
  return out;
}

/**
 * A pointer frozen at creation: its file read once, now, with the creator's
 * credential, so the box later runs what was there when the project was made,
 * not what the pointer says by claim (Security Agent, #998). An inline
 * definition is frozen already. A pointer that can't be read stays a pointer:
 * environmentUpRequest sends it without text, and the box runs the file in its
 * checkout of the pointer's repository.
 */
export async function freezeEnvironmentFile<T extends EnvironmentFileRef & { name: string }>(
  userId: string, file: T, reader: Pick<RepoEnvironmentReader, 'text'> = repoEnvironment,
): Promise<T> {
  if (file.text !== undefined || !file.repo || !file.path) return file;
  const read = await reader.text(userId, file.repo, file.path, file.branch ?? null);
  if ('text' in read) return { ...file, text: read.text };
  console.warn(`[ENV] ${file.name}: ${read.error}; not pinned, so the box reads the file in its checkout`);
  return file;
}

/**
 * The flag that offers environments (backend/src/flags.ts): off, no environment-up is sent on a project's own,
 * and Share hides "This environment's app". termag-env on the box stays the person's own command either way.
 */
export const ENVIRONMENT_FLAG = 'environment-selection-enabled';

/** After a clone's launch (services/projectClone.ts 'launch'): ask the box to run the file's steps. Never throws. */
export async function startEnvironmentAfterClone(row: {
  id: string; userId: string; instanceId: string; layout: string; environmentFile: unknown; dir: string; chatTrustedAt: Date | null; kind: string;
}): Promise<void> {
  try {
    if (!projectAgentCapabilities({ userId: row.userId, instanceId: row.instanceId }).includes(ENVIRONMENT_CAPABILITY)) return;
    const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } });
    if (!owner || !(await boolVariation(ENVIRONMENT_FLAG, owner, true))) {
      console.log(`[ENV] ${row.id}: not started: ${ENVIRONMENT_FLAG} is off for its owner (termag-env up runs it)`);
      return;
    }
    const otherProjectsOnBox = await prisma.project.count({ where: { instanceId: row.instanceId, archived: false, id: { not: row.id } } });
    const req = environmentUpRequest({ ...row, otherProjectsOnBox });
    if ('skip' in req) {
      if (req.skip === 'automation') console.log(`[ENV] ${row.id}: not started: an automation's steps run only by termag-env up`);
      if (req.skip === 'outside-orgs') console.warn(`[ENV] ${row.id}: not started: its environment names a repository outside our GitHub orgs`);
      return;
    }
    // What started it, for the setup event: the claim.
    const answer = await sendToInstanceAgent(row.instanceId, 'environment-up', { ...req.payload, trigger: 'claim' }, RPC_TIMEOUT_MS) as Record<string, unknown> | null;
    if (answer && typeof answer.error === 'string') console.warn(`[ENV] ${row.id}: environment-up on ${row.instanceId}: ${answer.error}`);
    else if (answer && answer.held) console.log(`[ENV] ${row.id}: held on ${row.instanceId} (${String(answer.held)}): termag-env up runs it`);
    else if (answer && answer.started) console.log(`[ENV] ${row.id}: the box runs its environment's steps (${String(answer.session)})`);
  } catch (err) {
    console.error(`[ENV] ${row.id}: environment-up to ${row.instanceId} failed:`, (err as Error).message);
  }
}

const PHASE_STATES = new Set(['none', 'pending', 'running', 'succeeded', 'failed', 'skipped']);
const HOLD_REASONS = new Set(['untrusted', 'checkout', 'pointer', 'unpinned', 'not-authored', 'automation', 'not-first']);
const CHAIN_STATES = new Set(['none', 'pending', 'held', 'setup', 'starting', 'waiting', 'seeding', 'up', 'ready', 'failed', 'stopped']);

export interface EnvironmentPhase { state: string; startedAt?: string; finishedAt?: string; durationMs?: number; exitCode?: number; error?: string; rerun?: boolean }
export interface EnvironmentStatus {
  state: string;
  file?: string;
  /** Why it's held (a `held` state): the card says what starts it. */
  held?: string;
  /** What started the chain: the claim, the owner's trust, or termag-env (cli). */
  trigger?: 'claim' | 'trust' | 'cli';
  /** The chain an environment pool prepared before the claim, adopted by the project (agent/environment-run.js adoptPoolState). */
  preparedByPool?: boolean;
  setup: EnvironmentPhase;
  run: EnvironmentPhase;
  seed: EnvironmentPhase;
  /** host: '::1' when the box found the app there alone (agent/environment-run.js probePort); else localhost. */
  ports: Array<{ name: string; port: number; path: string; healthy: boolean; host?: '::1'; checkedAt?: string }>;
  secrets: { resolved: string[]; missing: string[] };
  warnings: string[];
  updatedAt?: string;
}

function phase(v: unknown): EnvironmentPhase {
  if (!v || typeof v !== 'object') return { state: 'none' };
  const p = v as Record<string, unknown>;
  if (typeof p.state !== 'string' || !PHASE_STATES.has(p.state)) return { state: 'none' };
  const out: EnvironmentPhase = { state: p.state };
  if (typeof p.startedAt === 'string') out.startedAt = p.startedAt.slice(0, 40);
  if (typeof p.finishedAt === 'string') out.finishedAt = p.finishedAt.slice(0, 40);
  if (typeof p.durationMs === 'number' && Number.isFinite(p.durationMs) && p.durationMs >= 0) out.durationMs = Math.round(p.durationMs);
  if (typeof p.exitCode === 'number' && Number.isInteger(p.exitCode)) out.exitCode = p.exitCode;
  if (typeof p.error === 'string') out.error = p.error.slice(0, 300);
  if (p.rerun === true) out.rerun = true;
  return out;
}

const strings = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, max).map(s => s.slice(0, len)) : [];

/** An `environment-status` frame (agent/environment-file.js frameFromEnvState), checked field by field; null when unreadable. */
export function parseEnvironmentStatusFrame(msg: unknown): { projectId: string; instanceId: string | null; status: EnvironmentStatus } | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.projectId !== 'string' || !m.projectId || !m.status || typeof m.status !== 'object') return null;
  const s = m.status as Record<string, unknown>;
  const ports = Array.isArray(s.ports) ? s.ports.slice(0, 8).flatMap(p => {
    if (!p || typeof p !== 'object') return [];
    const q = p as Record<string, unknown>;
    if (typeof q.port !== 'number' || !Number.isInteger(q.port) || q.port < 1 || q.port > 65535) return [];
    return [{
      name: typeof q.name === 'string' ? q.name.slice(0, 40) : `port ${q.port}`,
      port: q.port,
      path: typeof q.path === 'string' && q.path.startsWith('/') ? q.path.slice(0, 512) : '/',
      healthy: q.healthy === true,
      // Only ::1: a link names it (Bugbot, #998); any other host is dropped, so a frame can't point a link elsewhere.
      ...(q.host === '::1' ? { host: '::1' as const } : {}),
      ...(typeof q.checkedAt === 'string' ? { checkedAt: q.checkedAt.slice(0, 40) } : {}),
    }];
  }) : [];
  const secrets = s.secrets && typeof s.secrets === 'object' ? s.secrets as Record<string, unknown> : {};
  return {
    projectId: m.projectId,
    instanceId: typeof m.instanceId === 'string' ? m.instanceId : null,
    status: {
      state: typeof s.state === 'string' && CHAIN_STATES.has(s.state) ? s.state : 'none',
      ...(typeof s.file === 'string' ? { file: s.file.slice(0, 300) } : {}),
      setup: phase(s.setup),
      run: phase(s.run),
      seed: phase(s.seed),
      ports,
      secrets: { resolved: strings(secrets.resolved, 20, 128), missing: strings(secrets.missing, 20, 128) },
      warnings: strings(s.warnings, 20, 300),
      ...(typeof s.held === 'string' && HOLD_REASONS.has(s.held) ? { held: s.held } : {}),
      ...(s.trigger === 'claim' || s.trigger === 'trust' || s.trigger === 'cli' ? { trigger: s.trigger } : {}),
      ...(s.preparedByPool === true ? { preparedByPool: true } : {}),
      ...(typeof s.updatedAt === 'string' ? { updatedAt: s.updatedAt.slice(0, 40) } : {}),
    },
  };
}

/** The setup that has just finished, going from `prev` to `next`, for its product event; null when none has. */
export function finishedSetup(prev: unknown, next: EnvironmentStatus): EnvironmentPhase | null {
  const was = prev && typeof prev === 'object' ? phase((prev as Record<string, unknown>).setup) : { state: 'none' };
  const now = next.setup;
  if (now.state !== 'succeeded' && now.state !== 'failed') return null;
  if (was.state === now.state && was.finishedAt === now.finishedAt) return null;
  return now;
}

async function onEnvironmentStatus({ instance, msg }: BoxAgentFrame): Promise<void> {
  const frame = parseEnvironmentStatusFrame(msg);
  if (!frame) {
    console.warn(`[ENV] dropped an unreadable environment-status from ${instance.id}`);
    return;
  }
  // Only a project on the box that sent it.
  const project = await prisma.project.findFirst({
    where: { id: frame.projectId, instanceId: instance.id },
    select: { id: true, userId: true, environmentStatus: true, environmentFile: true, repoUrl: true, repos: { select: { url: true }, orderBy: { position: 'asc' } } },
  });
  if (!project) return;
  await prisma.project.update({ where: { id: project.id }, data: { environmentStatus: frame.status as object } });
  // The box reports each change (a step done, a port turning healthy): the owner's open tabs reload the list.
  notifyWorkspaceChange(project.userId, 'projects');
  const done = finishedSetup(project.environmentStatus, frame.status);
  if (done) {
    // How long setup takes at claim, which decides whether per-repo pools or a bake are worth it (the design's phase 3).
    recordProductEvent('environment.setup', { user: project.userId, box: instance.id }, setupEventProps(frame.status, done, project));
    console.log(`[ENV] ${project.id}: setup ${done.state} on ${instance.id} after ${Math.round((done.durationMs ?? 0) / 1000)}s`);
  }
}

/**
 * The environment.setup event's properties: how setup ended and how long it took, what started it (claim, trust or
 * cli), whether it was a rerun, and which environment (its name, else implicit) and repositories (#998).
 */
export function setupEventProps(status: EnvironmentStatus, done: EnvironmentPhase, project: { environmentFile: unknown; repoUrl: string | null; repos: Array<{ url: string }> }) {
  const ef = project.environmentFile && typeof project.environmentFile === 'object' ? project.environmentFile as { name?: unknown } : null;
  const urls = project.repos.length ? project.repos.map(r => r.url) : project.repoUrl ? [project.repoUrl] : [];
  return {
    outcome: done.state,
    durationSec: typeof done.durationMs === 'number' ? Math.round(done.durationMs / 1000) : null,
    exitCode: done.exitCode ?? null,
    trigger: status.trigger ?? null,
    rerun: done.rerun === true,
    ...setupWhere(status, done),
    environment: typeof ef?.name === 'string' ? ef.name : 'implicit',
    // A product event's values are scalars: owner/name, comma-separated, in the project's order.
    repos: urls.map(u => repoKey(u)).filter((k): k is string => !!k).join(','),
  };
}

/**
 * Where a project's setup ran, for environment.setup: `claim` on a box an
 * environment pool prepared (its setup ran before claim and this is the catch-up), `box` at a box's own first run,
 * `up` from termag-env. The pool's own prepare is `pool` (services/envPool.ts). `incremental`: setup had run on this
 * checkout before, so this run should do only what changed.
 */
export function setupWhere(status: Pick<EnvironmentStatus, 'trigger' | 'preparedByPool'>, done: Pick<EnvironmentPhase, 'rerun'>): { where: 'claim' | 'box' | 'up'; incremental: boolean } {
  const where = status.trigger === 'cli' ? 'up' : status.preparedByPool ? 'claim' : 'box';
  return { where, incremental: done.rerun === true || status.preparedByPool === true };
}

/** Every process listens: a box's frames arrive on whichever process holds its socket. */
export function startProjectEnvironment(): () => void {
  return onBoxAgentFrame('environment-status', frame => {
    onEnvironmentStatus(frame).catch(err => console.error('[ENV] environment-status:', (err as Error).message));
  });
}
