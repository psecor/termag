import { PrismaClient } from '@prisma/client';
import { AgentStatus, StatusMap } from '../types/index';
import { isAgentRunning } from './tmux';
import { providerForSource } from '../providers/registry';

const prisma = new PrismaClient();

// In-memory status map. Keyed by tmux session name.
const statusMap: StatusMap = new Map();

// Auto-revert "working" → "idle" after 5 minutes (safety net if Stop hook doesn't fire)
const AUTO_IDLE_MS = 5 * 60 * 1000;
const autoIdleTimers = new Map<string, NodeJS.Timeout>();

type AgentStatusMeta = Omit<Partial<AgentStatus>, 'status' | 'updatedAt'>;

// ── Working-time accumulator ───────────────────────────────────
// Tracks when sessions enter "working" and banks duration on transition out.

interface WorkingSession {
  startedAt: number;
  provider: string;
  project: string;
  username: string;
}

const workingSessions = new Map<string, WorkingSession>();

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseSessionName(sessionName: string): { username: string; project: string } | null {
  // Format: username-project-agent
  const m = sessionName.match(/^(.+?)-(.+)-agent$/);
  if (!m) return null;
  return { username: m[1], project: m[2] };
}

function startWorkingTimer(sessionName: string, source?: string): void {
  if (workingSessions.has(sessionName)) return;
  const parsed = parseSessionName(sessionName);
  if (!parsed) return;
  // Hooks-based providers (claude) don't send source; poller/bridge providers do.
  // Default to 'claude' when source is missing since that's the only hook-based provider.
  const provider = (source ? providerForSource(source) : null) ?? 'claude';
  workingSessions.set(sessionName, {
    startedAt: Date.now(),
    provider,
    project: parsed.project,
    username: parsed.username,
  });
}

function stopWorkingTimer(sessionName: string): void {
  const session = workingSessions.get(sessionName);
  if (!session) return;
  workingSessions.delete(sessionName);

  const durationMs = Date.now() - session.startedAt;
  if (durationMs < 1000) return; // ignore sub-second blips

  const date = todayStr();
  prisma.workTimeEntry.upsert({
    where: {
      username_project_provider_date: {
        username: session.username,
        project: session.project,
        provider: session.provider,
        date,
      },
    },
    update: {
      totalMs: { increment: durationMs },
      sessions: { increment: 1 },
    },
    create: {
      username: session.username,
      project: session.project,
      provider: session.provider,
      date,
      totalMs: durationMs,
      sessions: 1,
    },
  }).catch(err => {
    console.error('[WORKTIME] Failed to persist:', (err as Error).message);
  });
}

// ── Public status API ──────────────────────────────────────────

export function getStatus(sessionName: string): AgentStatus {
  return statusMap.get(sessionName) ?? { status: 'not_running', updatedAt: new Date() };
}

export function getAllStatuses(): Map<string, AgentStatus> {
  return statusMap;
}

export function setStatus(
  sessionName: string,
  status: AgentStatus['status'],
  messageOrMeta?: string | AgentStatusMeta,
  metaMaybe?: AgentStatusMeta,
): AgentStatus {
  const meta = typeof messageOrMeta === 'string'
    ? { ...(metaMaybe || {}), message: messageOrMeta }
    : (messageOrMeta || {});

  const previous = statusMap.get(sessionName);

  const entry: AgentStatus = {
    status,
    updatedAt: new Date(),
    message: meta.message,
    source: meta.source,
    waitingReason: meta.waitingReason,
    activityScore: meta.activityScore,
    tokenBurst: meta.tokenBurst,
    activeTurn: meta.activeTurn,
    threadId: meta.threadId,
    pollerMeta: meta.pollerMeta,
  };
  statusMap.set(sessionName, entry);

  // Working-time tracking: start/stop timers on transitions
  if (status === 'working' && previous?.status !== 'working') {
    startWorkingTimer(sessionName, meta.source);
  } else if (status !== 'working' && previous?.status === 'working') {
    stopWorkingTimer(sessionName);
  }

  // Clear previous auto-idle timer
  const existing = autoIdleTimers.get(sessionName);
  if (existing) clearTimeout(existing);

  // Set auto-idle only when working
  if (status === 'working') {
    const timer = setTimeout(() => {
      const current = statusMap.get(sessionName);
      if (current?.status === 'working') {
        statusMap.set(sessionName, {
          status: 'idle',
          updatedAt: new Date(),
          message: 'Auto-idled after inactivity',
          source: current.source,
          waitingReason: null,
          activityScore: 0,
          tokenBurst: current.tokenBurst,
          activeTurn: false,
          threadId: current.threadId,
        });
        stopWorkingTimer(sessionName);
        onStatusChange?.(sessionName);
      }
    }, AUTO_IDLE_MS);
    autoIdleTimers.set(sessionName, timer);
  }

  return entry;
}

// Resolve stoplight emoji from status + process check
export async function resolveStoplight(sessionName: string): Promise<string> {
  const s = getStatus(sessionName);
  const age = Date.now() - s.updatedAt.getTime();
  const STALE_MS = 10 * 60 * 1000;

  if (s.status === 'working') return '🟢';
  if (s.status === 'waiting') return '🟡';
  if (s.status === 'idle' && age < STALE_MS) return '🔴';

  // Stale or unknown — fall back to process check
  const running = await isAgentRunning(sessionName);
  if (running) return '🔘';
  const exists = s.status !== 'not_running';
  return exists ? '🔴' : '💤';
}

export function deleteStatus(sessionName: string): void {
  stopWorkingTimer(sessionName);
  statusMap.delete(sessionName);
  const timer = autoIdleTimers.get(sessionName);
  if (timer) {
    clearTimeout(timer);
    autoIdleTimers.delete(sessionName);
  }
}

// Hook for pushing status changes to WebSocket clients
let onStatusChange: ((sessionName: string) => void) | null = null;

export function setStatusChangeCallback(fn: (sessionName: string) => void): void {
  onStatusChange = fn;
}

export function notifyStatusChange(sessionName: string): void {
  onStatusChange?.(sessionName);
}
