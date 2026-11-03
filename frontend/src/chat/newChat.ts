// Pure pieces of the simple UI's New chat and its setup narration: the names
// a new chat and its box get, how long a cold box usually takes, the steps
// shown while the box, the clone and Claude come up, and the first message
// held until Claude can take it.
import { claimUpdateLive } from '../utils/boxFeed';
import type { AgentStatusValue, Instance, Project } from '../types';
import { isValidBoxName } from '../utils/boxNames';
import { repoKey, sameRepoMatches, type RepoPick } from '../utils/repoPick';
import { isRunName } from '../utils/workstreamChoices';
import { isSdkChat } from './simpleChat';
import { isChatEffort, isChatModel, type ChatEffortId, type ChatModelId } from './composer';
import type { Block } from './paneChat';

/** `base`, else `base-2`, `base-3`, … whichever is not taken (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The defaults for a new chat: the project is named after the repository,
 * and its box after the project, each unique among the user's own.
 */
export function newChatNames(
  base: string,
  projectNames: Iterable<string>,
  boxNames: Iterable<string>,
): { projectName: string; boxName: string } {
  const projectName = uniqueName(base, projectNames);
  const boxBase = isValidBoxName(projectName) ? projectName : 'chat';
  return { projectName, boxName: uniqueName(boxBase, boxNames) };
}

/**
 * Why New chat's Start is disabled, shown beside it, or '' when it is not (or
 * while a start is under way, which the button's own label narrates).
 */
export function startBlocker(i: {
  busy: boolean;
  hasRepo: boolean;
  name: string;
  nameError: string;
  spacesReady: boolean;
  spaceError: string;
  boxReady: boolean;
  boxName: string;
  boxError: string;
}): string {
  if (i.busy) return '';
  if (!i.hasRepo) return 'Choose a repository, or paste its URL';
  if (!i.name) return 'Give the session a name in the box settings';
  if (i.nameError) return `Session name: ${i.nameError}`;
  if (!i.spacesReady) return 'Loading your spaces…';
  if (i.spaceError) return i.spaceError;
  if (!i.boxReady) {
    if (!i.boxName) return 'Give the box a name in the box settings';
    if (i.boxError) return `Box name: ${i.boxError}`;
  }
  return '';
}

/**
 * "Act as an orchestrator" on New session (the project's chatOrchestrator; the
 * box's chat runner tells each turn to use the agent-orchestrator skill, out
 * of the conversation): hidden unless the provider has the
 * skill and the form starts a chat (not a schedule); disabled until the trust
 * box is ticked, since an untrusted turn has neither the Skill tool nor Bash
 * for `termag ask` (agent/chat-runner.js READ_ONLY_TOOLS).
 */
export function orchestratorOption(i: { providerHasSkill: boolean; scheduled: boolean; trusted: boolean }): 'hidden' | 'needs-trust' | 'available' {
  if (!i.providerHasSkill || i.scheduled) return 'hidden';
  return i.trusted ? 'available' : 'needs-trust';
}

/**
 * Minutes a cold box of this user's took from launch to its agent's first
 * connect (median of `readyAt - createdAt` over launched, never-claimed boxes),
 * or null with nothing to go on. Claimed warm boxes are left out: their
 * `createdAt` is the pool's launch, not the user's.
 */
export function bootEstimateMinutes(
  boxes: ReadonlyArray<Pick<Instance, 'kind' | 'createdAt' | 'readyAt' | 'claimedAt'>>,
): number | null {
  const mins = boxes
    .filter(b => b.kind === 'ec2' && b.readyAt && !b.claimedAt)
    .map(b => (new Date(b.readyAt as string).getTime() - new Date(b.createdAt).getTime()) / 60_000)
    .filter(m => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);
  if (mins.length === 0) return null;
  const mid = Math.floor(mins.length / 2);
  const median = mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
  return Math.max(1, Math.round(median));
}

export type StepState = 'done' | 'active' | 'pending' | 'failed';

