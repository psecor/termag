/**
 * Tmux Pane Poller — infers agent status for providers without hooks/event APIs.
 *
 * Polls tmux pane content periodically and detects status from output patterns.
 * Provider-specific patterns (idle prompts, activity words, spinners, status bars)
 * come from the provider registry's pollerConfig.
 *
 * Three-state model:
 *   - working (green): activity patterns or spinner visible, or content recently changed
 *   - idle (red): idle prompt visible with no activity
 *   - not_running: agent process not in foreground
 *
 * Debounce strategy: cooldown-based. Any working signal resets a timer.
 * Only transition away from working after the cooldown expires.
 */

import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { capturePaneText, isAgentRunning, sessionName } from './tmux';
import { getStatus, setStatus, notifyStatusChange } from './status';
import { PROVIDERS, pollerProviderIds, ProviderConfig } from '../providers/registry';

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 2000;
const WORKING_COOLDOWN_MS = 4000;

// Estimated context window size for token approximation (cursor-like providers)
const ESTIMATED_WINDOW_TOKENS = 200_000;
const SESSION_RESET_THRESHOLD = 15;
const PERSIST_INTERVAL_MS = 60_000;
const USAGE_FILE = '/var/tmp/termag-poller-usage.json';

// ── Session state ───────────────────────────────────────────

interface SessionState {
  lastContent: string;
  lastChangeAt: number;
  lastWorkingAt: number;
  provider: string;
}

interface SessionUsageState {
  lastContextPct: number;
  sessionPeakPct: number;
}

interface DailyUsage {
  completedTokens: number;
  calls: number;
}

const polledSessions = new Map<string, SessionState>();
const sessionUsage = new Map<string, SessionUsageState>();
const usageByUser = new Map<string, Map<string, DailyUsage>>();
let pollTimer: NodeJS.Timeout | null = null;
let persistTimer: NodeJS.Timeout | null = null;

// ── Helpers ─────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[^[\]]/g, '');
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function usernameFromSession(tmuxSession: string): string {
  return tmuxSession.split('-')[0];
}

// ── Usage accumulation (for providers with statusBarParser) ─

function ensureUserDay(username: string, date: string): DailyUsage {
  let userMap = usageByUser.get(username);
  if (!userMap) {
    userMap = new Map();
    usageByUser.set(username, userMap);
  }
  let day = userMap.get(date);
  if (!day) {
    day = { completedTokens: 0, calls: 0 };
    userMap.set(date, day);
  }
  return day;
}

function recordContextPct(tmuxSession: string, pct: number): void {
  const username = usernameFromSession(tmuxSession);
  const today = todayStr();
  let state = sessionUsage.get(tmuxSession);

  if (!state) {
    sessionUsage.set(tmuxSession, { lastContextPct: pct, sessionPeakPct: pct });
    return;
  }

  if (pct < state.lastContextPct - SESSION_RESET_THRESHOLD && state.sessionPeakPct > 0) {
    const tokens = Math.round((state.sessionPeakPct / 100) * ESTIMATED_WINDOW_TOKENS);
    const day = ensureUserDay(username, today);
    day.completedTokens += tokens;
    day.calls += 1;
    console.log(`[TMUX-POLLER] Session reset for ${tmuxSession}: banked ${tokens} tokens (peak ${state.sessionPeakPct.toFixed(1)}%)`);
    state.sessionPeakPct = pct;
  } else {
    state.sessionPeakPct = Math.max(state.sessionPeakPct, pct);
  }

  state.lastContextPct = pct;
}

