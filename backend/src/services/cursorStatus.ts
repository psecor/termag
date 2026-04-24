/**
 * Cursor Agent Status Poller
 *
 * Cursor's "agent" CLI has no hooks or event API, so we infer status
 * by polling tmux pane content and detecting output patterns.
 *
 * Three-state model:
 *   - working (green): activity words or Braille spinner visible, or content recently changed
 *   - idle (red): → prompt visible with no activity (cursor always shows this at rest)
 *   - not_running: agent process not in foreground
 *
 * Debounce strategy: cooldown-based. Any working signal resets a timer.
 * Only transition away from working after the cooldown expires.
 */

import { PrismaClient } from '@prisma/client';
import { capturePaneText, isAgentRunning, sessionName } from './tmux';
import { getStatus, setStatus, notifyStatusChange } from './status';

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 2000;
// After the last working signal, wait this long before transitioning away
const WORKING_COOLDOWN_MS = 4000;

interface SessionState {
  lastContent: string;
  lastChangeAt: number;     // timestamp of last content change
  lastWorkingAt: number;    // timestamp of last working signal
}

const polledSessions = new Map<string, SessionState>();
let pollTimer: NodeJS.Timeout | null = null;

// Strip ANSI escape sequences from captured pane text
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[^[\]]/g, '');
}

// Detect cursor idle prompt: line starting with → (Unicode arrow)
const IDLE_PROMPT = /^\s*→\s/m;

// Activity indicators that cursor shows on short lines while working.
// These appear inline above the prompt during active turns.
const ACTIVITY_PATTERN = /^\s*(Thinking|Composing|Reading|Globbing|Writing|Editing|Searching|Running|Executing|Applying|Planning|Grepping|Using tool|Running command)\b/i;

// Braille block characters (U+2800-U+28FF) used as animated spinner by cursor CLI.
// These appear on short status lines like " ⠤⠃ Running  349 tokens" and change every
// poll cycle, making them a very reliable working signal.
const BRAILLE_SPINNER = /[\u2800-\u28FF]/;

type RawStatus = 'working' | 'waiting' | 'idle' | 'not_running';

function inferRawStatus(
  paneContent: string,
  previousContent: string | undefined,
  lastChangeAt: number,
  now: number,
): RawStatus {
  const lines = paneContent.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  // Widen tail window to catch indicators that scroll above the visible prompt area
  const tail = nonEmpty.slice(-20);

  // Check for activity words or Braille spinner on short lines
  const hasActivity = tail.some(
    line => line.trim().length < 80 && (
      ACTIVITY_PATTERN.test(line.trim()) || BRAILLE_SPINNER.test(line.trim())
    ),
  );

  // Check for the → prompt in the tail
  const tailText = tail.join('\n');
  const hasPrompt = IDLE_PROMPT.test(tailText);

  // Activity words → definitely working, regardless of prompt
  if (hasActivity) {
    return 'working';
  }

  // Content changed since last poll → working, BUT only if we have a real previous
  // capture (not the initial empty string) and the prompt isn't the only thing changing
  // (user typing on the → prompt line shouldn't trigger working)
  const contentChanged = previousContent !== undefined && previousContent !== '' && paneContent !== previousContent;
  if (contentChanged && !hasPrompt) {
    // No prompt visible and content changed — agent is producing output
    return 'working';
  }

  // Content is stable (no change this poll), or changed but prompt is visible (user typing)
  // If content changed recently (within 3s) and no prompt, still bias toward working
  if (!hasPrompt && now - lastChangeAt < 3000) {
    return 'working';
  }

  // Stable and no recent changes
  // The → prompt in cursor is always present (it's the input field with a suggestion),
  // not a blocking request for user input. So treat it as idle, not waiting.
  if (hasPrompt) {
    return 'idle';
  }

  // Stable, no prompt, no activity — truly idle
  return 'idle';
}

async function pollSession(tmuxSession: string): Promise<void> {
  const running = await isAgentRunning(tmuxSession);
  if (!running) {
    const current = getStatus(tmuxSession);
    if (current.source === 'tmux-poller' || current.status === 'not_running') {
      if (current.status !== 'not_running') {
        setStatus(tmuxSession, 'not_running', { source: 'tmux-poller' });
        notifyStatusChange(tmuxSession);
      }
    }
    return;
  }

  const state = polledSessions.get(tmuxSession)!;
  const rawContent = await capturePaneText(tmuxSession);
  const paneContent = stripAnsi(rawContent);
  const previous = state.lastContent || undefined;

  const now = Date.now();

  // Track content changes
  if (paneContent !== state.lastContent) {
    state.lastChangeAt = now;
  }
  state.lastContent = paneContent;

  // Don't override status from other sources (claude-hooks, codex-app-server)
  const current = getStatus(tmuxSession);
  if (current.source && current.source !== 'tmux-poller' && current.source !== 'tmux-fallback') {
    return;
  }

  const raw = inferRawStatus(paneContent, previous, state.lastChangeAt, now);

  // Working signal → immediately update, reset cooldown
  if (raw === 'working') {
    state.lastWorkingAt = now;
    if (current.status !== 'working') {
      setStatus(tmuxSession, 'working', { source: 'tmux-poller' });
      notifyStatusChange(tmuxSession);
    }
    return;
  }

  // Transitioning away from working → apply cooldown
  if (current.status === 'working') {
    const elapsed = now - state.lastWorkingAt;
    if (elapsed < WORKING_COOLDOWN_MS) {
      return; // stay working during cooldown
    }
  }

  // Cooldown expired or wasn't working — apply the raw status
  if (current.status !== raw) {
    setStatus(tmuxSession, raw, { source: 'tmux-poller' });
    notifyStatusChange(tmuxSession);
  }
}

async function pollAll(): Promise<void> {
  const sessions = Array.from(polledSessions.keys());
  for (const session of sessions) {
    try {
      await pollSession(session);
    } catch (err) {
      console.error(`[CURSOR-POLLER] Error polling ${session}:`, (err as Error).message);
    }
  }
}

export function registerCursorSession(tmuxSession: string): void {
  if (!polledSessions.has(tmuxSession)) {
    console.log(`[CURSOR-POLLER] Registered ${tmuxSession}`);
    polledSessions.set(tmuxSession, { lastContent: '', lastChangeAt: 0, lastWorkingAt: 0 });
  }
}

export function unregisterCursorSession(tmuxSession: string): void {
  if (polledSessions.has(tmuxSession)) {
    console.log(`[CURSOR-POLLER] Unregistered ${tmuxSession}`);
    polledSessions.delete(tmuxSession);
  }
}

export async function startCursorPoller(): Promise<void> {
  const workflows = await prisma.workflow.findMany({
    where: { type: 'agent', provider: 'cursor' },
    include: { project: { include: { user: true } } },
  });

  for (const wf of workflows) {
    if (!wf.project.archived) {
      const session = sessionName(wf.project.user.unixUsername, wf.project.name, 'agent');
      registerCursorSession(session);
    }
  }

  if (polledSessions.size > 0) {
    console.log(`[CURSOR-POLLER] Starting with ${polledSessions.size} session(s)`);
    await pollAll();
  }

  pollTimer = setInterval(() => {
    pollAll().catch(err => console.error('[CURSOR-POLLER] Poll error:', err));
  }, POLL_INTERVAL_MS);
}

export function stopCursorPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