export interface SetupStep {
  id: 'box' | 'clone' | 'agent';
  state: StepState;
  text: string;
}

export interface SetupInput {
  box: Pick<Instance, 'name' | 'status' | 'provisioningError' | 'claimedAt' | 'claimUpdateStatus' | 'claimUpdateStartedAt'> | null;
  setupStatus: string | null | undefined;
  setupError?: string | null;
  /** `owner/name`, or null for a chat with no repository. */
  repo: string | null;
  agentUp: boolean;
  etaMinutes: number | null;
}

const BOOTING = ['provisioning', 'awaiting-agent', 'warming', 'warm'];

/** A box just claimed from the pool is updating before its first launch (backend services/claimUpdate.ts). */
export function boxUpdating(box: Pick<Instance, 'claimUpdateStatus' | 'claimUpdateStartedAt'> | null | undefined): boolean {
  return claimUpdateLive(box);
}

/** The box is still launching or starting: a chat on it is being set up, not loading. */
export function boxComingUp(status: string | null | undefined): boolean {
  return status != null && (BOOTING.includes(status) || status === 'starting');
}

function boxStep(box: SetupInput['box'], eta: number | null): SetupStep {
  if (!box) return { id: 'box', state: 'active', text: 'Finding the box' };
  if (box.status === 'failed') {
    return { id: 'box', state: 'failed', text: `Box ${box.name} failed to launch${box.provisioningError ? `: ${box.provisioningError}` : ''}` };
  }
  if (BOOTING.includes(box.status)) {
    const when = eta != null ? `usually about ${eta} min` : 'usually a few minutes';
    return { id: 'box', state: 'active', text: `Launching box ${box.name} · ${when}` };
  }
  // A box claimed from the pool is brought up to the orchestrator's commit
  // before anything is launched on it (backend services/claimUpdate.ts).
  if (box.status === 'ready' && boxUpdating(box)) {
    return { id: 'box', state: 'active', text: `Claimed a ready box, ${box.name} · Updating the box…` };
  }
  if (box.status === 'ready') {
    return { id: 'box', state: 'done', text: box.claimedAt ? `Claimed a ready box, ${box.name}` : `Box ${box.name} is up` };
  }
  return { id: 'box', state: 'active', text: `Box ${box.name} is ${box.status.replace(/-/g, ' ')}` };
}

/**
 * What the chat narrates while it comes up: the box, then the clone (when
 * there is a repository), then Claude. Each step is done, active, waiting
 * its turn, or failed with the reason. A box whose agent cannot clone on its
 * own types the checkout into the pane ahead of Claude, and the project moves
 * to `none` at once: there the clone is only known finished when Claude is up.
 */
export function setupSteps(i: SetupInput): SetupStep[] {
  const box = boxStep(i.box, i.etaMinutes);
  const steps: SetupStep[] = [box];
  const setupDone = i.setupStatus === 'ready' || i.setupStatus === 'none' || i.setupStatus == null || i.setupStatus === '';
  if (i.repo) {
    if (i.setupStatus === 'failed') steps.push({ id: 'clone', state: 'failed', text: `Clone of ${i.repo} failed${i.setupError ? `: ${i.setupError}` : ''}` });
    else if (i.setupStatus === 'cloning' || (i.setupStatus === 'none' && !i.agentUp)) steps.push({ id: 'clone', state: 'active', text: `Cloning ${i.repo}` });
    else if (setupDone) steps.push({ id: 'clone', state: 'done', text: `Cloned ${i.repo}` });
    else steps.push({ id: 'clone', state: box.state === 'done' ? 'active' : 'pending', text: `Clone ${i.repo}` });
  }
  const blocked = steps.some(s => s.state === 'failed' || (s.id === 'clone' && s.state === 'active'));
  if (i.agentUp) steps.push({ id: 'agent', state: 'done', text: 'Claude is ready' });
  else steps.push({ id: 'agent', state: setupDone && box.state === 'done' && !blocked ? 'active' : 'pending', text: 'Starting Claude' });
  return steps;
}

