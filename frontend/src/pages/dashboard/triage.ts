/**
 * Pure triage: turn the live session rows + today's numbers into the ordered
 * list the Attention section shows. No fetching, no React — see triage.test.ts.
 *
 * Rows considered: the caller's OWN projects, `agent` role only (ctrl/data panes
 * don't carry an agent's state). Rows on a host whose agent is offline are
 * skipped by every per-row rule: their `alive`/status are unreliable there.
 */
import type { PrPipelineResponse, SessionRow, UsageResponse, WorktimeProjectRow } from '../../services/api';
import type { CloudSession, Project } from '../../types';
import { cloudTitle } from '../../utils/cloudSessions';
import { dayTokens, fmtAge, fmtDurationShort, fmtK } from '../../utils/format';
import { median } from '../../utils/dates';
import { HUMAN } from '../../utils/worktime';
import { dominantProjectToday } from './usageProjects';
import { promptContextTokens, shouldShowPrPrompt } from '../../utils/prPrompt';
import { rateLimitDetail, rateLimitLabel } from '../../utils/rateLimit';
import { deferrals, lanesOf, rowLabel, prsSearch, rowParam } from '../../utils/prPipeline';
import {
  CONTEXT_WARN_TOKENS, CONTEXT_DANGER_TOKENS,
  WAITING_WARN_MS, WAITING_CRIT_MS,
  IDLE_NOTICE_MS, IDLE_WARN_MS,
  TOKEN_BURN_WARN_RATIO, TOKEN_BURN_CRIT_RATIO, TOKEN_BURN_MIN_TOKENS, MIN_DAYS_FOR_MEDIAN,
  EFFORT_NOTICE_MS, EFFORT_WARN_MS,
} from '../../utils/thresholds';

export type Severity = 'critical' | 'warning' | 'notice';
export type AttentionKind =
  | 'agent_offline' | 'rate_limited' | 'context' | 'pr_prompt' | 'waiting' | 'idle'
  | 'token_burn' | 'usage_unavailable' | 'effort' | 'cloud_queued'
  | 'pr_needs_my_review' | 'pr_ready_to_merge' | 'pr_checks_failed';

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
  /** An external link (a pull request on GitHub); wins over the project link. */
  href?: string;
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
  /** The owner's active Claude Code cloud sessions; optional, older callers pass nothing. */
  cloudSessions?: CloudSession[] | null;
  /** The PR pipeline (GET /api/prs); optional, older callers pass nothing. */
  prs?: PrPipelineResponse | null;
}

/** A review request this old turns from a notice into a warning. */
export const PR_REVIEW_WARN_MS = 24 * 3_600_000;
/** More PR items of one kind than this become one summary item. */
export const PR_ITEMS_PER_KIND = 2;
/** The dashboard's Pull requests section, which a summary item scrolls to. */
/** The PR overlay on its Needs you view (components/PrsOverlay.tsx); a PR item adds `pr`. */
export const PRS_OVERLAY = prsSearch('', 'needs_you');

