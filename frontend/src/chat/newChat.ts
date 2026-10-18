// Pure pieces of the simple UI's New chat and its setup narration: the names
// a new chat and its box get, how long a cold box usually takes, the steps
// shown while the box, the clone and Claude come up, and the first message
// held until Claude can take it.
import type { AgentStatusValue, Instance } from '../types';
import { isValidBoxName } from '../utils/boxNames';
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
  box: Pick<Instance, 'name' | 'status' | 'provisioningError' | 'claimedAt'> | null;
  setupStatus: string | null | undefined;
  setupError?: string | null;
  /** `owner/name`, or null for a chat with no repository. */
  repo: string | null;
  agentUp: boolean;
  etaMinutes: number | null;
}

const BOOTING = ['provisioning', 'awaiting-agent', 'warming', 'warm'];

function boxStep(box: SetupInput['box'], eta: number | null): SetupStep {
  if (!box) return { id: 'box', state: 'active', text: 'Finding the box' };
  if (box.status === 'failed') {
    return { id: 'box', state: 'failed', text: `Box ${box.name} failed to launch${box.provisioningError ? `: ${box.provisioningError}` : ''}` };
  }
  if (BOOTING.includes(box.status)) {
    const when = eta != null ? `usually about ${eta} min` : 'usually a few minutes';
    return { id: 'box', state: 'active', text: `Launching box ${box.name} · ${when}` };
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
