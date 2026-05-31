/**
 * Human Activity Tracker — accumulates personal working time from UI heartbeats.
 *
 * The frontend sends a heartbeat whenever the user types in a terminal pane.
 * If no heartbeat arrives within DECAY_MS, the session is considered inactive
 * and the accumulated time is banked into work_time_entries with provider="human".
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DECAY_MS = 3 * 60 * 1000; // 3 minutes
const CHECK_INTERVAL_MS = 30_000; // check for decay every 30s

interface ActiveSession {
  startedAt: number;
  lastHeartbeat: number;
  username: string;
  project: string;
}

const activeSessions = new Map<string, ActiveSession>(); // key: `${username}:${project}`
let checkTimer: NodeJS.Timeout | null = null;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sessionKey(username: string, project: string): string {
  return `${username}:${project}`;
}

function bankTime(session: ActiveSession): void {
  const durationMs = session.lastHeartbeat - session.startedAt;
  if (durationMs < 5000) return; // ignore trivial blips

  const date = todayStr();
  prisma.workTimeEntry.upsert({
    where: {
      username_project_provider_date: {
        username: session.username,
        project: session.project,
        provider: 'human',
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
      provider: 'human',
      date,
      totalMs: durationMs,
      sessions: 1,
    },
  }).catch(err => {
    console.error('[HUMAN-ACTIVITY] Failed to persist:', (err as Error).message);
  });
}

function checkDecay(): void {
  const now = Date.now();
  for (const [key, session] of activeSessions) {
    if (now - session.lastHeartbeat >= DECAY_MS) {
      bankTime(session);
      activeSessions.delete(key);
    }
  }
}

/** Called on each frontend heartbeat */
export function recordHeartbeat(username: string, project: string): void {
  const key = sessionKey(username, project);
  const now = Date.now();
  const existing = activeSessions.get(key);

  if (existing) {
    // If decayed and restarting, bank the old session first
    if (now - existing.lastHeartbeat >= DECAY_MS) {
      bankTime(existing);
      activeSessions.set(key, { startedAt: now, lastHeartbeat: now, username, project });
    } else {
      existing.lastHeartbeat = now;
    }
  } else {
    activeSessions.set(key, { startedAt: now, lastHeartbeat: now, username, project });
  }
}

/** Start the decay checker */
export function startHumanActivityTracker(): void {
  if (checkTimer) return;
  checkTimer = setInterval(checkDecay, CHECK_INTERVAL_MS);
}

/** Stop tracker and bank all active sessions */
export function stopHumanActivityTracker(): void {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  for (const [key, session] of activeSessions) {
    bankTime(session);
    activeSessions.delete(key);
  }
}