/** Whether every step is done. */
export function setupComplete(steps: readonly SetupStep[]): boolean {
  return steps.every(s => s.state === 'done');
}

/**
 * Claude can take a message: a status has arrived from its hooks, or its
 * input box is on screen (a fresh Claude posts no status until the first
 * prompt).
 */
export function agentUp(status: AgentStatusValue | undefined, draft: string | null | undefined): boolean {
  return status === 'idle' || status === 'working' || status === 'waiting' || draft != null;
}

/**
 * The last few lines the box printed before the agent's first turn, for a
 * chat whose agent is not up yet: a git credential prompt or a failed
 * checkout would otherwise sit unseen in the pane. Empty once there is a turn.
 */
export function preLaunchTail(blocks: readonly Block[], lines = 3): string[] {
  if (blocks.some(b => b.kind !== 'system')) return [];
  return blocks
    .flatMap(b => b.text.split('\n'))
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .slice(-lines);
}

/**
 * Whether the chat shows its setup steps: while the project is still being
 * set up, while a message waits for Claude, or while Claude is not up and the
 * pane holds no conversation yet (a box that clones in the pane sits at setup
 * `none` with nothing queued when the first message was left empty).
 */
export function showSetup(i: { held: boolean; queued: boolean; up: boolean; captured: boolean; turns: number }): boolean {
  return i.held || i.queued || (!i.up && i.captured && i.turns === 0);
}

/**
 * The projects a New session can branch a worktree off instead of cloning
 * again: the user's own chat projects on the chosen box, checked out from the
 * picked repository (utils/repoPick.ts sameRepoMatches). Not an automation
 * or a project someone shared with them, and nothing for a new box.
 */
export function worktreeTargets(pick: RepoPick, projects: readonly Project[], boxId: string | null): Project[] {
  if (!boxId) return [];
  return sameRepoMatches(pick, projects, boxId)
    .filter(p => (p.kind ?? 'normal') === 'normal' && p.role !== 'collaborator' && isSdkChat(p, 'main'));
}

/**
 * A worktree session's workstream name (and branch): the session name as the
 * backend takes it (letters, digits, - and _, at most 64, never main), made
 * unique among the project's workstreams, whatever their case, with -2, -3, ….
 */
export function worktreeName(desired: string, taken: readonly string[]): string {
  let base = desired.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40).replace(/[-_]+$/, '') || 'session';
  if (isRunName(base)) base = `${base}-session`;
  // Case-folded, as uniqueName is: `.worktrees/Fix` and `.worktrees/fix` are one directory on a case-insensitive disk.
  return uniqueName(base, [...taken, 'main']);
}

/** A worktree session's name from its first message: its first few words, as worktreeName will take them. */
export function sessionWords(message: string): string {
  return message.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 5).join('-') ?? '';
}

/** The first-message queue's key: the project for its main workstream, project@workstream for a worktree's. */
export function queueKey(projectId: string, workstream: string): string {
  return workstream === 'main' ? projectId : `${projectId}@${workstream}`;
}

// The first message of a new chat, typed before Claude was there to take it.
// localStorage, so a reload or a second tab still sends it once.
const QUEUED_PREFIX = 'termag-chat-queued:';
const CLAIM_PREFIX = 'termag-chat-queued-claim:';
/** A claim older than this is a tab that went away mid-send; another may take over. */
export const CLAIM_TTL_MS = 30_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;

export function readQueued(store: Store, projectId: string): string | null {
  try { return store?.getItem(QUEUED_PREFIX + projectId) || null; } catch { return null; }
}

/** Store (or, for an empty text, drop) the queued message; false when storage refused it. */
export function writeQueued(store: Store, projectId: string, text: string): boolean {
  if (!store) return false;
  try {
    if (text.trim()) store.setItem(QUEUED_PREFIX + projectId, text);
    else store.removeItem(QUEUED_PREFIX + projectId);
    return readQueued(store, projectId) === (text.trim() ? text : null);
  } catch {
    return false;
  }
}

