function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeActivityScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

function sessionWarpContribution(session) {
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

export function computeWarpSpeed(sessions, typingBoost = false) {
  const values = [...sessions.values()];
  const hasActivityScores = values.some((session) => typeof session?.activityScore === 'number');
  const workingCount = values.filter((session) => session?.status === 'working').length;

  if (!hasActivityScores) {
    const baseSpeed = workingCount === 0 ? 0.4 : 0.4 + workingCount * 2;
    const speed = baseSpeed + (typingBoost ? Math.max(0.8, baseSpeed * 0.5) : 0);
    return speed <= 0.4 ? 0.1 : speed * 0.5;
  }

  const sessionContribution = values.reduce((sum, session) => sum + sessionWarpContribution(session), 0);
  return 0.1 + sessionContribution + (typingBoost ? 0.5 : 0);
}
