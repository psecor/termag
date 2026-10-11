/**
 * Org-wide behaviour signals.
 * Pure: every input is a plain array the route/MCP layer has already loaded,
 * so the thresholds and ranking are unit-tested without a DB. Thresholds
 * mirror frontend/src/utils/thresholds.ts where a personal equivalent exists.
 */
import type { SessionRow } from '../sessionInventory';
import type { Capacity, CloudSignalSession } from './claudeRunnerQueries';

export const THRESHOLDS = {
  idleBoxDays: 7,
  disconnectedBoxHours: 24,
  provisioningStuckMinutes: 15,
  waitingWarnMs: 30 * 60_000,
  waitingCritMs: 2 * 3_600_000,
  contextDangerTokens: 1_000_000,
  tokenBurnWarnRatio: 2,
  tokenBurnCritRatio: 3,
  tokenBurnMinTokens: 1_000_000,
  minDaysForMedian: 3,
  cacheRatioLow: 0.3,
  cacheRatioMinTokens: 1_000_000,
  staleProjectDays: 30,
  // Claude Code cloud sessions.
  cloudQueuedWarnMs: 5 * 60_000,
  cloudQueuedCritMs: 15 * 60_000,
  cloudLostWindowMs: 24 * 3_600_000,
  /** The orchestrator polls every few seconds; the Cloud tab warns at two minutes, this fires later on purpose. */
  orchestratorPollStaleMs: 5 * 60_000,
  /** A box whose runs never posted `started` is judged only once a run is this old (the hook may still be coming). */
  cloudStaleBoxMinRunAgeMs: 10 * 60_000,
  // Host pressure (S5): a 12 GB Bazel output base per cloud checkout fills a root volume fast.
  diskWarnPct: 85,
  diskCritPct: 95,
  memWarnPct: 90,
  /** A sample older than this says the agent stopped answering, not that the box is fine. */
  hostSampleStaleMs: 30 * 60_000,
  /** A failed update run is worth a look this long; a restart deferred this long is stuck, not waiting. */
  boxUpdateFailedWindowMs: 7 * 24 * 3_600_000,
  boxUpdateDeferredMs: 24 * 3_600_000,
} as const;

export type Severity = 'critical' | 'warning' | 'notice' | 'good';
export type SignalKind =
  | 'box_idle' | 'box_disconnected' | 'box_stuck' | 'box_failed'
  | 'agent_waiting' | 'agent_rate_limited' | 'agent_context'
  | 'token_burn' | 'cache_ratio_low' | 'cache_ratio_high'
  | 'project_stale' | 'worktime_unattributed'
  | 'cloud_queued' | 'cloud_waiting' | 'cloud_lost' | 'cloud_boxes_full' | 'cloud_stale_box' | 'orchestrator_down'
  | 'box_pressure' | 'cloud_kept_checkout'
  | 'box_update_failed' | 'box_update_deferred';

export interface Signal {
  id: string;
  kind: SignalKind;
  severity: Severity;
  title: string;
  detail: string;
  /** Who / what it is about, for drill-down links. */
  userId?: string;
  unixUsername?: string;
  instanceId?: string;
  projectId?: string;
  /** Sort key within a severity (bigger first). */
  metric: number;
  /** When the condition started, when known. */
  since?: string;
}

export interface SignalInstance {
  id: string; name: string; status: string; kind: string; createdAt: Date; connected: boolean;
  userId: string; unixUsername: string; projectCount: number; lastProjectActiveAt: Date | null;
  provisioningError: string | null;
  /** The newest cloud run start or end on the box; a box used only for cloud sessions is not idle. */
  lastCloudRunAt?: Date | null;
  /** Disk, memory, load and kept checkouts from the agent (S5); absent from a caller or an agent that does not sample. */
  host?: { diskUsedPct: number | null; memUsedPct: number | null; load1: number | null; keptCheckouts: number | null; sampledAt: Date } | null;
  /** The last termag-box-update run the box reported; absent before any. */
  update?: { at: Date; outcome: string; detail: string | null; commit?: string | null } | null;
  /** The commit the connected agent runs (its hello); a deferred restart is over once it is the pulled one. */
  agentCommit?: string | null;
}