/**
 * Take the queued message for sending, or null when there is none or another
 * tab took it within CLAIM_TTL_MS. localStorage has no compare-and-set, so
 * the claim is written and read back; the tab whose id survives sends.
 */
export function claimQueued(store: Store, projectId: string, tab: string, now: number): string | null {
  const text = readQueued(store, projectId);
  if (!text || !store) return null;
  try {
    const held = parseClaim(store.getItem(CLAIM_PREFIX + projectId));
    if (held && held.tab !== tab && now - held.at < CLAIM_TTL_MS) return null;
    store.setItem(CLAIM_PREFIX + projectId, JSON.stringify({ tab, at: now }));
    return parseClaim(store.getItem(CLAIM_PREFIX + projectId))?.tab === tab ? text : null;
  } catch {
    return null;
  }
}

/** When the current claim on this project's message expires, or null with no claim. */
export function claimHeldUntil(store: Store, projectId: string): number | null {
  try {
    const held = parseClaim(store?.getItem(CLAIM_PREFIX + projectId) ?? null);
    return held ? held.at + CLAIM_TTL_MS : null;
  } catch { return null; }
}

/**
 * `sent` went through: drop it and the claim. Text queued behind it while the
 * send was in flight stays queued for the next send.
 */
export function finishQueued(store: Store, projectId: string, sent: string): void {
  try {
    const now = readQueued(store, projectId);
    if (now && now !== sent && now.startsWith(sent)) store?.setItem(QUEUED_PREFIX + projectId, now.slice(sent.length).trim());
    else if (now === sent) store?.removeItem(QUEUED_PREFIX + projectId);
    store?.removeItem(CLAIM_PREFIX + projectId);
  } catch { /* ignore */ }
}

/** The send failed: give the claim back and keep the message for a retry. */
export function releaseQueued(store: Store, projectId: string, tab: string): void {
  try {
    if (parseClaim(store?.getItem(CLAIM_PREFIX + projectId) ?? null)?.tab === tab) store?.removeItem(CLAIM_PREFIX + projectId);
  } catch { /* ignore */ }
}

function parseClaim(raw: string | null): { tab: string; at: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { tab?: unknown; at?: unknown };
    return typeof v.tab === 'string' && typeof v.at === 'number' ? { tab: v.tab, at: v.at } : null;
  } catch { return null; }
}

/** Whether a localStorage key belongs to this project's queue (for storage events from other tabs). */
export function isQueueKey(key: string | null, projectId: string): boolean {
  return key === null || key === QUEUED_PREFIX + projectId || key === CLAIM_PREFIX + projectId;
}

// The repository, space and Claude model the last chat started with on this
// browser, so the next New chat opens on them. Only a listed or pasted
// repository is kept; a space is kept by name and offered again only while the
// user can still pick it; a model no longer offered (e.g. the retired Auto)
// reads as Sonnet.
const LAST_START_KEY = 'termag-chat-last-start';

export type RememberedPick = Extract<RepoPick, { kind: 'listed' | 'pasted' }>;

export interface LastStart {
  pick: RememberedPick | null;
  space: string | null;
  model: ChatModelId;
  effort: ChatEffortId;
}

export function readLastStart(store: Store): LastStart {
  const none: LastStart = { pick: null, space: null, model: 'sonnet', effort: 'default' };
  try {
    const raw = store?.getItem(LAST_START_KEY);
    if (!raw) return none;
    const v = JSON.parse(raw) as { pick?: Record<string, unknown>; space?: unknown; model?: unknown; effort?: unknown };
    const p = v.pick;
    let pick: RememberedPick | null = null;
    if (p?.kind === 'listed' && typeof p.fullName === 'string' && p.fullName && typeof p.defaultBranch === 'string') {
      pick = { kind: 'listed', fullName: p.fullName, defaultBranch: p.defaultBranch };
    } else if (p?.kind === 'pasted' && typeof p.url === 'string' && p.url.trim()) {
      pick = { kind: 'pasted', url: p.url };
    }
    return {
      pick,
      space: typeof v.space === 'string' && v.space ? v.space : null,
      model: typeof v.model === 'string' && isChatModel(v.model) ? v.model : 'sonnet',
      effort: isChatEffort(v.effort) ? v.effort : 'default',
    };
  } catch {
    return none;
  }
}

