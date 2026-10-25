import type { SpawnNode, SpawnSession, SpawnUsage } from '../services/api';

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

type Lifecycle = Partial<Pick<SpawnNode, 'parkedAt' | 'retiredAt' | 'keptReason'>>;

/** What to call a spawn's state: retired and parked say so, an ended agent too, keeping its last report. */
export function spawnStateLabel(n: Pick<SpawnNode, 'state' | 'endedAt'> & Lifecycle): string {
  const state = n.state === 'needs_input' ? 'needs input' : n.state;
  if (n.retiredAt) return `retired · ${state}`;
  // Ended while parked (its workstream removed by hand): the end is what holds now.
  if (n.endedAt) return n.parkedAt ? 'ended · parked' : `ended · ${state}`;
  if (n.parkedAt) return n.keptReason ? `parked · kept: ${n.keptReason}` : `parked · ${state}`;
  return state;
}

export function spawnStateTone(n: Pick<SpawnNode, 'state' | 'endedAt'> & Lifecycle): 'live' | 'attention' | 'done' | 'failed' | 'ended' | 'parked' {
  if (n.retiredAt || n.endedAt) return 'ended';
  if (n.parkedAt) return 'parked';
  if (n.state === 'failed') return 'failed';
  if (n.state === 'blocked' || n.state === 'needs_input') return 'attention';
  if (n.state === 'done') return 'done';
  return 'live';
}

/** The section shows only when there is something to show. */
export function hasSpawnActivity(u: SpawnUsage | null): u is SpawnUsage {
  return !!u && (u.trees.length > 0 || u.refusals.length > 0 || (u.orphans?.length ?? 0) > 0);
}

/** A session as the owner knows it ("proj/ws"), from the usage's session list, else its ids. */
export function sessionLabel(sessions: SpawnSession[] | undefined, projectId: string, workstream: string): string {
  return sessions?.find(s => s.projectId === projectId && s.workstream === workstream)?.label
    ?? (workstream === 'main' ? 'another project' : `another project's ${workstream}`);
}

/** The value a session picker uses for one session; parsed back by pickedSession. */
export const sessionKey = (s: { projectId: string; workstream: string }) => `${s.projectId}\u0000${s.workstream}`;
export function pickedSession(v: string): { projectId: string; workstream: string } | null {
  const [projectId, workstream] = v.split('\u0000');
  return projectId && workstream ? { projectId, workstream } : null;
}

const ADOPTED_BY: Record<string, string> = { ancestor: 'its nearest living ancestor', home: 'the orphan home', owner: 'you', agent: 'an agent' };

/** "adopted by proj (its nearest living ancestor)" for a fostered spawn, else null. */
export function fosterNote(n: Pick<SpawnNode, 'foster'>, sessions: SpawnSession[] | undefined): string | null {
  if (!n.foster) return null;
  const who = n.foster.by ? ADOPTED_BY[n.foster.by] : null;
  return `adopted by ${sessionLabel(sessions, n.foster.projectId, n.foster.workstream)}${who ? ` (${who})` : ''}`;
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

/** Which lifecycle buttons a row offers (the server decides whether they work). */
export function spawnActions(n: Pick<SpawnNode, 'state' | 'endedAt'> & Lifecycle): Array<'park' | 'resume' | 'retire'> {
  if (n.retiredAt) return [];
  if (n.parkedAt) return ['resume', 'retire'];
  if (n.endedAt) return ['retire'];
  return n.state === 'done' ? ['park', 'retire'] : [];
}

export interface OriginGroup {
  /** projectId + workstream, or '' for trees started from the browser. */
  key: string;
  origin: { projectId: string; workstream: string; session: string; label: string } | null;
  trees: SpawnUsage['trees'];
  agents: number;
  running: number;
  attention: number;
}

/**
 * The dashboard's trees grouped under the session that started them (its
 * parent row), in the order of each group's newest tree; trees started from
 * the browser are one group of their own.
 */
export function groupTreesByOrigin(trees: SpawnUsage['trees']): OriginGroup[] {
  const groups = new Map<string, OriginGroup>();
  for (const t of trees) {
    const key = t.origin ? `${t.origin.projectId}\u0000${t.origin.workstream}` : '';
    const g = groups.get(key) ?? { key, origin: t.origin ?? null, trees: [], agents: 0, running: 0, attention: 0 };
    g.trees.push(t);
    for (const n of t.nodes) {
      g.agents++;
      const tone = spawnStateTone(n);
      if (tone === 'live') g.running++;
      if (tone === 'attention') g.attention++;
    }
    groups.set(key, g);
  }
  return [...groups.values()];
}
