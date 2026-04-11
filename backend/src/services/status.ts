import { AgentStatus, StatusMap } from '../types/index';
import { isAgentRunning } from './tmux';

// In-memory status map. Keyed by tmux session name.
const statusMap: StatusMap = new Map();

// Auto-revert "working" → "idle" after 5 minutes (safety net if Stop hook doesn't fire)
const AUTO_IDLE_MS = 5 * 60 * 1000;
const autoIdleTimers = new Map<string, NodeJS.Timeout>();

export function getStatus(sessionName: string): AgentStatus {
  return statusMap.get(sessionName) ?? { status: 'not_running', updatedAt: new Date() };
}

export function getAllStatuses(): Map<string, AgentStatus> {
  return statusMap;
}

export function setStatus(
  sessionName: string,
  status: AgentStatus['status'],
  message?: string
): AgentStatus {
  const entry: AgentStatus = { status, updatedAt: new Date(), message };
  statusMap.set(sessionName, entry);

  // Clear previous auto-idle timer
  const existing = autoIdleTimers.get(sessionName);
  if (existing) clearTimeout(existing);

  // Set auto-idle only when working
  if (status === 'working') {
    const timer = setTimeout(() => {
      const current = statusMap.get(sessionName);
      if (current?.status === 'working') {
        statusMap.set(sessionName, { status: 'idle', updatedAt: new Date() });
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

// Hook for pushing status changes to WebSocket clients
let onStatusChange: ((sessionName: string) => void) | null = null;

export function setStatusChangeCallback(fn: (sessionName: string) => void): void {
  onStatusChange = fn;
}

export function notifyStatusChange(sessionName: string): void {
  onStatusChange?.(sessionName);
}
