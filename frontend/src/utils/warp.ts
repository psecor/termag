import { AgentStatus, StatusMap } from '../types';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeActivityScore(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

function getSessionWarpContribution(session?: AgentStatus): number {
  if (!session) return 0;
  const activity = normalizeActivityScore(session.activityScore);

  if (session.status === 'working') {
    return 1.0 + activity * 0.5;
  }

  if (session.status === 'waiting') {
    return 0.2 + activity * 0.2;
  }

  return 0;
}

export function computeLegacyWarp(activeCount: number, typingBoost: boolean): number {
  const count = Number(activeCount) || 0;
  const baseSpeed = count === 0 ? 0.4 : 0.4 + count * 2;
  const speed = baseSpeed + (typingBoost ? Math.max(0.8, baseSpeed * 0.5) : 0);
  return speed <= 0.4 ? 0.1 : speed * 0.5;
}

export function computeWarpWithFallback(statusMap: StatusMap, typingBoost: boolean): {
  mode: 'legacy' | 'activity';
  targetWarp: number;
  workingCount: number;
  waitingCount: number;
  isActive: boolean;
} {
  const sessions = Object.values(statusMap);
  const hasActivityScores = sessions.some((session) => typeof session?.activityScore === 'number');
  const workingCount = sessions.filter((session) => session?.status === 'working').length;
  const waitingCount = sessions.filter((session) => session?.status === 'waiting').length;

  if (!hasActivityScores) {
    return {
      mode: 'legacy',
      targetWarp: computeLegacyWarp(workingCount, typingBoost),
      workingCount,
      waitingCount,
      isActive: workingCount > 0 || typingBoost,
    };
  }

  const sessionContribution = sessions.reduce((sum, session) => sum + getSessionWarpContribution(session), 0);
  return {
    mode: 'activity',
    targetWarp: 0.1 + sessionContribution + (typingBoost ? 0.5 : 0),
    workingCount,
    waitingCount,
    isActive: workingCount > 0 || waitingCount > 0 || typingBoost,
  };
}
