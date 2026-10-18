import type { SpawnNode, SpawnUsage } from '../services/api';

/** How full a limit is, for a meter: the fill turns warning near the limit and danger at it. */
export function meterTone(used: number, limit: number): 'ok' | 'near' | 'full' {
  if (limit <= 0 || used >= limit) return 'full';
  return used >= Math.ceil(limit * 0.8) ? 'near' : 'ok';
}

/** Fill fraction for a meter, 0–1. */
export function meterFill(used: number, limit: number): number {
  return limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 1;
}

const REASONS: Record<string, string> = {
  depth: 'too deep',
  open_children: 'too many open children',
  rate: 'hourly limit',
  concurrent: 'too many running',
  box_busy: 'box running hot',
  box_capacity: 'box full',
  box_offline: 'box offline',
  flag: 'not enabled',
  parked: 'box parked',
  'box-failed': 'box failed',
  box_terminated: 'box terminated',
  no_pane: 'not from an agent pane',
  not_found: 'session not found',
  name_taken: 'name taken',
  invalid: 'invalid request',
  create_failed: 'create failed',
  brief_write: 'brief not written',
};

/** A refusal reason in plain words; an unknown code is shown as it is. */
export function reasonLabel(reason: string): string {
  return REASONS[reason] ?? reason.replace(/_/g, ' ');
}

/** What to call a spawn's state: an ended agent says so, keeping its last report. */
export function spawnStateLabel(n: Pick<SpawnNode, 'state' | 'endedAt'>): string {
  const state = n.state === 'needs_input' ? 'needs input' : n.state;
  return n.endedAt ? `ended · ${state}` : state;
}

export function spawnStateTone(n: Pick<SpawnNode, 'state' | 'endedAt'>): 'live' | 'attention' | 'done' | 'failed' | 'ended' {
  if (n.endedAt) return 'ended';
  if (n.state === 'failed') return 'failed';
  if (n.state === 'blocked' || n.state === 'needs_input') return 'attention';
  if (n.state === 'done') return 'done';
  return 'live';
}

/** The section shows only when there is something to show. */
export function hasSpawnActivity(u: SpawnUsage | null): u is SpawnUsage {
  return !!u && (u.trees.length > 0 || u.refusals.length > 0);
}

export function nodeTokenTotal(n: Pick<SpawnNode, 'tokens'>): number | null {
  const t = n.tokens;
  return t ? t.input + t.output + t.cacheRead + t.cacheCreate : null;
}

/** The workspace deep link for a child's workstream, or null before its project exists. */
export function childLink(n: Pick<SpawnNode, 'child'>): string | null {
  if (!n.child.projectId) return null;
  const ws = n.child.workstream === 'main' ? '' : `&ws=${encodeURIComponent(n.child.workstream)}`;
  return `/?project=${encodeURIComponent(n.child.projectId)}${ws}`;
}