/** A cloud session queued this long is worth a look; this long, worth worrying about. */
export const CLOUD_QUEUED_WARN_MS = 5 * 60_000;
export const CLOUD_QUEUED_CRIT_MS = 15 * 60_000;

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
      title: `${rateLimitLabel(r.rateLimited)}: ${r.rateLimited}`, detail: rateLimitDetail(r.rateLimited, r.provider ?? 'agent'),
      action: rateLimitLabel(r.rateLimited) === 'RATE LIMITED' ? 'wait or switch provider' : 'check the pane', metric: 0,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 2b. "PR opened — compact or clear?" prompts awaiting a decision. Same gate
  // as the in-pane card and the tile dot (shouldShowPrPrompt) so the three
  // agree. A session with one of these skips the generic context-pressure item
  // below: the prompt already says what to do, and more specifically.
  // Keyed by host + session: the same tmux name can exist on two boxes.
  const prPromptSessions = new Set<string>();
  for (const r of live) {
    if (!shouldShowPrPrompt({ status: r.status, milestone: r.milestone, contextTokens: r.contextTokens, now })) continue;
    prPromptSessions.add(`${hostKey(r)}:${r.session}`);
    const t = promptContextTokens(r.milestone, r.contextTokens) ?? 0;
    items.push({
      id: `pr:${hostKey(r)}:${r.session}`, kind: 'pr_prompt', severity: 'notice',
      title: `${r.milestone!.kind === 'pr_merged' ? 'PR merged' : 'PR opened'} with ${fmtK(t)} tokens of context`,
      detail: `${fmtAge(now - Date.parse(r.milestone!.at))} ago. A natural point to shrink the conversation before the next task.`,
      action: 'compact or clear', metric: t,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 3. Context pressure
  for (const r of live) {
    if (prPromptSessions.has(`${hostKey(r)}:${r.session}`)) continue;
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
      title: `Live session ready for ${fmtAge(age)}`,
      detail: 'tmux is up but nothing has happened here in a while.',
      action: 'resume or stop it', metric: age,
      projectId: r.projectId, projectName: r.projectName, workstream: r.workstream, projectColor: colorOf(r),
    });
  }

  // 5b. Cloud sessions the orchestrator could not place: no box, every slot
  // full, GitHub not connected. The reason is what the Activity tab shows.
  for (const s of input.cloudSessions ?? []) {
    if (s.state !== 'queued') continue;
    // Time queued, not time since the latest re-offer: the orchestrator retries
    // every few minutes and each retry is an event.
    const age = now - Date.parse(s.queuedSince ?? s.lastSeenAt);
    if (!Number.isFinite(age) || age < CLOUD_QUEUED_WARN_MS) continue;
    items.push({
      id: `cloudq:${s.key}`, kind: 'cloud_queued', severity: age >= CLOUD_QUEUED_CRIT_MS ? 'critical' : 'warning',
      title: `Cloud session "${cloudTitle(s)}" queued ${fmtAge(age)}`,
      detail: s.queuedReason ?? 'The orchestrator has not found a box for it.',
      action: 'start or add a box', metric: age,
    });
  }

  // 5c. Pull requests: a review asked of me, mine ready to merge, mine with
  // red checks. Red non-required checks count on purpose:
  // the author ignores the suggestion or takes it, explicitly. More than
  // PR_ITEMS_PER_KIND of one kind collapse into one item opening the PR
  // overlay, each PR item opens it on that PR, and PR items rank below session items of the same
  // severity (metric 0): a stale review request is not more urgent than an
  // agent waiting on you. A PR the user deferred raises nothing until it is back.
  const deferredPrs = deferrals(input.prs, now);
  const prItems = new Map<AttentionKind, AttentionItem[]>();
  const addPr = (it: AttentionItem) => prItems.set(it.kind, [...(prItems.get(it.kind) ?? []), it]);
  for (const lane of lanesOf(input.prs)) {
    for (const r of lane.rows) {
      if (r.kind !== 'pr' || !r.url || deferredPrs.has(rowParam(r))) continue;
      const where = r.workstream ? { projectName: r.workstream.projectName, workstream: r.workstream.workstream } : {};
      const age = now - Date.parse(r.requestedAt ?? r.at ?? '');
      const ageMs = Number.isFinite(age) ? age : 0;
      // A request only to a team you are on (team_review) is in the PR overlay, not here (2026-10-22).
      if (lane.id === 'needs_my_review') {
        addPr({
          id: `prrev:${r.repo}#${r.number}`, kind: 'pr_needs_my_review', severity: ageMs >= PR_REVIEW_WARN_MS ? 'warning' : 'notice',
          title: `Review requested on ${rowLabel(r)}: ${r.title}`,
          detail: `By ${r.author ?? 'someone'}${r.requestedAt ? `, asked ${fmtAge(ageMs)} ago` : ''}.`,
          action: 'review it', href: prsSearch('', 'needs_you', rowParam(r)), metric: 0, ...where,
        });
      } else if (lane.id === 'ready_to_merge') {
        addPr({
          id: `prready:${r.repo}#${r.number}`, kind: 'pr_ready_to_merge', severity: 'notice',
          title: `${rowLabel(r)} is approved and green`,
          detail: r.blockedBy ? `${r.title} · but ${r.blockedBy}.` : r.title,
          action: 'merge it', href: prsSearch('', 'needs_you', rowParam(r)), metric: 0, ...where,
        });
      } else if (lane.id === 'checks' && r.failingChecks.length && !r.badges.includes('draft')) {
        addPr({
          id: `prfail:${r.repo}#${r.number}`, kind: 'pr_checks_failed', severity: 'warning',
          title: `Checks failing on ${rowLabel(r)}: ${r.failingChecks.join(', ')}`,
          detail: r.title,
          action: 'fix or dismiss', href: prsSearch('', 'needs_you', rowParam(r)), metric: 0, ...where,
        });
      }
    }
  }
  const PR_SUMMARY: Partial<Record<AttentionKind, (n: number) => string>> = {
    pr_needs_my_review: n => `${n} pull requests are waiting on your review`,
    pr_ready_to_merge: n => `${n} of your pull requests are ready to merge`,
    pr_checks_failed: n => `${n} of your pull requests have failing checks`,
  };
  for (const [kind, list] of prItems) {
    if (list.length <= PR_ITEMS_PER_KIND) { items.push(...list); continue; }
    const severity = list.some(i => i.severity === 'warning') ? 'warning' : 'notice';
    items.push({
      id: `prs:${kind}`, kind, severity,
      title: PR_SUMMARY[kind]!(list.length),
      detail: list.slice(0, 3).map(i => i.id.split(':')[1].replace(/^[^/]+\//, '')).join(', ') + (list.length > 3 ? ', …' : ''),
      action: 'see pull requests', href: PRS_OVERLAY, metric: 0,
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
          title: `${fmtK(today)} tokens today, ${ratio === Infinity ? '∞' : ratio.toFixed(1)}× your typical day`,
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
        title: `Token data is stale (last scan ${fmtAge(now - Date.parse(input.usage.staleSince))} ago)`,
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
        detail: 'A lot of autonomous time on one project. Worth a look at what it produced.',
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