/** The runner orchestrator as the signals judge it (services/admin/claudeRunnerQueries.ts, orchestratorHealth). */
export interface SignalOrchestrator {
  /** A health port is configured on this host: without one there is nothing to judge. */
  configured: boolean;
  available: boolean;
  connected: boolean;
  lastPollAt: Date | null;
  reason: string | null;
}

export interface SignalCloud {
  sessions: CloudSignalSession[];
  capacity: Capacity;
}
export interface SignalProject {
  id: string; name: string; userId: string; unixUsername: string; archived: boolean; lastActiveAt: Date; kind: string;
}
export interface UserTokenDays { userId: string; unixUsername: string; days: Record<string, { tokens: number; input: number; cacheRead: number }> }

export interface SignalsInput {
  instances: SignalInstance[];
  projects: SignalProject[];
  sessions: SessionRow[];
  /** Per user, per UTC day: total tokens and the two cache-ratio inputs, trailing 15 days incl. today. */
  userTokens: UserTokenDays[];
  todayKey: string;
  baselineKeys: string[];
  /** work_time_entries.username values with no matching users.unixUsername. */
  unknownWorktimeUsernames: string[];
  /** Claude Code cloud sessions and capacity; absent on a caller that has not loaded them. */
  cloud?: SignalCloud;
  orchestrator?: SignalOrchestrator;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, notice: 2, good: 3 };

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmtDur = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const fmtDays = (ms: number): string => `${Math.floor(ms / 86_400_000)}d`;
const fmtM = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

