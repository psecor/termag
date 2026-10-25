/**
 * Work habits worth changing, from what termag already records over the last
 * PATTERN_DAYS days. The briefing's
 * model only words them; finding them is here, so each has a stable id that
 * Done and Defer can name, and nothing is invented.
 *
 * Pure: buildLedger reads the rows and passes them in.
 */
import type { LedgerPattern } from './types';

export const PATTERN_DAYS = 14;
/** Context peaks above this make a session slow and costly to continue. */
export const BIG_CONTEXT_TOKENS = 300_000;
/** A workstream untouched this long, and not archived, is clutter. */
export const STALE_WORKSTREAM_MS = 7 * 24 * 60 * 60 * 1000;
/** Project switches per active day above this. */
export const MANY_SWITCHES_PER_DAY = 25;
/** An agent waiting longer than this was probably forgotten. */
export const WAITING_LONG_MS = 8 * 60 * 60 * 1000;
export const MAX_PATTERNS = 8;

export interface PatternInput {
  now: Date;
  /** Peak context per workstream over the pattern days. */
  contextPeaks: Array<{ projectId: string; workstream: string; maxTokens: number | null }>;
  projectNames: ReadonlyMap<string, string>;
  /** Unarchived workstreams of the user's own projects. */
  workstreams: Array<{ projectId: string; name: string; lastActiveAt: Date }>;
  /** Current PR pipeline rows (lane ids), or null when GitHub did not answer. */
  prs: Array<{ lane: string; repo: string | null; number: number | null; branch?: string | null }> | null;
  /** Visits over the pattern days. */
  visits: Array<{ projectId: string | null; previousProjectId: string | null; timestamp: Date }>;
  /** Live agent sessions. */
  live: Array<{ projectId: string; workstream: string; connected: boolean; status: string; updatedAt: string | null }>;
}

const where = (names: ReadonlyMap<string, string>, projectId: string, workstream: string) => {
  const name = names.get(projectId) ?? 'a project';
  return workstream && workstream !== 'main' ? `${name} · ${workstream}` : name;
};
const k = (n: number) => `${Math.round(n / 1000)}k`;
const list = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

export function findPatterns(input: PatternInput): LedgerPattern[] {
  const out: Array<LedgerPattern & { weight: number }> = [];
  const now = input.now.getTime();

  // Agents left waiting: each hour of it is an hour the agent did nothing.
  const waiting = input.live.filter(r => r.connected && r.status === 'waiting' && r.updatedAt && now - Date.parse(r.updatedAt) > WAITING_LONG_MS);
  if (waiting.length) {
    const names = waiting.map(r => where(input.projectNames, r.projectId, r.workstream));
    const one = waiting.length === 1 ? waiting[0] : null;
    out.push({
      id: 'waiting-long', kind: 'waiting-long', weight: 100 + waiting.length,
      finding: `${waiting.length} agent${waiting.length === 1 ? ' has' : 's have'} been waiting on you for over ${WAITING_LONG_MS / 3_600_000} hours: ${list(names)}.`,
      projectId: one?.projectId ?? null, workstream: one?.workstream ?? null,
    });
  }

  // Very large contexts, biggest first.
  const big = input.contextPeaks
    .filter(c => (c.maxTokens ?? 0) >= BIG_CONTEXT_TOKENS && input.projectNames.has(c.projectId))
    .sort((a, b) => (b.maxTokens ?? 0) - (a.maxTokens ?? 0));
  for (const c of big.slice(0, 3)) {
    out.push({
      id: `big-context:${c.projectId}:${c.workstream || 'main'}`, kind: 'big-context', weight: 60 + (c.maxTokens ?? 0) / 100_000,
      finding: `${where(input.projectNames, c.projectId, c.workstream)} peaked at ${k(c.maxTokens ?? 0)} tokens of context in the last ${PATTERN_DAYS} days.`,
      projectId: c.projectId, workstream: c.workstream || 'main',
    });
  }

  if (input.prs) {
    const undeployed = input.prs.filter(p => p.lane === 'merged_not_deployed');
    if (undeployed.length) {
      out.push({
        id: 'undeployed-merges', kind: 'undeployed-merges', weight: 50 + undeployed.length,
        finding: `${undeployed.length} merged PR${undeployed.length === 1 ? ' is' : 's are'} not deployed yet: ${list(undeployed.map(p => `${p.repo ?? ''}#${p.number ?? '?'}`))}.`,
        projectId: null, workstream: null,
      });
    }
    const noPr = input.prs.filter(p => p.lane === 'needs_pr');
    if (noPr.length >= 2) {
      out.push({
        id: 'branches-without-pr', kind: 'branches-without-pr', weight: 40 + noPr.length,
        finding: `${noPr.length} branches have pushed work and no PR${noPr.some(p => p.branch) ? `: ${list(noPr.map(p => p.branch ?? '?'))}` : ''}.`,
        projectId: null, workstream: null,
      });
    }
  }

  // Switching: average over the days that had any visit.
  const perDay = new Map<string, number>();
  for (const v of input.visits) {
    const day = v.timestamp.toISOString().slice(0, 10);
    if (!perDay.has(day)) perDay.set(day, 0);
    if (v.previousProjectId && v.previousProjectId !== v.projectId) perDay.set(day, perDay.get(day)! + 1);
  }
  if (perDay.size >= 2) {
    const total = [...perDay.values()].reduce((a, b) => a + b, 0);
    const avg = total / perDay.size;
    if (avg > MANY_SWITCHES_PER_DAY) {
      const [peakDay, peak] = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
      out.push({
        id: 'many-switches', kind: 'many-switches', weight: 30 + avg / 10,
        finding: `You switched projects about ${Math.round(avg)} times a day over ${perDay.size} active days (most: ${peak} on ${peakDay}).`,
        projectId: null, workstream: null,
      });
    }
  }

  const stale = input.workstreams.filter(w => w.name !== 'main' && now - w.lastActiveAt.getTime() > STALE_WORKSTREAM_MS);
  if (stale.length >= 3) {
    out.push({
      id: 'stale-workstreams', kind: 'stale-workstreams', weight: 20 + stale.length,
      finding: `${stale.length} workstreams have not been touched in over a week and are not archived: ${list(stale.map(w => where(input.projectNames, w.projectId, w.name)))}.`,
      projectId: null, workstream: null,
    });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, MAX_PATTERNS).map(({ weight: _w, ...p }) => p);
}
