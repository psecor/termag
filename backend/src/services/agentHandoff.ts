/**
 * Agent handoff, the pure half: what a request may
 * say, which mode a provider can really do, the prompt file and the fixed
 * lines typed into the pane, and what the sweep does next for a row. No
 * Prisma, no RPCs — routes/handoffs.ts and services/agentHandoffSweep.ts do
 * those and call in here.
 */
import { PROVIDERS } from '../providers/registry';
import { NUDGE_HUMAN_QUIET_MS } from './agentSpawn';

export const HANDOFF_FLAG = 'agent-handoff-enabled';

export const HANDOFF_MODES = ['clear', 'compact', 'restart'] as const;
export type HandoffMode = typeof HANDOFF_MODES[number];
export const HANDOFF_SURFACES = ['web', 'mobile', 'tui', 'cli', 'slack', 'mcp'] as const;
export type HandoffSurface = typeof HANDOFF_SURFACES[number];
export type HandoffInitiator = 'person' | 'agent';
export type HandoffState = 'requested' | 'writing' | 'written' | 'resetting' | 'done' | 'failed' | 'aborted';
/** A row in one of these holds its pane: a second handoff for it answers 409. */
export const OPEN_HANDOFF_STATES: HandoffState[] = ['requested', 'writing', 'written', 'resetting'];
/** Abort is only offered before anything has been done to the pane. */
export const ABORTABLE_HANDOFF_STATES: HandoffState[] = ['requested', 'writing', 'written'];

export const MAX_HANDOFF_BODY = 32_000;
const MAX_NOTE = 2000;
const SESSION = /^[\w.-]+$/;

/** Waiting for the pane to come back to idle so the "write it" line can be typed. */
export const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
/** From the "write it" line to handoff_written. */
export const WRITE_TIMEOUT_MS = 10 * 60 * 1000;
/** From handoff_written to an idle pane the reset can be typed into. */
export const WRITTEN_TIMEOUT_MS = 30 * 60 * 1000;
/** After /clear, before the read-in line: the TUI redraws, and nothing reports when it is done. */
export const CLEAR_SETTLE_MS = 3_000;
/** /compact runs a turn of its own; the read-in waits for the context reading to drop, at most this long. */
export const COMPACT_MAX_WAIT_MS = 3 * 60 * 1000;
/**
 * A read-in claim older than this was abandoned (the leader died between the
 * claim and `done`; a send gives up after 5 s), so it is claimed again. The
 * worst case is the line typed twice, which only has the agent read the same
 * file twice — better than a cleared pane whose next agent never reads it.
 */
export const READIN_CLAIM_STALE_MS = 30_000;
/** A restart whose launch did not type (probe busy or unknown) is tried again after this long… */
export const RESTART_RETRY_MS = 15_000;
/** …and given up this long after the kill. */
export const RESET_TIMEOUT_MS = 10 * 60 * 1000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HandoffRequest {
  mode: HandoffMode;
  /** restart only: the provider to start; absent = the one running now. */
  provider?: string;
  note?: string;
  /** The handoff itself, when the agent wrote it before asking (skips the write step). */
  body?: string;
  /** The agent's own pane, as its MCP server sees it. */
  session?: string;
}

function optString(body: Record<string, unknown>, key: string, max: number): Parsed<string | undefined> {
  const v = body[key];
  if (v == null || v === '') return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, error: `${key} must be a string` };
  const s = v.trim();
  if (s.length > max) return { ok: false, error: `${key} is longer than ${max} characters` };
  return { ok: true, value: s || undefined };
}

/** The body of a handoff request (any surface). The default mode is clear (decision 1 in the doc). */
export function parseHandoffRequest(raw: unknown): Parsed<HandoffRequest> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = body.mode ?? 'clear';
  if (!HANDOFF_MODES.includes(mode as HandoffMode)) return { ok: false, error: `mode must be one of: ${HANDOFF_MODES.join(', ')}` };
  const provider = optString(body, 'provider', 40);
  if (!provider.ok) return provider;
  const note = optString(body, 'note', MAX_NOTE);
  if (!note.ok) return note;
  const text = optString(body, 'body', MAX_HANDOFF_BODY);
  if (!text.ok) return text;
  if (body.session != null && (typeof body.session !== 'string' || !SESSION.test(body.session))) {
    return { ok: false, error: 'session must be a tmux session name' };
  }
  const value: HandoffRequest = { mode: mode as HandoffMode };
  if (provider.value) value.provider = provider.value;
  if (note.value) value.note = note.value;
  if (text.value) value.body = text.value;
  if (typeof body.session === 'string') value.session = body.session;
  return { ok: true, value };
}