export function buildSignals(input: SignalsInput, now: number): Signal[] {
  const out: Signal[] = [];
  const T = THRESHOLDS;

  for (const b of input.instances) {
    if (b.status === 'terminated') continue;
    const age = now - b.createdAt.getTime();
    if (b.status === 'failed') {
      out.push({ id: `box_failed:${b.id}`, kind: 'box_failed', severity: 'warning', title: `Box ${b.name} failed to provision`,
        detail: b.provisioningError ?? 'no error recorded', userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: age, since: b.createdAt.toISOString() });
      continue;
    }
    if ((b.status === 'provisioning' || b.status === 'awaiting-agent') && age > T.provisioningStuckMinutes * 60_000) {
      out.push({ id: `box_stuck:${b.id}`, kind: 'box_stuck', severity: b.status === 'provisioning' ? 'warning' : 'notice',
        title: `Box ${b.name} ${b.status} for ${fmtDur(age)}`,
        detail: b.status === 'provisioning' ? 'EC2 launched but the agent never dialed in' : 'external box waiting for its agent',
        userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: age, since: b.createdAt.toISOString() });
      continue;
    }
    if (b.status !== 'ready') continue;
    // The last update run the box reported: a failure is a box that will keep
    // answering "agent too old"; a restart deferred for a day is stuck behind
    // a cloud session or a unit without KillMode=process, not waiting.
    if (b.update) {
      const age = now - b.update.at.getTime();
      if (b.update.outcome === 'failed' && age <= T.boxUpdateFailedWindowMs) {
        out.push({ id: `box_update_failed:${b.id}`, kind: 'box_update_failed', severity: 'warning', title: `Box ${b.name} failed to update ${fmtDur(age)} ago`,
          detail: `${b.unixUsername}: ${b.update.detail ?? 'no detail'} — the box stays on its old agent until a run succeeds`,
          userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: age, since: b.update.at.toISOString() });
      } else if (b.update.outcome === 'deferred' && age >= T.boxUpdateDeferredMs
        // A reboot restarts the agent without a new report, so the row keeps saying
        // "deferred" after the pulled commit is running: judge the live agent first.
        && !(b.connected && b.agentCommit && b.update.commit && b.agentCommit === b.update.commit)) {
        out.push({ id: `box_update_deferred:${b.id}`, kind: 'box_update_deferred', severity: 'notice', title: `Box ${b.name} has a restart pending for ${fmtDays(age)}`,
          detail: `${b.unixUsername}: ${b.update.detail ?? 'no detail'} — the pulled code is not running yet`,
          userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: age, since: b.update.at.toISOString() });
      }
    }
    // Host pressure (S5): fires beside idle or offline, since a full disk is a
    // different fault from an unused box, and only on a fresh sample.
    if (b.host && now - b.host.sampledAt.getTime() <= T.hostSampleStaleMs) {
      // Kept checkouts are what is under ~/ccr/kept NOW (the sample), not a
      // run's historical flag: a rescued or deleted checkout stops the notice.
      if (b.host.keptCheckouts) {
        out.push({ id: `cloud_kept_checkout:${b.id}`, kind: 'cloud_kept_checkout', severity: 'notice',
          title: `${b.host.keptCheckouts} cloud checkout${b.host.keptCheckouts === 1 ? '' : 's'} kept on ${b.name}`,
          detail: `${b.unixUsername}: the runner could not push the outcome branch, so a checkout with unpushed work sits under ~/ccr/kept; the sweep removes it after seven days, so rescue it or confirm GitHub has it`,
          userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: b.host.keptCheckouts, since: b.host.sampledAt.toISOString() });
      }
      const disk = b.host.diskUsedPct ?? 0, mem = b.host.memUsedPct ?? 0;
      if (disk >= T.diskWarnPct || mem >= T.memWarnPct) {
        const parts = [disk >= T.diskWarnPct ? `disk ${disk}% full` : '', mem >= T.memWarnPct ? `memory ${mem}% used` : ''].filter(Boolean).join(', ');
        out.push({ id: `box_pressure:${b.id}`, kind: 'box_pressure', severity: disk >= T.diskCritPct ? 'critical' : 'warning',
          title: `Box ${b.name} under pressure: ${parts}`,
          detail: `${b.unixUsername}: load ${b.host.load1 ?? '?'}${b.host.keptCheckouts ? ` · ${b.host.keptCheckouts} kept cloud checkout${b.host.keptCheckouts === 1 ? '' : 's'} under ~/ccr/kept` : ''} — cloud session checkouts and their Bazel output bases are the usual weight`,
          userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: Math.max(disk, mem), since: b.host.sampledAt.toISOString() });
      }
    }
    // The later of project and cloud activity: a box serving cloud sessions
    // bumps no project's lastActiveAt, and was flagged idle for it.
    const lastActive = Math.max(b.lastProjectActiveAt?.getTime() ?? 0, b.lastCloudRunAt?.getTime() ?? 0) || b.createdAt.getTime();
    const idleMs = now - lastActive;
    if (idleMs > T.idleBoxDays * 86_400_000) {
      // Idle is about cost, so it fires whether or not the agent is up: an EC2
      // box keeps billing with its agent down. The offline note rides along
      // instead of a second signal for the same box.
      out.push({ id: `box_idle:${b.id}`, kind: 'box_idle', severity: 'warning', title: `Box ${b.name} idle for ${fmtDays(idleMs)}`,
        detail: `${b.unixUsername}: ${b.projectCount} project${b.projectCount === 1 ? '' : 's'}, no agent activity since ${new Date(lastActive).toISOString().slice(0, 10)}${b.connected ? '' : ', agent offline'} — running cost with nothing on it`,
        userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: idleMs, since: new Date(lastActive).toISOString() });
      continue;
    }
    if (!b.connected && b.projectCount > 0) {
      // No disconnect timestamp exists yet (phase 1); use project inactivity as the lower bound.
      const sev: Severity = idleMs > T.disconnectedBoxHours * 3_600_000 ? 'warning' : 'notice';
      out.push({ id: `box_disconnected:${b.id}`, kind: 'box_disconnected', severity: sev, title: `Box ${b.name} agent offline`,
        detail: `${b.unixUsername}: ${b.projectCount} active project${b.projectCount === 1 ? '' : 's'} unreachable; last agent activity ${fmtDur(idleMs)} ago`,
        userId: b.userId, unixUsername: b.unixUsername, instanceId: b.id, metric: idleMs });
    }
  }

  for (const s of input.sessions) {
    if (s.role !== 'agent' || !s.connected) continue;
    const updated = s.updatedAt ? new Date(s.updatedAt).getTime() : null;
    if (s.status === 'waiting' && updated) {
      const waitMs = now - updated;
      if (waitMs >= T.waitingWarnMs) {
        out.push({ id: `agent_waiting:${s.session}`, kind: 'agent_waiting', severity: waitMs >= T.waitingCritMs ? 'critical' : 'warning',
          title: `${s.owner}/${s.projectName} waiting ${fmtDur(waitMs)}`,
          detail: `agent needs ${s.waitingReason ?? 'input'} and nobody has answered (${s.provider ?? 'unknown provider'})`,
          userId: s.ownerUserId, unixUsername: s.owner, projectId: s.projectId, instanceId: s.instanceId ?? undefined, metric: waitMs, since: s.updatedAt ?? undefined });
      }
    }
    if (s.rateLimited) {
      out.push({ id: `agent_rate_limited:${s.session}`, kind: 'agent_rate_limited', severity: 'warning',
        title: `${s.owner}/${s.projectName} rate limited`, detail: s.rateLimited,
        userId: s.ownerUserId, unixUsername: s.owner, projectId: s.projectId, instanceId: s.instanceId ?? undefined, metric: updated ? now - updated : 0, since: s.updatedAt ?? undefined });
    }
    if (s.contextTokens != null && s.contextTokens >= T.contextDangerTokens && s.status !== 'not_running') {
      out.push({ id: `agent_context:${s.session}`, kind: 'agent_context', severity: 'warning',
        title: `${s.owner}/${s.projectName} context at ${fmtM(s.contextTokens)} tokens`, detail: 'above the danger line; the session is close to running out of context',
        userId: s.ownerUserId, unixUsername: s.owner, projectId: s.projectId, instanceId: s.instanceId ?? undefined, metric: s.contextTokens });
    }
  }

  for (const u of input.userTokens) {
    const today = u.days[input.todayKey]?.tokens ?? 0;
    const baseline = input.baselineKeys.map(k => u.days[k]?.tokens ?? 0).filter(n => n > 0);
    if (today >= T.tokenBurnMinTokens && baseline.length >= T.minDaysForMedian) {
      const med = median(baseline);
      const ratio = med > 0 ? today / med : Infinity;
      if (ratio >= T.tokenBurnWarnRatio) {
        out.push({ id: `token_burn:${u.userId}`, kind: 'token_burn', severity: ratio >= T.tokenBurnCritRatio ? 'critical' : 'warning',
          title: `${u.unixUsername} burning ${ratio === Infinity ? '∞' : ratio.toFixed(1)}× their typical day`,
          detail: `${fmtM(today)} tokens today vs a median of ${fmtM(med)} over ${baseline.length} active days`,
          userId: u.userId, unixUsername: u.unixUsername, metric: ratio === Infinity ? 1e9 : ratio });
      }
    }
    let input_ = 0, cacheRead = 0;
    for (const k of [...input.baselineKeys, input.todayKey]) { const d = u.days[k]; if (d) { input_ += d.input; cacheRead += d.cacheRead; } }
    const denom = input_ + cacheRead;
    if (denom >= T.cacheRatioMinTokens) {
      const ratio = cacheRead / denom;
      if (ratio < T.cacheRatioLow) {
        out.push({ id: `cache_ratio_low:${u.userId}`, kind: 'cache_ratio_low', severity: 'notice',
          title: `${u.unixUsername} cache hit ratio ${(ratio * 100).toFixed(0)}%`,
          detail: `${fmtM(cacheRead)} cached of ${fmtM(denom)} input tokens over the trailing ${input.baselineKeys.length + 1} days — prompts are being re-sent uncached`,
          userId: u.userId, unixUsername: u.unixUsername, metric: 1 - ratio });
      } else if (ratio >= 0.8) {
        out.push({ id: `cache_ratio_high:${u.userId}`, kind: 'cache_ratio_high', severity: 'good',
          title: `${u.unixUsername} cache hit ratio ${(ratio * 100).toFixed(0)}%`,
          detail: `${fmtM(cacheRead)} cached of ${fmtM(denom)} input tokens — a pattern worth copying`,
          userId: u.userId, unixUsername: u.unixUsername, metric: ratio });
      }
    }
  }

  const staleCutoff = now - T.staleProjectDays * 86_400_000;
  const staleByUser = new Map<string, { unixUsername: string; projects: SignalProject[] }>();
  for (const p of input.projects) {
    if (p.archived || p.kind !== 'normal' || p.lastActiveAt.getTime() > staleCutoff) continue;
    const e = staleByUser.get(p.userId) ?? { unixUsername: p.unixUsername, projects: [] };
    e.projects.push(p); staleByUser.set(p.userId, e);
  }
  for (const [userId, e] of staleByUser) {
    const oldest = Math.min(...e.projects.map(p => p.lastActiveAt.getTime()));
    out.push({ id: `project_stale:${userId}`, kind: 'project_stale', severity: 'notice',
      title: `${e.unixUsername} has ${e.projects.length} stale project${e.projects.length === 1 ? '' : 's'}`,
      detail: `no agent activity for ${T.staleProjectDays}+ days: ${e.projects.slice(0, 5).map(p => p.name).join(', ')}${e.projects.length > 5 ? ', …' : ''} — tmux sessions and worktrees still occupy the box`,
      userId, unixUsername: e.unixUsername, metric: now - oldest });
  }

  cloudSignals(input, now, out);

  if (input.unknownWorktimeUsernames.length) {
    out.push({ id: 'worktime_unattributed', kind: 'worktime_unattributed', severity: 'notice',
      title: `${input.unknownWorktimeUsernames.length} worktime username${input.unknownWorktimeUsernames.length === 1 ? ' matches' : 's match'} no user`,
      detail: `${input.unknownWorktimeUsernames.slice(0, 5).join(', ')} — usually a hyphenated unix username split wrongly by parseSessionName`,
      metric: input.unknownWorktimeUsernames.length });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.metric - a.metric);
}

