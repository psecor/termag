/**
 * Pure triage: turn the live session rows + today's numbers into the ordered
 * list the Attention section shows. No fetching, no React — see triage.test.ts.
 *
 * Rows considered: the caller's OWN projects, `agent` role only (ctrl/data panes
 * don't carry an agent's state). Rows on a host whose agent is offline are
 * skipped by every per-row rule: their `alive`/status are unreliable there.
 */
import type { SessionRow, UsageResponse, WorktimeProjectRow } from '../../services/api';
import type { Project } from '../../types';
import { dayTokens, fmtAge, fmtDurationShort, fmtK } from '../../utils/format';
import { median } from '../../utils/dates';
import { HUMAN } from '../../utils/worktime';
import { dominantProjectToday } from './usageProjects';
import {
  CONTEXT_WARN_TOKENS, CONTEXT_DANGER_TOKENS,
  WAITING_WARN_MS, WAITING_CRIT_MS,
  IDLE_NOTICE_MS, IDLE_WARN_MS,
  TOKEN_BURN_WARN_RATIO, TOKEN_BURN_CRIT_RATIO, TOKEN_BURN_MIN_TOKENS, MIN_DAYS_FOR_MEDIAN,
  EFFORT_NOTICE_MS, EFFORT_WARN_MS,
} from '../../utils/thresholds';

export type Severity = 'critical' | 'warning' | 'notice';
export type AttentionKind =
  | 'agent_offline' | 'rate_limited' | 'context' | 'waiting' | 'idle'
  | 'token_burn' | 'usage_unavailable' | 'effort';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: Severity;
  title: string;
  detail: string;
  action: string;
  projectId?: string;
  projectName?: string;
  workstream?: string;
  projectColor?: string | null;
  /** Sort key within a severity (bigger = higher). */
  metric: number;
}

