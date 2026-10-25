/**
 * Open in full UI's `claude --resume` and the chat's send, kept from forking
 * one Claude session into two writers (routes/chat.ts). Both run under the
 * agent pane's lock (agentRuntime withPaneLock), and a resume that typed
 * holds the lock until the pane's foreground is a Claude: a send or a second
 * resume queued behind it then probes the pane after Claude has it, and is
 * refused or left alone instead of finding the shell it was typed into.
 */
import { paneStillHolds, probeFromForeground, resumeCommandFor, resumeDecision, terminalHoldsChat, type PaneForeground, type PaneProbe } from './chatRunner';

/** How long a typed resume holds the pane for Claude to come up. Past it the pane is let go: no Claude means no second writer. */
export const RESUME_SETTLE_TIMEOUT_MS = 10_000;
export const RESUME_SETTLE_INTERVAL_MS = 250;

/**
 * How long to wait for a pane that just came up to report a foreground.
 * Launch waits the same 500 ms (agentRuntime): a brand-new tmux session can
 * still report an empty pane_current_command, and an empty probe is unknown,
 * not a shell.
 */
export const SHELL_READY_MS = 500;
export const SHELL_READY_INTERVAL_MS = 100;

export interface ResumeDeps {
  /** The box's chat-history: the session to resume, and whether a turn runs now. */
  history(): Promise<{ sessionId?: unknown; running?: unknown }>;
  /**
   * Claim the chat so the runner will not start a queued turn before the
   * resume is typed, and return the line to type. That line is the runner's
   * permission surface for this checkout (agent/chat-runner.js resumeLaunch).
   * An agent from before chat-resume-claim throws "Unknown command"; the
   * caller then re-reads history and types nothing.
   */
  claim?(): Promise<{ claimed?: unknown; running?: unknown; line?: unknown }>;
  /**
   * Drop the claim. park is true once the resume was typed, so a queue does
   * not start on its own. seen is true once Claude was the foreground: the
   * claim becomes `seen`, so a later shell is Claude having left.
   */
  release?(park: boolean, seen: boolean): Promise<void>;
  /** Make sure the agent pane's tmux session exists. */
  ensurePane(): Promise<void>;
  /** The agent pane's foreground command, or null when it cannot be read. */
  probe(): Promise<string | null>;
  /** Type a line into the agent pane, with Enter. */
  type(line: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export type ResumeOutcome =
  | { status: 'turn-running' }
  | { status: 'skipped'; reason: 'no-session' | 'claude-open' | 'pane-busy' | 'pane-unknown' | 'resume-unprepared'; sessionId?: string }
  | { status: 'resumed'; sessionId: string; settled: boolean };

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A line Open in full UI may type. Only a quoted path under
 * `$HOME/.termag/chat-resume/` (run as a child of the pane shell, not
 * `exec`, so `/exit` returns to that shell). The flags, the cwd, and the
 * binary live in that script. A bare `claude`, including
 * `claude --permission-mode bypassPermissions --resume <id>`, is not typed:
 * that would start Claude in whatever directory the pane was already in.
 * Anything else (a same-site body's text, a metacharacter) is not typed.
 */
const RESUME_LINE = /^"\$HOME\/\.termag\/chat-resume\/([A-Za-z0-9_.-]{1,160})"$/;

export function isSafeResumeLine(line: unknown): line is string {
  if (typeof line !== 'string') return false;
  const match = RESUME_LINE.exec(line);
  return match !== null && !match[1].includes('..');
}

/** Polls the pane until a Claude is its foreground, or the timeout passes. */
export async function waitForClaude(
  probe: () => Promise<string | null>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? RESUME_SETTLE_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? RESUME_SETTLE_INTERVAL_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (terminalHoldsChat(await probe())) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** Polls a just-created pane until it reports a foreground, or the launch settle passes. A probe that already names a program returns at once. */
export async function waitForForeground(
  deps: Pick<ResumeDeps, 'probe' | 'sleep' | 'now'>,
  opts: { shellReadyMs?: number; shellReadyIntervalMs?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.shellReadyMs ?? SHELL_READY_MS;
  const intervalMs = opts.shellReadyIntervalMs ?? SHELL_READY_INTERVAL_MS;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let fg = await deps.probe();
  while ((fg == null || !fg.trim()) && now() < deadline) {
    await sleep(intervalMs);
    fg = await deps.probe();
  }
  return fg;
}

/**
 * Continue the chat's session in the agent pane. Run it under the pane's
 * lock: it reads `running` and probes the pane there, so a send that got the
 * lock first has already started its turn (refused here), and one waiting
 * behind it sees the Claude this typed.
 */
export async function resumeChatInPane(
  deps: ResumeDeps,
  opts: { timeoutMs?: number; intervalMs?: number; shellReadyMs?: number; shellReadyIntervalMs?: number } = {},
): Promise<ResumeOutcome> {
  const history = await deps.history();
  if (history.running) return { status: 'turn-running' };
  const command = resumeCommandFor(history.sessionId);
  if (!command) return { status: 'skipped', reason: 'no-session' };
  const sessionId = history.sessionId as string;
  await deps.ensurePane();
  // A pane that just came up can report no foreground yet. Wait it out, the
  // way launch does, before treating an empty probe as unknown.
  const decision = resumeDecision(await waitForForeground(deps, opts));
  if (decision !== 'type') return { status: 'skipped', reason: decision, sessionId };
  // The pane wait is long enough for the runner to take the next queued job.
  // Claim the chat first (the runner then will not start that job), and refuse
  // when a turn already owns the session, including one still inspecting its
  // checkout. The claim's line is the only resume that is typed: the runner
  // built it from the same flags a turn uses. An older agent has no claim, or
  // returns no line; either way nothing is typed, so a bare resume cannot
  // drop the closure.
  let claimed = false;
  let typed = false;
  let settled = false;
  try {
    let line: unknown = null;
    if (deps.claim) {
      try {
        const c = await deps.claim();
        if (c.claimed !== true) return { status: 'turn-running' };
        claimed = true;
        line = c.line;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/Unknown command/.test(message)) {
          // The box may already have taken the hold. The reply never arrived,
          // so claimed stays false and the finally below would skip release.
          // Releasing an unheld claim just deletes the set key.
          await deps.release?.(false, false).catch(() => {});
          throw err;
        }
        if ((await deps.history()).running) return { status: 'turn-running' };
      }
    } else if ((await deps.history()).running) {
      return { status: 'turn-running' };
    }
    if (!isSafeResumeLine(line)) return { status: 'skipped', reason: 'resume-unprepared', sessionId };
    // claimResume inspects the checkout before it returns, which can take
    // seconds. The shell decision above is stale by then: vim, or another
    // Claude, may own the pane. Probe again and type only while it is still
    // an idle shell. The finally releases the hold, so a refused type does
    // not leave the queue parked.
    const again = resumeDecision(await deps.probe());
    if (again !== 'type') return { status: 'skipped', reason: again, sessionId };
    await deps.type(line);
    typed = true;
    settled = await waitForClaude(deps.probe, { ...opts, sleep: deps.sleep, now: deps.now });
    return { status: 'resumed', sessionId, settled };
  } finally {
    if (claimed) await deps.release?.(typed, settled);
  }
}

/**
 * The chat's send, refused while a Claude holds the session in the pane. Run
 * it under the pane's lock too, so it never probes between a resume's keys
 * and its Claude coming up.
 */
export async function sendUnlessTerminalHolds<T>(
  probe: () => Promise<PaneForeground | string | null>,
  send: (pane: PaneProbe) => Promise<T>,
): Promise<{ held: true } | { held: false; result: T }> {
  const fg = await probe();
  // A live Claude in the pane owns the session. A dead pane whose command
  // name is still `claude` does not: that flag is stale, and the runner
  // hears `shell` so the claim clears and this send can start. Anything
  // else is handed over with its probe kind. A miss is not "Claude left".
  if (paneStillHolds(fg)) return { held: true };
  return { held: false, result: await send(probeFromForeground(fg)) };
}

/** Claude is in the agent pane, so the chat will not start a second writer or drop the parked queue. */
export const TERMINAL_HOLDS_ANSWER = {
  status: 409 as const,
  body: {
    error: 'Claude is open in the full UI. Return it to this chat, or continue there.',
    code: 'terminal-holds' as const,
  },
};

/** How long to wait after `/exit` for the pane to leave Claude. */
export const RECLAIM_EXIT_TIMEOUT_MS = 5_000;

/**
 * What a reclaim types into a pane whose foreground is Claude, and nothing
 * else. Literal keys, then Enter (the agent sends Enter separately). Never a
 * resume, and never typed unless a probe just said Claude is the foreground.
 */
export const CLAUDE_EXIT_KEYS = '/exit';

export interface ReclaimDeps {
  probe(): Promise<PaneForeground | string | null>;
  /** Type `CLAUDE_EXIT_KEYS` and Enter. Only called after a probe just showed Claude. */
  exitClaude(): Promise<void>;
  /**
   * Record the probe. `claude` marks the claim seen, so a later shell is
   * Claude having left and not the resume start-grace. `shell` clears that.
   * `resume: false` means the claim still holds (the resume was typed and
   * Claude has not been seen). A missing answer is an agent from before
   * this RPC: the following send's probe is what clears a claim it understands.
   */
  notePane(probe: PaneProbe): Promise<{ resume?: boolean } | void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export type ReclaimOutcome =
  | { status: 'free'; typed: false }
  | { status: 'reclaimed'; typed: true }
  | { status: 'held'; typed: boolean; reason: 'claude-open' | 'pane-busy' | 'pane-unknown' | 'starting' };

/** Polls until the pane is not a live Claude. A miss does not count as Claude having left. */
export async function waitForPaneFree(
  probe: () => Promise<PaneForeground | string | null>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? RECLAIM_EXIT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? RESUME_SETTLE_INTERVAL_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const fg = await probe();
    if (!paneStillHolds(fg) && probeFromForeground(fg) !== 'unknown') return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * The pane is not a live Claude. A shell clears a stale claim (Claude was
 * seen and has left) and the chat may send. A shell that does not clear the
 * claim is the resume start-grace: Claude has not been seen, so nothing is
 * typed and nothing is sent. A miss or another program is left alone.
 */
async function releaseIfShell(deps: ReclaimDeps, fg: PaneForeground | string | null): Promise<ReclaimOutcome> {
  const kind = probeFromForeground(fg);
  if (kind === 'unknown') return { status: 'held', typed: false, reason: 'pane-unknown' };
  if (kind !== 'shell') return { status: 'held', typed: false, reason: 'pane-busy' };
  const noted = await deps.notePane('shell');
  if (noted && noted.resume === false) return { status: 'held', typed: false, reason: 'starting' };
  return { status: 'free', typed: false };
}

/**
 * Give the chat its session back. Run it under the pane's lock, the same
 * one as resume and send, so it never types between a resume's keys and
 * Claude coming up, and a send cannot start a second writer while this exits.
 * `/exit` is typed only when a probe immediately beforehand says Claude is
 * the foreground. A shell, including a dead pane whose command name is still
 * `claude`, types nothing and clears the stale claim.
 */
export async function reclaimChatFromPane(
  deps: ReclaimDeps,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ReclaimOutcome> {
  const first = await deps.probe();
  if (!paneStillHolds(first)) return releaseIfShell(deps, first);
  // Claude may have exited since the send that was refused. Probe again
  // immediately before typing, so `/exit` never lands in the shell.
  const again = await deps.probe();
  if (!paneStillHolds(again)) return releaseIfShell(deps, again);
  // Seen, before the keys: a shell after this is Claude having left, not the
  // grace that keeps a just-typed resume from counting as an exit.
  await deps.notePane('claude');
  await deps.exitClaude();
  const left = await waitForPaneFree(deps.probe, { ...opts, sleep: deps.sleep, now: deps.now });
  if (!left) return { status: 'held', typed: true, reason: 'claude-open' };
  const after = await deps.probe();
  if (paneStillHolds(after)) return { status: 'held', typed: true, reason: 'claude-open' };
  if (probeFromForeground(after) !== 'shell') return { status: 'held', typed: true, reason: 'pane-busy' };
  const noted = await deps.notePane('shell');
  if (noted && noted.resume === false) return { status: 'held', typed: true, reason: 'starting' };
  return { status: 'reclaimed', typed: true };
}

/** POST /chat/reclaim's status. A hold sends nothing. A freed pane may include the send that followed. */
export function reclaimAnswer(r: ReclaimOutcome, sent?: Record<string, unknown>): { status: number; body: unknown } {
  if (r.status === 'held') {
    return {
      status: 409,
      body: { ...TERMINAL_HOLDS_ANSWER.body, reclaimed: false, typed: r.typed, reason: r.reason },
    };
  }
  const body = { reclaimed: true, typed: r.typed, sent: Boolean(sent) };
  if (!sent) return { status: 200, body };
  return { status: 202, body: { ...body, ...sent } };
}

/** POST /chat/terminal's status from the pane outcome. */
export function terminalAnswer(r: ResumeOutcome): { status: number; body: unknown } {
  if (r.status === 'turn-running') {
    return { status: 409, body: { error: 'Claude is answering in the chat; open it in the full UI when the turn ends', code: 'turn-running' } };
  }
  if (r.status === 'skipped') {
    return { status: 200, body: { resumed: false, reason: r.reason, ...(r.sessionId ? { sessionId: r.sessionId } : {}) } };
  }
  return { status: 200, body: { resumed: true, sessionId: r.sessionId, settled: r.settled } };
}

/**
 * POST /chat/interrupt. `held` means the pane has the session and no runner
 * turn is going: the parked queue stays, and the route answers terminal-holds.
 */
export function interruptAnswer(data: { held?: boolean } | null | undefined): { status: number; body: unknown } {
  if (data && data.held === true) return TERMINAL_HOLDS_ANSWER;
  return { status: 200, body: data ?? {} };
}