/** The body of POST /api/handoffs/:id/written. */
export function parseWritten(raw: unknown): Parsed<{ session: string; body: string }> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof body.session !== 'string' || !SESSION.test(body.session)) {
    return { ok: false, error: 'session required (the writing pane\'s tmux session)' };
  }
  const text = optString(body, 'body', MAX_HANDOFF_BODY);
  if (!text.ok) return text;
  if (!text.value) return { ok: false, error: 'body required: the handoff markdown' };
  return { ok: true, value: { session: body.session, body: text.value } };
}

/**
 * A provider the pane can be handed off from: it runs in the pane, can write
 * its handoff (the metaterm tool and the skill reach it: handoffWriter), and
 * can be started again on a file.
 */
export function canHandOffFrom(provider: string): boolean {
  const p = PROVIDERS[provider];
  return !!p && !p.chatRunner && !p.needsBridge && !!p.handoffWriter && !!p.promptLaunch;
}

/** A provider termag can start on a handoff file: a pane agent with promptLaunch. */
export function canStartOnHandoff(provider: string): boolean {
  const p = PROVIDERS[provider];
  return !!p && !p.chatRunner && !p.needsBridge && !!p.promptLaunch;
}

/** A provider a restart may start: offered in the pickers and startable on a prompt file. */
export function canRestartInto(provider: string): boolean {
  return !!PROVIDERS[provider]?.selectable && canStartOnHandoff(provider);
}

export interface ModePlan {
  mode: HandoffMode;
  /** Set when the mode asked for is not the one that will run. */
  fallback?: string;
}

/**
 * The mode that will run. Clear and compact happen inside the running agent,
 * so they need its command and the same provider; anything else restarts.
 */
export function planMode(requested: HandoffMode, fromProvider: string, toProvider?: string | null): ModePlan {
  const name = PROVIDERS[fromProvider]?.displayName ?? fromProvider;
  if (requested === 'restart') return { mode: 'restart' };
  if (toProvider && toProvider !== fromProvider) {
    return { mode: 'restart', fallback: `${requested} keeps the same agent; switching to ${PROVIDERS[toProvider]?.displayName ?? toProvider} restarts the pane` };
  }
  const command = requested === 'clear' ? PROVIDERS[fromProvider]?.clearCommand : PROVIDERS[fromProvider]?.compactCommand;
  if (!command) return { mode: 'restart', fallback: `${name} has no ${requested} command termag knows, so the pane restarts ${name} instead` };
  return { mode: requested };
}

const PROMPT_DIR = '.termag/handoffs';
const SAFE_ID = /^[a-z0-9]+$/i;

function promptFile(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('unsafe handoff id');
  return `${id}.md`;
}

/** Where write-file puts the prompt file (the agent applies its path_remap to this). */
export function handoffPromptPath(home: string, id: string): string {
  return `${home.replace(/\/+$/, '')}/${PROMPT_DIR}/${promptFile(id)}`;
}

/** The same file as the pane's agent names it, through its own $HOME. */
export function handoffPaneFile(id: string): string {
  return `~/${PROMPT_DIR}/${promptFile(id)}`;
}

/** The line a restart types: the next agent starts on the prompt file. */
export function handoffLaunchCommand(provider: string, id: string): string {
  const launch = PROVIDERS[provider]?.promptLaunch;
  if (!launch) throw new Error(`provider ${provider} cannot start on a handoff`);
  return launch(`"$HOME/${PROMPT_DIR}/${promptFile(id)}"`);
}

/**
 * Typed into an idle pane to have its agent write the handoff. Fixed text
 * plus the id: never anything a person or agent wrote.
 */
export function writeRequestLine(id: string): string {
  return `[termag] Hand off requested: write a handoff for the next agent with the termag-handoff skill, then call handoff_written (metaterm MCP server) with handoffId ${id}. Do not start new work.`;
}

/** Typed after /clear (and after /compact): the handoff is the next prompt. */
export function readInLine(id: string): string {
  return `[termag] You are continuing work handed off by the previous agent in this pane. Read ${handoffPaneFile(id)} and continue from it.`;
}

/** The compact command's focus instructions. */
export function compactFocus(id: string): string {
  return `Keep only what the next turn needs to continue the work; the full handoff is in ${handoffPaneFile(id)}.`;
}

export interface HandoffPromptInput {
  id: string;
  projectName: string;
  workstream: string;
  fromProvider: string;
  toProvider: string;
  createdAt: Date;
  note?: string | null;
  body: string;
}

/**
 * The prompt file: a fixed header saying what it is, the person's or agent's
 * note, and the handoff. The next agent reads it as its first prompt.
 */