/**
 * Claude Code cloud sessions. Inputs
 * are Postgres and the status map only: no box RPC behind a signal.
 */
function cloudSignals(input: SignalsInput, now: number, out: Signal[]): void {
  const T = THRESHOLDS;
  const o = input.orchestrator;
  if (o && o.configured) {
    const pollAge = o.lastPollAt ? now - o.lastPollAt.getTime() : null;
    const stalePoll = pollAge != null && pollAge > T.orchestratorPollStaleMs;
    if (!o.available || !o.connected || stalePoll) {
      const why = !o.available ? (o.reason ?? 'the unit did not answer on its health port')
        : !o.connected ? 'the last poll of Anthropic failed'
        : `the last poll was ${fmtDur(pollAge!)} ago`;
      out.push({ id: 'orchestrator_down', kind: 'orchestrator_down', severity: 'critical', title: 'Claude runner orchestrator is not serving sessions',
        detail: `${why}; every new cloud session queues until it is`, metric: pollAge ?? 1e12, since: o.lastPollAt?.toISOString() });
    }
  }

  const c = input.cloud;
  if (!c) return;
  const ownerBoxes = (userId: string) => c.capacity.owners[userId]?.boxes ?? 'no boxes';
  // One cap signal per owner however many of their sessions queue.
  const ownersAtCap = new Set<string>();

  for (const s of c.sessions) {
    if (s.state === 'queued' && s.queuedSince) {
      const age = now - s.queuedSince.getTime();
      if (age >= T.cloudQueuedWarnMs) {
        out.push({ id: `cloud_queued:${s.key}`, kind: 'cloud_queued', severity: age >= T.cloudQueuedCritMs ? 'critical' : 'warning',
          title: `${s.owner}'s cloud session queued ${fmtDur(age)}`,
          detail: `${s.queuedReason ?? 'no reason recorded'} — boxes: ${ownerBoxes(s.userId)}`,
          userId: s.userId, unixUsername: s.owner, metric: age, since: s.queuedSince.toISOString() });
      }
      if (c.capacity.owners[s.userId]?.atCap && !ownersAtCap.has(s.userId)) {
        ownersAtCap.add(s.userId);
        out.push({ id: `cloud_boxes_full:${s.userId}`, kind: 'cloud_boxes_full', severity: 'notice',
          title: `${s.owner} has every cloud slot in use`,
          detail: `${c.capacity.owners[s.userId].eligibleBoxes} eligible box(es) at ${c.capacity.max} sessions each while a session queues — raise the cap or add a box`,
          userId: s.userId, unixUsername: s.owner, metric: age });
      }
    }
    if (s.state === 'running' && s.live) {
      const live = s.live;
      if (live.status === 'waiting') {
        const waitMs = now - live.updatedAt.getTime();
        if (waitMs >= T.waitingWarnMs) {
          out.push({ id: `cloud_waiting:${s.key}`, kind: 'cloud_waiting', severity: waitMs >= T.waitingCritMs ? 'critical' : 'warning',
            title: `${s.owner}'s cloud session on ${s.boxName ?? '?'} waiting ${fmtDur(waitMs)}`,
            detail: `the session needs ${live.waitingReason ?? 'input'} and nobody has answered on claude.ai`,
            userId: s.userId, unixUsername: s.owner, instanceId: s.instanceId ?? undefined, metric: waitMs, since: live.updatedAt.toISOString() });
        }
      }
      // The same context and rate-limit rules as project panes (the box agent's
      // scanners cover runner sessions since S5), under the same kinds.
      if (live.contextTokens != null && live.contextTokens >= T.contextDangerTokens) {
        out.push({ id: `agent_context:cloud:${s.key}`, kind: 'agent_context', severity: 'warning',
          title: `${s.owner}'s cloud session on ${s.boxName ?? '?'} context at ${fmtM(live.contextTokens)} tokens`,
          detail: 'above the danger line; the session is close to running out of context',
          userId: s.userId, unixUsername: s.owner, instanceId: s.instanceId ?? undefined, metric: live.contextTokens });
      }
      if (live.rateLimited) {
        out.push({ id: `agent_rate_limited:cloud:${s.key}`, kind: 'agent_rate_limited', severity: 'warning',
          title: `${s.owner}'s cloud session on ${s.boxName ?? '?'} rate limited`, detail: live.rateLimited,
          userId: s.userId, unixUsername: s.owner, instanceId: s.instanceId ?? undefined, metric: now - live.updatedAt.getTime(), since: live.updatedAt.toISOString() });
      }
    }
  }

  // Lost runs in the last day, one signal per box: the end report is not
  // arriving from there. Every lost run counts, not only a session's current
  // one: a session resumed under a new order still lost its earlier run.
  const lostByBox = new Map<string, { boxName: string; n: number; newest: Date }>();
  for (const s of c.sessions) {
    for (const r of s.lostRuns) {
      if (now - r.endedAt.getTime() > T.cloudLostWindowMs) continue;
      const e = lostByBox.get(r.instanceId) ?? { boxName: r.boxName, n: 0, newest: r.endedAt };
      e.n++; if (r.endedAt > e.newest) e.newest = r.endedAt;
      lostByBox.set(r.instanceId, e);
    }
  }
  for (const [instanceId, e] of lostByBox) {
    out.push({ id: `cloud_lost:${instanceId}`, kind: 'cloud_lost', severity: 'warning',
      title: `${e.n} cloud run${e.n === 1 ? '' : 's'} lost on ${e.boxName} in the last 24h`,
      detail: 'the runner\'s tmux session vanished without an end report: the box was off, or its wrapper predates the report',
      instanceId, metric: e.n, since: e.newest.toISOString() });
  }

  // A box whose runs never post `started` runs a wrapper from before the
  // hooks. Every run in the window is judged, each against its own launch.
  const perBox = new Map<string, { boxName: string; runs: number; started: number; oldest: number }>();
  for (const s of c.sessions) {
    for (const r of s.runs) {
      const e = perBox.get(r.instanceId) ?? { boxName: r.boxName, runs: 0, started: 0, oldest: 0 };
      e.runs++; if (r.started) e.started++;
      e.oldest = Math.max(e.oldest, now - r.startedAt.getTime());
      perBox.set(r.instanceId, e);
    }
  }
  for (const [instanceId, e] of perBox) {
    if (e.started > 0 || e.oldest < T.cloudStaleBoxMinRunAgeMs) continue;
    out.push({ id: `cloud_stale_box:${instanceId}`, kind: 'cloud_stale_box', severity: 'notice',
      title: `Box ${e.boxName} never reports cloud session starts`,
      detail: `${e.runs} run${e.runs === 1 ? '' : 's'} this week without a started event: the box's termag-claude-runner predates the runner hooks; pull and reconcile it`,
      instanceId, metric: e.runs });
  }
}