/** Get estimated usage data for a user from polled providers */
export function getPollerUsage(username: string): Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number }> {
  const result: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number }> = {};

  const userMap = usageByUser.get(username);
  if (userMap) {
    for (const [date, day] of userMap) {
      result[date] = { input: day.completedTokens, output: 0, cacheRead: 0, cacheCreate: 0, calls: day.calls };
    }
  }

  const today = todayStr();
  for (const [session, state] of sessionUsage) {
    if (usernameFromSession(session) !== username) continue;
    if (state.sessionPeakPct <= 0) continue;
    const activeTokens = Math.round((state.sessionPeakPct / 100) * ESTIMATED_WINDOW_TOKENS);
    if (!result[today]) {
      result[today] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };
    }
    result[today].input += activeTokens;
  }

  return result;
}

function persistUsage(): void {
  try {
    const data: Record<string, Record<string, DailyUsage>> = {};
    for (const [username, userMap] of usageByUser) {
      data[username] = Object.fromEntries(userMap);
    }
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[TMUX-POLLER] Failed to persist usage:', (err as Error).message);
  }
}

function loadUsage(): void {
  try {
    if (!fs.existsSync(USAGE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    for (const [username, days] of Object.entries(raw as Record<string, Record<string, DailyUsage>>)) {
      const userMap = new Map<string, DailyUsage>();
      for (const [date, day] of Object.entries(days)) {
        userMap.set(date, day);
      }
      usageByUser.set(username, userMap);
    }
    if (usageByUser.size > 0) {
      console.log(`[TMUX-POLLER] Loaded usage data for ${usageByUser.size} user(s)`);
    }
  } catch (err) {
    console.error('[TMUX-POLLER] Failed to load usage:', (err as Error).message);
  }
}

// ── Status inference ────────────────────────────────────────

type RawStatus = 'working' | 'waiting' | 'idle' | 'not_running';

function inferRawStatus(
  paneContent: string,
  config: ProviderConfig,
  previousContent: string | undefined,
  lastChangeAt: number,
  now: number,
): RawStatus {
  const pollerCfg = config.pollerConfig;
  if (!pollerCfg) return 'idle';

  const lines = paneContent.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  const tail = nonEmpty.slice(-20);

  // Check for activity patterns or spinner on short lines
  const hasActivity = tail.some(line => {
    const trimmed = line.trim();
    if (trimmed.length >= 80) return false;
    if (pollerCfg.activityPatterns.some(p => p.test(trimmed))) return true;
    if (pollerCfg.spinnerPattern?.test(trimmed)) return true;
    return false;
  });

  const tailText = tail.join('\n');
  const hasPrompt = pollerCfg.idlePattern.test(tailText);

  // Check for waiting-on-user patterns (e.g. permission prompts) — highest priority
  if (pollerCfg.waitingPatterns?.length) {
    const hasWaiting = tail.some(line =>
      pollerCfg.waitingPatterns!.some(p => p.test(line))
    );
    if (hasWaiting) return 'waiting';
  }

  // Activity/spinner beats the prompt (some TUIs like vibe always show the
  // input box, so the prompt alone doesn't mean idle).
  if (hasActivity) return 'working';

  const contentChanged = previousContent !== undefined && previousContent !== '' && paneContent !== previousContent;
  if (contentChanged && !hasPrompt) return 'working';

  if (!hasPrompt && now - lastChangeAt < 3000) return 'working';

  return 'idle';
}

// ── Poll loop ───────────────────────────────────────────────

async function pollSession(tmuxSession: string): Promise<void> {
  const state = polledSessions.get(tmuxSession)!;
  const config = PROVIDERS[state.provider];
  const pollerSource = `tmux-poller:${state.provider}`;

  const running = await isAgentRunning(tmuxSession);
  if (!running) {
    const current = getStatus(tmuxSession);
    if ((current.source && current.source.startsWith('tmux-poller')) || current.status === 'not_running') {
      if (current.status !== 'not_running') {
        setStatus(tmuxSession, 'not_running', { source: pollerSource });
        notifyStatusChange(tmuxSession);
      }
    }
    return;
  }
  if (!config) return;

  const rawContent = await capturePaneText(tmuxSession);
  const paneContent = stripAnsi(rawContent);
  const previous = state.lastContent || undefined;
  const now = Date.now();

  if (paneContent !== state.lastContent) {
    state.lastChangeAt = now;
  }
  state.lastContent = paneContent;

  // Don't override status from non-poller sources
  const current = getStatus(tmuxSession);
  if (current.source && !current.source.startsWith('tmux-poller') && current.source !== 'tmux-fallback') {
    return;
  }

  const raw = inferRawStatus(paneContent, config, previous, state.lastChangeAt, now);

  // Parse status bar metadata if the provider has a parser
  const lines = paneContent.split('\n');
  let pollerMeta: Record<string, any> | undefined;
  if (config.pollerConfig?.statusBarParser) {
    const parsed = config.pollerConfig.statusBarParser(lines);
    if (Object.keys(parsed).length > 0) {
      pollerMeta = parsed;
      // Feed context % into usage accumulator if present
      if (typeof parsed.cursorContextPct === 'number') {
        recordContextPct(tmuxSession, parsed.cursorContextPct);
      }
    }
  }

  const metaChanged = JSON.stringify(current.pollerMeta) !== JSON.stringify(pollerMeta);

  if (raw === 'working') {
    state.lastWorkingAt = now;
    if (current.status !== 'working' || metaChanged) {
      setStatus(tmuxSession, 'working', { source: pollerSource, pollerMeta });
      notifyStatusChange(tmuxSession);
    }
    return;
  }

  if (current.status === 'working') {
    const elapsed = now - state.lastWorkingAt;
    if (elapsed < WORKING_COOLDOWN_MS) return;
  }

  if (current.status !== raw || metaChanged) {
    setStatus(tmuxSession, raw, { source: pollerSource, pollerMeta });
    notifyStatusChange(tmuxSession);
  }
}

async function pollAll(): Promise<void> {
  const sessions = Array.from(polledSessions.keys());
  for (const session of sessions) {
    try {
      await pollSession(session);
    } catch (err) {
      console.error(`[TMUX-POLLER] Error polling ${session}:`, (err as Error).message);
    }
  }
}

// ── Public API ──────────────────────────────────────────────

export function registerPollerSession(tmuxSession: string, provider: string): void {
  if (!polledSessions.has(tmuxSession)) {
    console.log(`[TMUX-POLLER] Registered ${tmuxSession} (${provider})`);
    polledSessions.set(tmuxSession, { lastContent: '', lastChangeAt: 0, lastWorkingAt: 0, provider });
  }
}

export function unregisterPollerSession(tmuxSession: string): void {
  if (polledSessions.has(tmuxSession)) {
    console.log(`[TMUX-POLLER] Unregistered ${tmuxSession}`);
    polledSessions.delete(tmuxSession);
  }
}

export async function startTmuxPoller(): Promise<void> {
  loadUsage();

  // Register all non-archived workflows for providers that need polling
  const pollerIds = pollerProviderIds();
  if (pollerIds.length === 0) return;

  const workflows = await prisma.workflow.findMany({
    where: { type: 'agent', provider: { in: pollerIds } },
    include: { project: { include: { user: true } }, workstream: true },
  });

  for (const wf of workflows) {
    if (!wf.project.archived && wf.provider) {
      const session = sessionName(wf.project.user.unixUsername, wf.project.name, 'agent', wf.workstream.name);
      registerPollerSession(session, wf.provider);
    }
  }

  if (polledSessions.size > 0) {
    console.log(`[TMUX-POLLER] Starting with ${polledSessions.size} session(s)`);
    await pollAll();
  }

  pollTimer = setInterval(() => {
    pollAll().catch(err => console.error('[TMUX-POLLER] Poll error:', err));
  }, POLL_INTERVAL_MS);

  persistTimer = setInterval(persistUsage, PERSIST_INTERVAL_MS);
}

export function stopTmuxPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (persistTimer) { clearInterval(persistTimer); persistTimer = null; }
  persistUsage();
}