export interface TriageInput {
  sessions: SessionRow[] | null;
  projects: Project[] | null;
  usage: UsageResponse | null;
  usageUnavailable: boolean;
  worktimeByProject: WorktimeProjectRow[] | null;
  /** Date keys that count as "today" for worktime rows (local + UTC). */
  todayKeys: string[];
  /** UTC key for today's tokens, and the trailing UTC days that form the baseline. */
  todayUTC: string;
  baselineUTC: string[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, notice: 2 };

export function ownAgentRows(sessions: SessionRow[] | null): SessionRow[] {
  return (sessions ?? []).filter(r => r.access === 'owner' && r.role === 'agent');
}

function hostKey(r: SessionRow): string { return r.instanceId ?? 'legacy'; }

export function buildAttentionItems(input: TriageInput, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  const rows = ownAgentRows(input.sessions);
  const projectById = new Map((input.projects ?? []).map(p => [p.id, p]));
  const colorOf = (r: SessionRow) => projectById.get(r.projectId)?.color ?? null;

  // 1. Offline agents — one item per host; per-row rules skip that host.
  const offline = new Set<string>();
  for (const r of rows) {
    if (r.connected) continue;
    const key = hostKey(r);
    if (offline.has(key)) continue;
    offline.add(key);
    items.push({
      id: `offline:${key}`, kind: 'agent_offline', severity: 'warning',
      title: r.instanceId ? 'Box agent offline' : 'Agent on the orchestrator is offline',
      detail: r.instanceId
        ? `${r.projectName} and any other project on this box report no live status.`
        : 'Live status, token scans and terminals for host-local projects are unavailable.',
      action: 'check the agent', metric: 0,
    });
  }
  const live = rows.filter(r => !offline.has(hostKey(r)));

  // 2. Rate limited
  for (const r of live) {
    if (!r.rateLimited) continue;
    items.push({
      id: `rate:${r.session}`, kind: 'rate_limited', severity: 'warning',
      title: `Rate limited — ${r.rateLimited}`, detail: `${r.provider ?? 'agent'} is throttled in this pane.`,
      action: 'wait or switch provider', metric: 0,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 3. Context pressure
  for (const r of live) {
    const t = r.contextTokens;
    if (t == null || t < CONTEXT_WARN_TOKENS) continue;
    const critical = t >= CONTEXT_DANGER_TOKENS;
    items.push({
      id: `ctx:${r.session}`, kind: 'context', severity: critical ? 'critical' : 'warning',
      title: `Context at ${fmtK(t)} tokens`,
      detail: critical ? 'Well past the point where the conversation should be reset.' : 'Getting heavy; responses slow and cost more from here.',
      action: 'consider /clear or /compact', metric: t,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 4. Waiting on the user. updatedAt is a last-WRITE stamp, so the age is a lower bound.
  for (const r of live) {
    if (r.status !== 'waiting' || !r.updatedAt) continue;
    const age = now - Date.parse(r.updatedAt);
    if (age < WAITING_WARN_MS) continue;
    const reason = r.waitingReason === 'approval' ? 'approval' : r.waitingReason === 'user_input' ? 'your input' : 'you';
    items.push({
      id: `wait:${r.session}`, kind: 'waiting', severity: age >= WAITING_CRIT_MS ? 'critical' : 'warning',
      title: `Waiting on ${reason} ≥ ${fmtAge(age)}`,
      detail: 'The agent has been blocked at least this long.',
      action: 'open and answer', metric: age,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 5. Live but idle for a long time — one per project (lastActiveAt is per project).
  const idleSeen = new Set<string>();
  for (const r of live) {
    if (!r.alive || (r.status !== 'idle' && r.status !== 'not_running')) continue;
    if (projectById.get(r.projectId)?.kind === 'metaterm') continue;
    if (idleSeen.has(r.projectId)) continue;
    const age = now - Date.parse(r.lastActiveAt);
    if (!Number.isFinite(age) || age < IDLE_NOTICE_MS) continue;
    idleSeen.add(r.projectId);
    items.push({
      id: `idle:${r.projectId}`, kind: 'idle', severity: age >= IDLE_WARN_MS ? 'warning' : 'notice',
      title: `Live session idle for ${fmtAge(age)}`,
      detail: 'tmux is up but nothing has happened here in a while.',
      action: 'resume or stop it', metric: age,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 6. Token burn today vs typical day. Detection is user-wide (the total is
  // what the thermometer trained you on); when one project owns most of today's
  // attributed tokens the item deep-links to it.
  if (input.usage) {
    const days = input.usage.days;
    const today = dayTokens(days[input.todayUTC] ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 });
    const baseline = input.baselineUTC
      .map(d => days[d]).filter((d): d is NonNullable<typeof d> => !!d && d.calls > 0).map(dayTokens);
    if (baseline.length >= MIN_DAYS_FOR_MEDIAN && today >= TOKEN_BURN_MIN_TOKENS) {
      const base = median(baseline);
      const ratio = base > 0 ? today / base : Infinity;
      if (ratio >= TOKEN_BURN_WARN_RATIO) {
        const dom = dominantProjectToday(input.usage, input.todayUTC);
        items.push({
          id: 'tokens:today', kind: 'token_burn', severity: ratio >= TOKEN_BURN_CRIT_RATIO ? 'critical' : 'warning',
          title: `${fmtK(today)} tokens today — ${ratio === Infinity ? '∞' : ratio.toFixed(1)}× your typical day`,
          detail: `Typical active day: ${fmtK(base)} (median of the last ${baseline.length} active days).`
            + (dom ? ` ${Math.round(dom.share * 100)}% of today's attributed tokens are on ${dom.name}.` : ''),
          action: dom ? 'open the project' : 'see which pane is burning', metric: today,
          ...(dom ? { projectId: dom.projectId, projectName: dom.name, projectColor: dom.color } : {}),
        });
      }
    }
    if (input.usage.staleSince && !offline.has('legacy')) {
      items.push({
        id: 'tokens:stale', kind: 'usage_unavailable', severity: 'notice',
        title: `Token data is stale — last scan ${fmtAge(now - Date.parse(input.usage.staleSince))} ago`,
        detail: 'No connected agent has reported usage recently; totals are last-known.',
        action: 'check the agents', metric: 0,
      });
    }
  } else if (input.usageUnavailable && !offline.has('legacy')) {
    items.push({
      id: 'tokens:unavailable', kind: 'usage_unavailable', severity: 'notice',
      title: 'Token data unavailable', detail: 'No agent is connected and nothing has been recorded yet.',
      action: 'check the agent', metric: 0,
    });
  }

  // 7. Effort: agent working time on one project today.
  if (input.worktimeByProject) {
    const perProject = new Map<string, { ms: number; name: string; id: string | null; ws: string }>();
    for (const w of input.worktimeByProject) {
      if (w.provider === HUMAN || !input.todayKeys.includes(w.date)) continue;
      const key = w.projectId ?? `name:${w.projectName}`;
      const cur = perProject.get(key) ?? { ms: 0, name: w.projectName, id: w.projectId, ws: w.workstream };
      cur.ms += w.totalMs;
      perProject.set(key, cur);
    }
    for (const [key, v] of perProject) {
      if (v.ms < EFFORT_NOTICE_MS) continue;
      items.push({
        id: `effort:${key}`, kind: 'effort', severity: v.ms >= EFFORT_WARN_MS ? 'warning' : 'notice',
        title: `Agents ran ${fmtDurationShort(v.ms)} on ${v.name} today`,
        detail: 'A lot of autonomous time on one project — worth a look at what it produced.',
        action: 'check what it did', metric: v.ms,
        projectId: v.id ?? undefined, projectName: v.name,
        projectColor: v.id ? projectById.get(v.id)?.color ?? null : null,
      });
    }
  }

  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.metric - a.metric);
  return items;
}

export interface LiveSummary { working: number; waiting: number; idle: number; notRunning: number; offlineHosts: number }

/** Counts for the empty state, over own agent rows on connected hosts. */
export function liveSummary(sessions: SessionRow[] | null): LiveSummary {
  const rows = ownAgentRows(sessions);
  const offline = new Set(rows.filter(r => !r.connected).map(hostKey));
  const s: LiveSummary = { working: 0, waiting: 0, idle: 0, notRunning: 0, offlineHosts: offline.size };
  for (const r of rows) {
    if (offline.has(hostKey(r))) continue;
    if (r.status === 'working') s.working++;
    else if (r.status === 'waiting') s.waiting++;
    else if (r.status === 'idle') s.idle++;
    else s.notRunning++;
  }
  return s;
}