const LAST_PICK_KEY = 'termag-chat-last-pick';

/**
 * The model and effort last chosen in a composer, New session's or an open
 * session's, kept as they are picked (the last start keeps the repository and
 * space, only once a start has worked). New session opens on them.
 */
export interface LastPick {
  model: ChatModelId | null;
  effort: ChatEffortId | null;
}

export function readLastPick(store: Store): LastPick {
  try {
    const v = JSON.parse(store?.getItem(LAST_PICK_KEY) ?? '{}') as { model?: unknown; effort?: unknown };
    return {
      model: typeof v.model === 'string' && isChatModel(v.model) ? v.model : null,
      effort: isChatEffort(v.effort) ? v.effort : null,
    };
  } catch {
    return { model: null, effort: null };
  }
}

/** Record a pick: the model, the effort, or both; the other stays as it was. */
export function writeLastPick(store: Store, pick: { model?: ChatModelId; effort?: ChatEffortId }): void {
  const next = { ...readLastPick(store), ...pick };
  try { store?.setItem(LAST_PICK_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

const keptPick = (pick: RepoPick): RememberedPick | null =>
  pick.kind === 'listed' || (pick.kind === 'pasted' && pick.url.trim()) ? pick : null;

/** Record what a chat just started with. A pick that can't be remembered clears the repository. */
export function writeLastStart(store: Store, last: { pick: RepoPick; space: string | null; model: ChatModelId; effort?: ChatEffortId }): void {
  const { pick, space, model, effort = 'default' } = last;
  try { store?.setItem(LAST_START_KEY, JSON.stringify({ pick: keptPick(pick), space, model, effort })); } catch { /* ignore */ }
}

/**
 * The repository or space as soon as it is picked, as the model and effort
 * are: the next New session opens on it even if this one never started.
 * Only what is given changes; an empty or unlisted repository keeps the last one.
 */
export function rememberStartPick(store: Store, patch: { pick?: RepoPick; space?: string | null }): void {
  try {
    const raw = store?.getItem(LAST_START_KEY);
    const prev = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const next = { ...prev };
    if (patch.pick) {
      const kept = keptPick(patch.pick);
      if (kept) next.pick = kept;
    }
    if ('space' in patch) next.space = patch.space ?? null;
    store?.setItem(LAST_START_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

const PERMISSIONS_KEY = 'termag-chat-permissions';
const PERMISSIONS_KEPT = 50;

/**
 * The permission last picked for a repository on New session ('full' or
 * 'read'), so it opens on that choice next time; null when never picked.
 * Kept per repository, never as one global choice: Full access for one
 * repository must not become the default for the next one opened.
 */
export function readPermissionPick(store: Store, repoUrl: string | null): 'full' | 'read' | null {
  const key = repoUrl ? repoKey(repoUrl) : null;
  if (!key) return null;
  try {
    const v = (JSON.parse(store?.getItem(PERMISSIONS_KEY) ?? '{}') as Record<string, unknown>)[key];
    return v === 'full' || v === 'read' ? v : null;
  } catch {
    return null;
  }
}

export function writePermissionPick(store: Store, repoUrl: string | null, choice: 'full' | 'read'): void {
  const key = repoUrl ? repoKey(repoUrl) : null;
  if (!key) return;
  try {
    const kept = JSON.parse(store?.getItem(PERMISSIONS_KEY) ?? '{}') as Record<string, unknown>;
    delete kept[key];
    // Insertion order is recency: the oldest picks go first once there are too many.
    const entries = [...Object.entries(kept), [key, choice] as const].slice(-PERMISSIONS_KEPT);
    store?.setItem(PERMISSIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* a full or blocked store keeps nothing */
  }
}
