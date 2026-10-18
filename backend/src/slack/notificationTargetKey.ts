/** Empty string is the orchestrator and any row written before instance identity existed. */
export const LEGACY_INSTANCE_KEY = '';

export function instanceKey(instanceId: string | null | undefined): string {
  return instanceId ? instanceId : LEGACY_INSTANCE_KEY;
}

export function notificationCacheKey(
  session: string,
  platform: string,
  instanceId: string | null | undefined,
): string {
  return `${instanceKey(instanceId)}|${session}:${platform}`;
}

export interface NotificationTargetRow {
  tmuxSession: string;
  platform: string;
  instanceId: string;
  channel: string;
  userId: string;
}

export function targetsForInstance(
  rows: readonly NotificationTargetRow[],
  session: string,
  instanceId: string | null,
): NotificationTargetRow[] {
  const mine = rows.filter(r => r.tmuxSession === session);
  const key = instanceKey(instanceId);
  const legacy = mine.filter(r => r.instanceId === LEGACY_INSTANCE_KEY);
  if (key === LEGACY_INSTANCE_KEY) return legacy;
  const specific = mine.filter(r => r.instanceId === key);
  const specificPlatforms = new Set(specific.map(r => r.platform));
  const fallback = legacy.filter(r => !specificPlatforms.has(r.platform));
  return [...specific, ...fallback];
}