export function buildHandoffPrompt(h: HandoffPromptInput): string {
  const from = PROVIDERS[h.fromProvider]?.displayName ?? h.fromProvider;
  const to = PROVIDERS[h.toProvider]?.displayName ?? h.toProvider;
  const where = h.workstream === 'main' ? `project ${h.projectName}` : `project ${h.projectName}, workstream ${h.workstream}`;
  const parts = [
    `You are continuing work in ${where}. The previous agent in this pane (${from}) wrote the handoff below on ${h.createdAt.toISOString()} before termag ${h.fromProvider === h.toProvider ? 'reset' : `switched it to ${to} and reset`} its context (handoff ${h.id}).`,
    'Treat it as your starting point: check the state it describes against the repository (git status, the branch, the PR) before acting, then carry on with its next steps.',
  ];
  if (h.note) parts.push('', '--- note from whoever asked for the handoff ---', h.note);
  parts.push('', '--- handoff ---', h.body, '');
  return parts.join('\n');
}

export interface StepInput {
  state: HandoffState;
  mode: HandoffMode;
  initiator: HandoffInitiator;
  /** The agent pane's live status (working / waiting / idle / not_running). */
  paneStatus: string | null;
  connected: boolean;
  /** When the owner last typed into the project, ms epoch. */
  humanLastTyped: number | null;
  createdAt: Date;
  writeRequestedAt: Date | null;
  writtenAt: Date | null;
  resetAt: Date | null;
  launchedAt: Date | null;
  contextTokensBefore: number | null;
  contextTokensNow: number | null;
  now: number;
}

export type Step =
  | { kind: 'wait' }
  | { kind: 'request-write' }
  | { kind: 'reset' }
  | { kind: 'read-in' }
  | { kind: 'relaunch' }
  | { kind: 'abort' | 'fail'; reason: string };

const WAIT: Step = { kind: 'wait' };

/**
 * What the sweep does next for one open handoff. Only an idle pane is typed
 * into: `waiting` is an approval prompt the line would answer, `working`
 * would queue it mid-turn. An agent-started handoff also waits for the owner
 * to stop typing in the project; a person-started one is that person asking.
 */
export function handoffStep(s: StepInput): Step {
  const since = (d: Date | null) => (d ? s.now - d.getTime() : 0);
  const quiet = s.initiator === 'person'
    || s.humanLastTyped == null
    || s.now - s.humanLastTyped >= NUDGE_HUMAN_QUIET_MS;
  const typeable = s.connected && s.paneStatus === 'idle' && quiet;

  switch (s.state) {
    case 'requested':
      if (since(s.createdAt) > REQUEST_TIMEOUT_MS) return { kind: 'abort', reason: 'the agent did not come back to its prompt within 30 minutes' };
      return typeable ? { kind: 'request-write' } : WAIT;
    case 'writing':
      if (since(s.writeRequestedAt ?? s.createdAt) > WRITE_TIMEOUT_MS) {
        return { kind: 'abort', reason: 'the agent did not call handoff_written within 10 minutes; nothing was reset' };
      }
      return WAIT;
    case 'written': {
      if (since(s.writtenAt ?? s.createdAt) > WRITTEN_TIMEOUT_MS) return { kind: 'abort', reason: 'the agent did not come back to its prompt within 30 minutes of writing the handoff' };
      // A restart kills the pane, so it needs no prompt to type into: a pane
      // that reads not_running (the agent died after writing, or no status
      // has arrived since an orchestrator restart) is fair game. An agent
      // still mid-turn has just written the handoff and is finishing, and an
      // approval prompt is something the person may be answering, so those
      // still wait.
      const free = s.mode === 'restart'
        ? s.connected && quiet && s.paneStatus !== 'working' && s.paneStatus !== 'waiting'
        : typeable;
      return free ? { kind: 'reset' } : WAIT;
    }
    case 'resetting':
      if (s.mode === 'restart') {
        // The timeout first: a row stuck here holds its pane (one open handoff per pane).
        if (since(s.resetAt) > RESET_TIMEOUT_MS) return { kind: 'fail', reason: 'the new agent could not be started in the pane within 10 minutes' };
        if (s.launchedAt) return WAIT; // the launch claim moves the row to done
        return s.connected && since(s.resetAt) >= RESTART_RETRY_MS ? { kind: 'relaunch' } : WAIT;
      }
      if (since(s.resetAt) > RESET_TIMEOUT_MS) return { kind: 'fail', reason: `the agent did not come back to its prompt after ${s.mode === 'clear' ? '/clear' : '/compact'}` };
      // A read-in claim is out (launchedAt): another tick is typing it, unless it went stale.
      if (s.launchedAt && since(s.launchedAt) < READIN_CLAIM_STALE_MS) return WAIT;
      if (!s.connected || s.paneStatus !== 'idle') return WAIT;
      if (s.mode === 'clear') return since(s.resetAt) >= CLEAR_SETTLE_MS ? { kind: 'read-in' } : WAIT;
      {
        const dropped = s.contextTokensBefore != null && s.contextTokensNow != null && s.contextTokensNow < s.contextTokensBefore * 0.5;
        return dropped || since(s.resetAt) >= COMPACT_MAX_WAIT_MS ? { kind: 'read-in' } : WAIT;
      }
    default:
      return WAIT;
  }
}
