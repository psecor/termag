/**
 * Client for the admin REST surface (/api/admin).
 * Response shapes mirror backend/src/services/admin/*.
 */
import axios from 'axios';
import { sendClientHeader } from '../buildInfo';
import type { BoxSize } from '../utils/boxSize';
import type { BoxResizeInfo, ResizeView } from '../utils/boxResize';
import type { BoxLifecycle } from '../types';

const api = axios.create({ baseURL: '/termag', withCredentials: true });
sendClientHeader(api);

export type AdminRange = 'today' | '7d' | '30d';
const q = (range: AdminRange, extra: Record<string, string | number | boolean | undefined> = {}) => ({
  params: { range, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== '')) },
});

export interface AdminInstance {
  id: string; name: string; kind: string; status: string; region: string | null;
  ec2InstanceId: string | null; hostname: string | null;
  /** The AMI the box launched from and how it was chosen: published, channel:<name>, pinned, fallback:<asked>. */
  imageId: string | null; imageSource: string | null;
  /** small, medium or large, and the EC2 type it launched as; size null for the configured type. */
  size: string | null; instanceType: string | null;
  /** Its current or last resize; null when it never had one. */
  resize?: ResizeView | null;
  /** The root disk in GB it was made with; null before it was recorded. The live volume is the detail's Disk section. */
  diskGiB?: number | null;
  createdAt: string; readyAt: string | null; lastConnectedAt: string | null; terminatedAt: string | null;
  provisioningError: string | null; provisioningMs: number | null;
  owner: { id: string; email: string; unixUsername: string } | null;
  connected: boolean;
  agentCommit: string | null;
  /** When the agent's commit was made; null offline or from an older agent. */
  agentCommitAt: string | null;
  /** The last termag-box-update run the box reported; null before any. */
  update: { at: string; outcome: string; detail: string | null; commit: string | null } | null;
  projects: { active: number; archived: number };
  lastProjectActiveAt: string | null;
  /** Claude Code cloud sessions open on the box right now. */
  cloud: CloudCounts;
  /** Disk, memory, load and kept runner checkouts from the agent; null until an agent that samples has connected. */
  host: HostPressure | null;
  scan: { lastScanAt: string | null; error: string | null; schema: number | null } | null;
}
export interface HostPressure { diskUsedPct: number | null; memUsedPct: number | null; load1: number | null; keptCheckouts: number | null; sampledAt: string }
/** Open cloud runs: running once the box posted `started`, starting before. */
export interface CloudCounts { running: number; starting: number }
export interface AdminInstanceDetail extends AdminInstance {
  projectList: Array<{ id: string; name: string; archived: boolean; lastActiveAt: string }>;
  tokens: Array<{ id: string; name: string; tokenPrefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>;
  securityGroupId: string | null; iamRoleName: string | null;
  hibernationConfigured: boolean;
  /** Null until an admin quarantines the box (backend/src/services/boxQuarantine.ts); kept after its terminate. */
  quarantine: BoxQuarantine | null;
  /** What auto-park will do with the box, with its owner's flags; null for an ownerless box. */
  lifecycle: BoxLifecycle | null;
  /** Its last 10 fleet operations (box_events: resizes, disk grows), newest first. Absent from older orchestrators. */
  events?: BoxOperation[];
}
export type QuarantineStepName = 'tokens' | 'tag' | 'iam' | 'network' | 'snapshot' | 'stop';
export interface QuarantineStepResult {
  step: QuarantineStepName;
  outcome: 'done' | 'skipped' | 'failed';
  detail: string;
  at: string;
  snapshots?: Array<{ volumeId: string; device: string; snapshotId: string }>;
}
export interface BoxQuarantine {
  at: string; by: string | null; reason: string | null; fromStatus: string | null;
  /** Null while the first run is still under way, or if it was cut short before it recorded anything. */
  steps: QuarantineStepResult[] | null;
  /** A run is in flight on the orchestrator: its steps are still being written, and a retry would be refused. */
  running: boolean;
}
/** The run's outcome, or (202) `running: true` when it outlasted the request: the detail's steps fill in as it goes. */
export type QuarantineResult =
  | { id: string; status: 'quarantined'; steps: QuarantineStepResult[]; failed: QuarantineStepName[] }
  | { id: string; status: 'quarantined'; running: true };
/** One row of box_events, as the Fleet card lists it (backend services/boxEvents.ts boxEventView). */
export interface BoxOperation {
  id: string; kind: string; actor: string | null; actorRole: string; reason: string | null;
  from: string | null; to: string | null; phase: string; running: boolean;
  startedAt: string; finishedAt: string | null; error: string | null;
}
export interface FleetOverview {
  total: number; byStatus: Record<string, number>; byKind: Record<string, number>; byRegion: Record<string, number>;
  connected: number; readyDisconnected: number; poolAgentsConnected: number; legacyAgentsConnected: number;
  cloud: CloudCounts & { boxes: number };
  /** The newest box AMI's commit and creation date: what a current box runs. */
  target: { commit: string | null; imageCreatedAt: string | null };
  /** Connected owned boxes on another commit than the target. */
  behind: number;
  generatedAt: string;
}
export interface ProvisioningStats {
  range: { since: string; until: string };
  launched: number; ready: number; failed: number; pending: number;
  durationS: { p50: number | null; p95: number | null; max: number | null; samples: number };
  failures: Array<{ error: string; count: number }>;
  byWeek: Array<{ week: string; launched: number; failed: number; p50S: number | null }>;
}

export interface AdminUser {
  id: string; email: string; displayName: string; unixUsername: string; defaultAgentProvider: string;
  role: 'admin' | 'member'; adminSource: string | null;
  createdAt: string; lastSeenAt: string | null;
  boxes: { total: number; ready: number; connected: number };
  legacyAgentConnected: boolean;
  projects: { active: number; archived: number; lastActiveAt: string | null };
  shares: { given: number; received: number };
  slack: boolean; discord: boolean;
  cloud: CloudCounts & { runsInRange: number };
  agentMs: number; humanMs: number; tokens: number; cacheRatio: number | null;
}
export interface AdminUserDetail extends AdminUser {
  instances: Array<{ id: string; name: string; kind: string; status: string; createdAt: string; lastConnectedAt: string | null }>;
  projectList: Array<{ id: string; name: string; archived: boolean; pinned: boolean; kind: string; lastActiveAt: string; instanceId: string | null; createdAt: string }>;
  tokenList: Array<{ id: string; name: string; scope: string; tokenPrefix: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; instanceId: string | null }>;
}
export interface ActiveUsersDay { date: string; signedIn: number; agentWorked: number; humanWorked: number; usedTokens: number; switchedProjects: number }
export interface ActiveUsers { days: ActiveUsersDay[]; totals: Record<string, number>; registered: number; note: string }
/** UTC buckets; weeks start on Monday (backend services/admin/userGrowth.ts). */
export type GrowthBucket = 'day' | 'week' | 'month';
// ── Deployed software ──
export type SoftwareState = 'current' | 'behind' | 'outdated' | 'ahead' | 'pending' | 'missing' | 'unknown';
export interface SoftwareCell { version: string | null; raw: string | null; path: string | null; state: SoftwareState; observedAt: string }
export interface SoftwareHost {
  hostKey: string; kind: 'orchestrator' | 'box' | 'agent'; name: string; owner: string | null;
  boxKind: string | null; status: string | null; connected: boolean; lastInventoryAt: string | null;
  cells: Record<string, SoftwareCell>;
}
export interface SoftwareSummary { component: string; reference: string | null; referenceNote: string; counts: Record<SoftwareState, number>; spread: Array<{ version: string; hosts: number }> }
export interface SoftwareMatrix {
  components: string[]; summary: SoftwareSummary[]; hosts: SoftwareHost[];
  /** `summary` without offline hosts (the orchestrator always counts), and how many were left out. Absent from an older backend. */
  online?: { summary: SoftwareSummary[]; offline: number };
  targets: { boxCommit: string | null; orchestratorImageCommit: string | null; runningCommit: string | null };
  collector: { lastSweepAt: string | null; lastSelfAt: string | null; lastError: string | null };
  generatedAt: string;
}
export interface SoftwareHostDetail { host: SoftwareHost; changes: Array<{ component: string; from: string | null; to: string | null; at: string }> }
// Tool updates from the Software tab ("Manual"), one
// component at a time. The routes answer 404 {code: 'claude_update_off'} while the tool's policy flag
// (<tool>-update-policy, claude-code-update-policy for Claude Code) has mode off for the host's owner and box.
export type UpdatableTool = 'claude' | 'codex' | 'cursor' | 'devin' | 'pi' | 'gh' | 'aws' | 'node' | 'python' | 'docker';
export type ToolRestart = 'none' | 'idle' | 'force';
export type ToolUpdateScope = 'below-floor' | 'behind' | 'all';
export interface ToolUpdatePreview {
  hostKey: string; connected: boolean; capable: boolean; current: string | null; target: string | null; floor: string | null;
  liveSessions: number; busySessions: number; runInFlight: boolean;
  /** The orchestrator host's preview (phase 2e): its runs try-restart the runner orchestrator and take restart none only. */
  kind?: 'orchestrator'; restarts?: ToolRestart[];
  /** The orchestrator host: a quarantine holds its runner orchestrator stopped until a verified install. */
  runnerHeld?: boolean;
  /** The orchestrator host with no version pinned in orchestrator-claude-update-policy: a run only brings it up to the floor; nothingToDo when it is already there. */
  floorOnly?: boolean; nothingToDo?: boolean;
  /** A tool updated only at the box's start (Docker): a run is queued for it, never run on the running box. */
  atStart?: boolean;
}
export interface SoftwareUpdateRun {
  id: string; hostKey: string; instanceId: string | null; component: UpdatableTool;
  trigger: 'manual' | 'boot' | 'guard' | 'floor' | 'resume' | 'nightly'; requestedById: string | null; restart: ToolRestart;
  /** Why an automatic run (floor, resume, nightly) was made, in words; null for the others. */
  reason?: string | null;
  status: 'requested' | 'running' | 'done' | 'failed' | 'refused' | 'expired';
  /** Requested, and waiting for its box's next start (a tool updated only then: Docker). */
  waitingForStart?: boolean;
  outcome: 'updated' | 'current' | 'partial' | 'failed' | 'floor-only' | null;
  target: string | null; fromVersion: string | null; toVersion: string | null; detail: string | null;
  sessions: { stopped: number; resumed: number; fresh: number; cut: number; typed: number; other: number; runnersLeft: number } | null;
  requestedAt: string; startedAt: string | null; finishedAt: string | null;
}
/** Why the fleet update skipped a host (backend services/toolUpdate/fleet.ts, FleetSkip). */
export type FleetSkipReason = 'claude_update_off' | 'offline' | 'not_capable' | 'run_in_flight' | 'not_installed' | 'version_unreadable' | 'no_inventory' | 'unknown_version';
// `string` too: an orchestrator newer than this page can name a reason it doesn't know yet.
export interface FleetToolUpdate { runs: Array<{ hostKey: string; runId: string }>; skipped: Array<{ hostKey: string; reason: FleetSkipReason | (string & {}) }>; atStart?: boolean }
export interface ClientVersionRow { userId: string; user: string | null; kind: string; version: string; state: SoftwareState; lastSeenAt: string }
// ── PR analytics ──
export type PrView = 'credited' | 'humans' | 'all';
export type PrBasis = 'merged' | 'opened';
export type PrWindow = 1 | 7 | 30;
export interface PrGroupMember { kind: 'repo' | 'pattern' | 'topic' | 'path'; value: string; org?: string; paths?: string[]; minShare?: number; keys?: string[] }
export interface PrGroup { slug: string; name: string; sort: number; members: PrGroupMember[]; excluded: string[]; repos: Array<{ repo: string; visibility: string; scoped?: boolean; prs: number }> }
export interface PrDistribution { contributors: number; p50: number; p95: number; mean: number; max: number }
export interface PrWindowSummary { days: number; prs: number; opened: number; merged: number; byClass: { human: number; agent: number; automation: number }; agentAssisted: number; distribution: PrDistribution }
export interface PrSummary { group: string; view: PrView; basis: PrBasis; repos: number; windows: PrWindowSummary[]; generatedAt: string }
export interface PrContributor { login: string; prs: number; share: number; agentPrs: number; agentAssisted: number; medianSize: number; termag: { userId: string; unixUsername: string } | null }
export interface PrContributors { group: string; days: number; total: number; contributors: number; top: PrContributor[] }
export interface PrTrend { group: string; weeks: number; rows: Array<{ week: string; human: number; agent: number; automation: number; prs: number; contributors: number }> }
export interface PrTeam { key: string; name: string; parent: string | null; hidden: boolean; sort: number; members: string[]; manual: string[]; former: number }
export interface PrTeamSummary extends PrSummary { team: string }
export interface PrTeamMembers extends PrContributors { team: string }
export interface PrTeamTrend extends PrTrend { team: string }
export interface PrTeamRepos { group: string; team: string; view: PrView; basis: PrBasis; days: number; repos: Array<{ repo: string; prs: number; contributors: number }> }
export interface PrTeamMemberInput { login: string; name?: string; email?: string }
export type PrTeamReviewSide = 'given' | 'received';
export interface PrTeamReviews extends PrReviews { team: string; side: PrTeamReviewSide }
export interface PrTeamReviewers extends PrReviewers { team: string; side: PrTeamReviewSide }
export interface PrTeamReviewTrend { group: string; team: string; weeks: number; rows: Array<{ week: string; given: number; received: number; reviewersGiven: number; reviewersReceived: number }> }
export interface PrIngestStatus {
  ingester: { state: string; lastTickAt: string | null; lastDiscoveryAt: string | null; lastError: string | null; pausedUntil: string | null; rate: { remaining: number; limit: number; resetAt: string } | null };
  tokenOwner: { id: string; unixUsername: string } | null;
  backfillDays: number; repos: number; backfilled: number; neverRun: number; prs: number; lastRunAt: string | null;
  reviewDays: number; reviewsBackfilled: number;
  errors: Array<{ repo: string; error: string | null; at: string | null }>;
}
export interface PrAgentSplit { repos: number; merged: number; agentOnly: number; humanAndAgent: number; humanOnly: number; none: number; unread: number }
export interface PrReviewWindow {
  days: number; reviews: number;
  /** Reviews per reviewer; contributors is the number of reviewers. */
  distribution: PrDistribution;
  approved: number; changesRequested: number; commentOnly: number; inlineComments: number;
  mergedComments: { prs: number; p50: number; p95: number; max: number; botShare: number | null };
  agent: PrAgentSplit;
}
export interface PrReviews { group: string; repos: number; reviewDays: number; approvalAgentLogins: string[]; windows: PrReviewWindow[]; generatedAt: string }
export interface PrReviewer {
  login: string; cls: string; reviews: number; approved: number; changesRequested: number; commentOnly: number; inlineComments: number;
  decidingApprovals: number; medianHoursToFirstReview: number | null; askedReviews: number; stalePickups: number; authorsHelped: number;
  termag: { userId: string; unixUsername: string } | null;
}
export interface PrReviewers { group: string; days: number; reviewers: number; reviews: number; top: PrReviewer[] }
export interface PrReviewTrend { group: string; weeks: number; rows: Array<{ week: string; reviews: number; reviewers: number; agentOnly: number; humanApproved: number; unapproved: number }> }
export interface UserGrowth {
  bucket: GrowthBucket;
  /** key: 'YYYY-MM-DD' (day, week's Monday) or 'YYYY-MM' (month); total is the running headcount. */
  rows: Array<{ key: string; new: number; total: number }>;
  total: number; before: number; firstAt: string | null;
  current: number; previous: number; note: string;
}

export interface AdminProject {
  id: string; name: string; kind: string; archived: boolean; pinned: boolean;
  owner: { id: string; unixUsername: string };
  instance: { id: string; name: string; status: string } | null;
  provider: string | null; providers: string[]; workstreams: number; shares: number;
  createdAt: string; lastActiveAt: string; slackChannel: boolean;
}
export interface ProjectCounts {
  total: number; active: number; archived: number;
  byKind: Record<string, number>; byProvider: Record<string, number>;
  workstreams: number; shares: number; invites: Record<string, number>;
}
export interface AdminSessionRow {
  projectId: string; projectName: string; owner: string; ownerUserId: string; access: string;
  workstream: string; role: string; session: string; instanceId: string | null;
  connected: boolean; alive: boolean; status: 'working' | 'waiting' | 'idle' | 'not_running';
  contextTokens: number | null; updatedAt: string | null; waitingReason: string | null;
  rateLimited: string | null; provider: string | null; lastActiveAt: string;
}
export interface SessionSummary {
  agentPanes: number; alive: number; byStatus: Record<string, number>; byProvider: Record<string, number>;
  byHost: Record<string, number>; rateLimited: number; offlineHosts: number;
}

export type TokenGroup = 'day' | 'user' | 'provider' | 'host' | 'project' | 'model' | 'backend';
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number; total: number; cacheRatio: number | null; estimated: number }
export type SegmentName = 'New' | 'Power' | 'Active' | 'Passive' | 'Dormant' | 'Service';
export interface SegmentDayCount { date: string; counts: Array<{ segment: string; n: number }>; total: number }
export interface SegmentUsers { date: string; users: Array<{ userId: string; username: string | null; segment: string }> }
export interface SegmentFlow { from: string; to: string; n: number }
export interface SegmentsOverview {
  days: SegmentDayCount[];
  segments: string[];
  from: string; to: string; users: number;
  tracker: { state: string; lastRunAt: string | null; lastRebuiltDay: string | null; lastError: string | null };
  transitions: { first: string; last: string; flows: SegmentFlow[] };
}

export interface TokenReport {
  range: { since: string; until: string; days: number; dayKeys: 'utc' };
  groupBy: TokenGroup[];
  rows: Array<TokenTotals & { keys: string[]; labels: string[] }>;
  totals: TokenTotals; prior: { total: number }; users: number;
}
export type WorktimeGroup = 'day' | 'user' | 'provider' | 'project';
export interface WorktimeReport {
  range: { since: string; until: string; days: number; dayKeys: 'server-local' };
  groupBy: WorktimeGroup[];
  rows: Array<{ keys: string[]; agentMs: number; humanMs: number; sessions: number }>;
  totals: { agentMs: number; humanMs: number; sessions: number };
  prior: { agentMs: number; humanMs: number };
  unknownUsernames: string[];
}

export type SignalSeverity = 'critical' | 'warning' | 'notice' | 'good';
export interface Signal {
  id: string; kind: string; severity: SignalSeverity; title: string; detail: string;
  userId?: string; unixUsername?: string; instanceId?: string; projectId?: string; metric: number; since?: string;
}
export interface SignalsResponse { signals: Signal[]; thresholds: Record<string, number>; generatedAt: string }

export interface AdminOverview {
  range: { id: string; since: string; until: string };
  fleet: FleetOverview; projects: ProjectCounts; sessions: SessionSummary;
  tokens: { days: TokenReport['rows']; totals: TokenTotals; prior: { total: number } };
  worktime: { days: WorktimeReport['rows']; totals: WorktimeReport['totals']; prior: WorktimeReport['prior'] };
  users: { registered: number; active: Record<string, number> };
  /** Claude Code cloud sessions right now (no tmux probe behind these counts). */
  cloud: CloudCounts & { queued: number };
  signals: Signal[]; generatedAt: string;
}

// Claude Code cloud sessions, admin view (backend services/admin/claudeRunnerQueries.ts).
export interface OrchestratorHealth {
  available: boolean; reason?: string; port: number | null;
  /** The orchestrator's /healthz body: `connected`, `queue_counts`, `last_poll_at`, ... */
  body: Record<string, unknown> | null;
  fetchedAt: string; cached: boolean;
  /** The observability view for history, when the host is configured with one. */
  observabilityUrl: string | null;
}
/** The status map's entry for a running session, under the runner tmux name; null when nothing posted. */
export interface CloudLiveStatus {
  status: 'working' | 'waiting' | 'idle' | 'not_running';
  waitingReason: string | null; rateLimited: string | null; contextTokens: number | null; updatedAt: string;
}
export interface AdminCloudRun {
  orderId: string; instanceId: string; boxName: string; slot: number; sessionName: string | null;
  startedAt: string; endedAt: string | null; durationSec: number | null; exitStatus: number | null; exitReason: string | null; alive: boolean | null;
  /** Token usage the session posted about itself (cumulative); null until the first post. */
  usage: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number; calls: number | null; model: string | null; at: string } | null;
  /** The session directory's size when it ended, and whether the checkout was kept for unpushed work. */
  checkoutBytes: number | null;
  kept: boolean | null;
}
export interface AdminCloudSession {
  key: string; sessionId: string | null; url: string | null; seq: number | null; name: string; clientPlatform: string | null; owner: string;
  state: 'queued' | 'starting' | 'running' | 'ended' | 'lost'; exitReason: string | null; queuedReason: string | null;
  /** For `queued`: when the current unbroken run of refusals began. */
  queuedSince: string | null;
  current: AdminCloudRun | null; runs: AdminCloudRun[]; firstSeenAt: string; lastSeenAt: string; eventCount: number;
  live: CloudLiveStatus | null;
}
export interface AdminCloudSessions {
  days: number;
  boxes: Array<{ instanceId: string; boxName: string; owner: string; connected: boolean; sessions: AdminCloudSession[] }>;
  queued: AdminCloudSession[];
  recent: AdminCloudSession[];
  counts: { running: number; starting: number; queued: number; ended: number; lost: number };
  generatedAt: string;
}

export interface CloudSummary extends CloudCounts { queued: number; byBox: Record<string, CloudCounts>; byUser: Record<string, CloudCounts>; generatedAt: string }

// History and capacity.
export type CloudReportGroup = 'day' | 'owner' | 'box' | 'platform' | 'exitReason';
export const CLOUD_REPORT_GROUPS: CloudReportGroup[] = ['day', 'owner', 'box', 'platform', 'exitReason'];
export interface Percentiles { p50: number | null; p95: number | null; samples: number }
export interface CloudReportRow {
  key: string; label: string; sessions: number; runs: number; slotSeconds: number;
  ends: Record<string, number>; lost: number; refusals: Record<string, number>; queueWait: Percentiles; spawn: Percentiles;
  /** Tokens the runs that started in the group posted about themselves; 0 until boxes post usage. */
  tokens: number;
}
export interface CloudReport {
  range: { since: string; until: string; days: number };
  groupBy: CloudReportGroup;
  rows: CloudReportRow[];
  totals: Omit<CloudReportRow, 'key' | 'label'>;
  prior: { sessions: number; runs: number; slotSeconds: number; lost: number };
  refusals: Record<string, number>;
  eventHorizonDays: number;
  generatedAt: string;
}
export interface BoxCapacity {
  instanceId: string; boxName: string; userId: string | null; owner: string | null; status: string;
  connected: boolean; capable: boolean; eligible: boolean; slotsUsed: number; slotsMax: number;
  host: HostPressure | null;
}
export interface OwnerCapacity { owner: string; eligibleBoxes: number; slotsUsed: number; slotsFree: number; atCap: boolean; boxes: string }
export interface CloudCapacity {
  max: number; boxes: BoxCapacity[]; owners: Record<string, OwnerCapacity>;
  totals: { eligibleBoxes: number; slotsUsed: number; slotsFree: number }; generatedAt: string;
}
export interface PipelineBox {
  instanceId: string; boxName: string; owner: string | null; connected: boolean; agentCommit: string | null;
  runs: number; withStarted: number; withEnded: number; withPlatform: number; withTitle: number; lost: number; open: number;
}
export interface PipelineHealth { days: number; boxes: PipelineBox[]; generatedAt: string }

/** Mirrors backend services/spawnLimits.ts SpawnLimits. */
export interface SpawnLimitValues {
  maxDepth: number; maxOpenChildren: number; perHour: number; maxConcurrentPerUser: number; boxCapacity: number | null;
  hot: { memPct: number; loadPerCore: number; diskPct: number };
  parkIdleMinutes: number; retireAfterDays: number;
}
export interface SpawnLimitsUserRow {
  user: { id: string; unixUsername: string; displayName: string };
  limits: SpawnLimitValues;
  overrides: string[];
  usage: { lastHour: number; running: number; last30d: number };
}
export interface SpawnLimitsReport {
  flag: { key: string; url: string | null };
  defaults: SpawnLimitValues;
  users: SpawnLimitsUserRow[];
  generatedAt: string;
}

export interface SystemHealth {
  process: { version: string; node: string; pid: number; uptimeS: number; startedAt: string; rssMb: number; heapUsedMb: number; commit: string | null; authMode: string; localSessions: boolean };
  agents: {
    connected: number; boxes: number; legacy: number;
    tokenForms?: {
      queryAccepted: boolean;
      sinceStart: { header: number; query: number; refusedQuery: number };
      queryFormConnected: Array<{ userId: string | null; instanceId: string | null; since: string }>;
    };
  };
  statusMap: { sessions: number; byStatus: Record<string, number>; note: string };
  boxUpdates: { flag: string; targetCommit: string | null; targetImageCreatedAt: string | null; lastSweepAt: string | null; pushedThisProcess: number; boxesByLastOutcome24h: Record<string, number>; note: string };
  usageScans: { hosts: number; failing: number; lastScanAt: string | null; schema1Hosts: number };
  db: { bytes: number; activeHttpSessions: number; tables: Array<{ table: string; rows: number; bytes: number }> };
  generatedAt: string;
}

export interface AdminToken {
  id: string; name: string; tokenPrefix: string; scope: string; createdAt: string; lastUsedAt: string | null;
  expiresAt: string | null; revokedAt: string | null; expired: boolean;
  owner: { id: string; unixUsername: string; email: string; stillAdmin: boolean } | null;
}
export interface AdminTokenCreated { id: string; name: string; token: string; tokenPrefix: string; scope: string; createdAt: string; expiresAt: string | null }
export interface AdminsResponse {
  envConfigured: boolean;
  admins: Array<{ id: string; unixUsername: string; email: string; displayName: string; source: string; lastSeenAt: string | null; demotable: boolean }>;
}
export interface AuditRow { id: string; at: string; actorId: string; actor: string; tokenId: string | null; boxId?: string | null; surface: string; action: string; args: Record<string, unknown> | null; outcome: string; status: number | null }

// ── Box cost; mirrors backend/src/services/boxCost/report.ts ──
export interface BoxCostMoney { active: number; idle: number; pool: number; boot: number; orphan: number; compute: number; storage: number; total: number }
export interface BoxCostBox {
  ec2InstanceId: string; instanceId: string | null; name: string | null; status: string | null; owner: string | null;
  instanceType: string; volumeGb: number; runningHours: number; activeShare: number | null; teardownUnfinished: boolean; usd: BoxCostMoney;
}
export interface BoxCostPerson { userId: string; name: string; boxes: number; runningHours: number; activeShare: number | null; usd: BoxCostMoney }
export interface BoxCostReport {
  window: { since: string; until: string };
  meteredFrom: string | null;
  rates: { source: string; perHour: Record<string, number>; gp3PerGbMonth: number };
  totals: BoxCostMoney & { runningHours: number; boxes: number };
  days: Array<{ day: string } & BoxCostMoney>;
  people: BoxCostPerson[];
  boxes: BoxCostBox[];
  parked: { boxes: number; gb: number; monthlyUsd: number };
  unrated: string[];
  reconcile: BoxReconcile | null;
}
export interface BoxReconcileLine {
  ec2InstanceId: string; name: string | null; instanceType: string | null;
  meteredHours: number; billedHours: number; meteredUsd: number; billedUsd: number;
}
export interface BoxReconcile {
  days: string[]; estimatedDays: number;
  meteredHours: number; billedHours: number; meteredUsd: number; billedUsd: number;
  notMetered: BoxReconcileLine[]; notMeteredUsd: number; notBilled: BoxReconcileLine[]; drift: BoxReconcileLine[];
}

// ── Spend; mirrors backend/src/services/admin/spend/model.ts ──
export type SpendPoolKind = 'contract' | 'infra';
export type SpendPoolShare = 'proportional' | 'usage' | 'full';
export type SpendPoolAllocation = 'even' | 'by-tokens' | 'by-usage';
export interface SpendPrice { provider: string; model: string; effectiveFrom: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface SpendPool {
  id?: string; name: string; kind: SpendPoolKind; providers: string[];
  annualUsd: number | null; boxes: number | null; boxCostUsd: number | null; usersPerBox: number | null;
  share: SpendPoolShare; shareValue: number | null; populationLabel: string | null; populationSize: number | null;
  allocation: SpendPoolAllocation; startDate: string | null; endDate: string | null; note: string | null; sort: number;
}
export interface SpendSettings { loadedCostUsd: number; orgHeadcount: number; modelMix: Record<string, Record<string, number>> }
export interface SpendModel { config: SpendSettings; prices: SpendPrice[]; pools: SpendPool[]; updatedAt: string }
export interface SpendPoolCost {
  id: string; name: string; kind: SpendPoolKind; providers: string[]; share: SpendPoolShare; allocation: SpendPoolAllocation;
  annualUsd: number; daysInWindow: number; shareFraction: number; populationLabel: string | null; population: number | null;
  costUsd: number; tokens: number; usdPerMTokens: number | null; activeUsers: number; usdPerActiveUser: number | null;
  infra: null | { boxes: number; fixedBoxes: boolean; boxCostUsd: number; usersPerBox: number; peakConcurrent: number | null; boxesNeeded: number | null; utilization: number | null; seatUsdPerMonth: number };
  warnings: string[];
}
export interface SpendProviderCost {
  provider: string; pricing: 'metered' | 'pool' | 'unpriced'; pool: string | null; users: number;
  input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number; tokens: number;
  costUsd: number; usdPerMTokens: number | null; usdPerMExcludingCacheReads: number | null; cacheSavingsUsd: number | null;
  estimatedTokens: number; estimatedCostUsd: number;
  priceUsed: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}
export interface SpendPerson {
  userId: string; name: string; active: boolean; tokens: number; meteredUsd: number; pools: Record<string, number>;
  poolUsd: number; totalUsd: number; annualizedUsd: number; shareOfLoaded: number; topProvider: string | null;
}
export interface SpendReport {
  window: { since: string; until: string; days: number };
  denominator: { mode: 'all' | 'active'; users: number; allUsers: number; activeUsers: number };
  config: SpendSettings;
  totals: {
    meteredUsd: number; poolUsd: number; totalUsd: number; perHeadUsd: number | null; perHeadMonthlyUsd: number | null;
    annualizedUsd: number; shareOfLoaded: number | null; tokens: number; usdPerMTokens: number | null;
    estimatedTokens: number; estimatedCostUsd: number;
  };
  distribution: { p50: number | null; p90: number | null; mean: number | null; max: number | null };
  providers: SpendProviderCost[]; pools: SpendPoolCost[]; people: SpendPerson[]; unpriced: string[]; updatedAt: string;
}
export interface SpendWeek { week: string; days: number; metered: Record<string, number>; pools: Record<string, number>; totalUsd: number }

export interface BoxVolumeModification { state: string; progress: number | null; targetSizeGb: number | null; startedAt: string | null }
export interface BoxGrow {
  volumeId: string; fromGb: number; toGb: number; by: string; startedAt: string;
  state: 'modifying' | 'filesystem' | 'done' | 'failed'; detail: string | null; finishedAt: string | null;
}
export interface BoxDisk {
  refusal: string | null;
  maxGb: number;
  volume: { volumeId: string; sizeGb: number; volumeType: string | null; modification: BoxVolumeModification | null } | { error: string } | null;
  grow: BoxGrow | null;
}

// ── Bug reports (backend routes/admin/bugs.ts) ──
export const BUG_STATUSES = ['new', 'triaged', 'duplicate', 'fixed', 'wontfix'] as const;
export const BUG_AREAS = ['spaces', 'asks', 'publish', 'boxes', 'chat', 'cli', 'broker', 'other'] as const;
export const BUG_SEVERITIES = ['low', 'medium', 'high'] as const;
export type BugStatus = typeof BUG_STATUSES[number];
export interface BugSummary { id: string; title: string; status: BugStatus; severity: string; area: string; createdAt: string }
export interface BugListRow extends BugSummary {
  reporter: string; box: string | null; agentProvider: string | null; linkUrl: string | null; duplicateOfId: string | null;
}
export interface BugReport extends BugSummary {
  body: string; reporterUserId: string; credential: 'box' | 'device';
  boxId: string | null; projectId: string | null; workstream: string | null; threadId: string | null;
  agentProvider: string | null; agentModel: string | null; agentVersion: string | null;
  cliVersion: string | null; boxAgentCommit: string | null; boxAgentCapabilities: string[]; boxImage: string | null;
  command: string | null; errorOutput: string | null; redacted: string[];
  duplicateOfId: string | null; linkUrl: string | null; triagedAt: string | null;
}
export interface BugEvent {
  id: string; actorId: string; actor: string; status: BugStatus | null; duplicateOfId: string | null;
  /** "" when the change cleared the link. */
  linkUrl: string | null; note: string | null; createdAt: string;
}
export interface BugDetail {
  report: BugReport;
  reporter: { user: string; box: string | null; project: string | null };
  events: BugEvent[];
  duplicateOf: BugSummary | null;
  duplicates: BugSummary[];
}
export interface BugFilters { status?: string; area?: string; severity?: string; q?: string }
export interface BugChange { status?: BugStatus; duplicateOf?: string; link?: string | null; note?: string }

export const adminApi = {
  overview: (range: AdminRange): Promise<AdminOverview> => api.get('/api/admin/overview', q(range)).then(r => r.data),
  instances: (all = false): Promise<AdminInstance[]> => api.get('/api/admin/fleet/instances', { params: all ? { all: 1 } : {} }).then(r => r.data),
  instance: (id: string): Promise<AdminInstanceDetail> => api.get(`/api/admin/fleet/instances/${encodeURIComponent(id)}`).then(r => r.data),
  quarantineBox: (id: string, reason: string): Promise<QuarantineResult> =>
    api.post(`/api/admin/fleet/instances/${encodeURIComponent(id)}/quarantine`, { reason, confirm: true }).then(r => r.data),
  /** End one preview link by its name or id (SR15, routes/admin/previewLinkEnd.ts): session-only, with confirm. */
  endPreviewLink: (ref: { name: string } | { id: string }): Promise<{ link: { id: string; name: string; endedAt: string | null; endReason: string | null }; alreadyEnded?: boolean }> =>
    api.post('/api/admin/preview-links/end', { ...ref, confirm: true }).then(r => r.data),
  terminateQuarantinedBox: (id: string): Promise<{ ok: true; archivedProjects: number }> =>
    api.post(`/api/admin/fleet/instances/${encodeURIComponent(id)}/terminate`, { confirm: true }).then(r => r.data),
  boxDisk: (id: string): Promise<BoxDisk> => api.get(`/api/admin/fleet/instances/${encodeURIComponent(id)}/disk`).then(r => r.data),
  growBoxDisk: (id: string, sizeGb: number): Promise<BoxGrow> => api.post(`/api/admin/fleet/instances/${encodeURIComponent(id)}/disk`, { sizeGb }).then(r => r.data),
  boxResizeInfo: (id: string): Promise<BoxResizeInfo> => api.get(`/api/admin/fleet/instances/${encodeURIComponent(id)}/resize`).then(r => r.data),
  resizeBox: (id: string, size: BoxSize, reason: string, force = false): Promise<{ resize: ResizeView }> =>
    api.post(`/api/admin/fleet/instances/${encodeURIComponent(id)}/resize`, { size, reason, ...(force ? { force } : {}) }).then(r => r.data),
  fleetOverview: (): Promise<FleetOverview> => api.get('/api/admin/fleet/overview').then(r => r.data),
  provisioning: (range: AdminRange): Promise<ProvisioningStats> => api.get('/api/admin/fleet/provisioning', q(range)).then(r => r.data),
  users: (range: AdminRange): Promise<AdminUser[]> => api.get('/api/admin/users', q(range)).then(r => r.data),
  user: (id: string, range: AdminRange): Promise<AdminUserDetail> => api.get(`/api/admin/users/${encodeURIComponent(id)}`, q(range)).then(r => r.data),
  activeUsers: (range: AdminRange): Promise<ActiveUsers> => api.get('/api/admin/users/active', q(range)).then(r => r.data),
  prGroups: (): Promise<PrGroup[]> => api.get('/api/admin/prs/groups').then(r => r.data),
  prStatus: (): Promise<PrIngestStatus> => api.get('/api/admin/prs/status').then(r => r.data),
  prSummary: (group: string, view: PrView, basis: PrBasis): Promise<PrSummary> => api.get('/api/admin/prs/summary', { params: { group, view, basis } }).then(r => r.data),
  prContributors: (group: string, view: PrView, basis: PrBasis, window: PrWindow): Promise<PrContributors> => api.get('/api/admin/prs/contributors', { params: { group, view, basis, window } }).then(r => r.data),
  prTrend: (group: string, view: PrView, basis: PrBasis): Promise<PrTrend> => api.get('/api/admin/prs/trend', { params: { group, view, basis } }).then(r => r.data),
  prReviews: (group: string): Promise<PrReviews> => api.get('/api/admin/prs/reviews', { params: { group } }).then(r => r.data),
  prReviewers: (group: string, window: PrWindow): Promise<PrReviewers> => api.get('/api/admin/prs/reviewers', { params: { group, window } }).then(r => r.data),
  prReviewTrend: (group: string): Promise<PrReviewTrend> => api.get('/api/admin/prs/reviews/trend', { params: { group } }).then(r => r.data),
  prTeams: (): Promise<PrTeam[]> => api.get('/api/admin/prs/teams').then(r => r.data),
  prTeamSummary: (team: string, group: string, view: PrView, basis: PrBasis): Promise<PrTeamSummary> => api.get('/api/admin/prs/team-summary', { params: { team, group, view, basis } }).then(r => r.data),
  prTeamMembers: (team: string, group: string, view: PrView, basis: PrBasis, window: PrWindow): Promise<PrTeamMembers> => api.get('/api/admin/prs/team-members', { params: { team, group, view, basis, window } }).then(r => r.data),
  prTeamRepos: (team: string, group: string, view: PrView, basis: PrBasis, window: PrWindow): Promise<PrTeamRepos> => api.get('/api/admin/prs/team-repos', { params: { team, group, view, basis, window } }).then(r => r.data),
  prTeamTrend: (team: string, group: string, view: PrView, basis: PrBasis): Promise<PrTeamTrend> => api.get('/api/admin/prs/team-trend', { params: { team, group, view, basis } }).then(r => r.data),
  prTeamReviews: (team: string, group: string, side: PrTeamReviewSide): Promise<PrTeamReviews> => api.get('/api/admin/prs/team-reviews', { params: { team, group, side } }).then(r => r.data),
  prTeamReviewers: (team: string, group: string, side: PrTeamReviewSide, window: PrWindow, limit?: number): Promise<PrTeamReviewers> => api.get('/api/admin/prs/team-reviewers', { params: { team, group, side, window, limit } }).then(r => r.data),
  prTeamReviewTrend: (team: string, group: string): Promise<PrTeamReviewTrend> => api.get('/api/admin/prs/team-reviews/trend', { params: { team, group } }).then(r => r.data),
  savePrTeam: (t: { key: string; name: string; parent: string | null; hidden: boolean; sort: number; members: PrTeamMemberInput[] }) => api.put(`/api/admin/prs/teams/${encodeURIComponent(t.key)}`, t).then(r => r.data),
  deletePrTeam: (key: string) => api.delete(`/api/admin/prs/teams/${encodeURIComponent(key)}`).then(r => r.data),
  syncPrTeams: (): Promise<{ teams: number; members: number; skipped: number }> => api.post('/api/admin/prs/teams/sync').then(r => r.data),
  /** The same sync from an uploaded org-tree export (`teams-export.json`), for a deployment that reaches neither the file nor the API. */
  importPrTeams: (exportJson: unknown): Promise<{ teams: number; members: number; skipped: number; source: string }> => api.post('/api/admin/prs/teams/import', exportJson).then(r => r.data),
  savePrGroup: (g: { slug: string; name: string; members: PrGroupMember[]; excluded: string[]; sort: number }) => api.put(`/api/admin/prs/groups/${encodeURIComponent(g.slug)}`, g).then(r => r.data),
  deletePrGroup: (slug: string) => api.delete(`/api/admin/prs/groups/${encodeURIComponent(slug)}`).then(r => r.data),
  setPrToken: (use: boolean): Promise<PrIngestStatus> => api.put('/api/admin/prs/token', { use }).then(r => r.data),
  syncPrs: () => api.post('/api/admin/prs/sync').then(r => r.data),
  software: (): Promise<SoftwareMatrix> => api.get('/api/admin/software').then(r => r.data),
  softwareHost: (hostKey: string): Promise<SoftwareHostDetail> => api.get(`/api/admin/software/hosts/${encodeURIComponent(hostKey)}`).then(r => r.data),
  clientVersions: (): Promise<{ runningCommit: string | null; clients: ClientVersionRow[] }> => api.get('/api/admin/software/clients').then(r => r.data),
  refreshSoftware: () => api.post('/api/admin/software/refresh').then(r => r.data),
  toolUpdatePreview: (component: UpdatableTool, hostKey: string): Promise<ToolUpdatePreview> => api.get(`/api/admin/software/hosts/${encodeURIComponent(hostKey)}/update-preview`, { params: { component } }).then(r => r.data),
  updateTool: (component: UpdatableTool, hostKey: string, restart: ToolRestart): Promise<{ runId: string; acknowledged: boolean; atStart?: boolean }> => api.post(`/api/admin/software/hosts/${encodeURIComponent(hostKey)}/update`, { component, restart }).then(r => r.data),
  updateToolFleet: (component: UpdatableTool, scope: ToolUpdateScope, restart: ToolRestart): Promise<FleetToolUpdate> => api.post('/api/admin/software/update', { component, scope, restart }).then(r => r.data),
  softwareUpdates: (component: UpdatableTool, limit = 50): Promise<{ runs: SoftwareUpdateRun[] }> => api.get('/api/admin/software/updates', { params: { component, limit } }).then(r => r.data),
  /** `from`/`to` are inclusive UTC day keys; the Spend tab picks 7, 30 or 90 days ending today. */
  spendReport: (from: string, to: string, active: boolean): Promise<SpendReport> => api.get('/api/admin/spend/report', { params: { from, to, ...(active ? { active: 1 } : {}) } }).then(r => r.data),
  spendTrend: (weeks = 12): Promise<{ weeks: SpendWeek[] }> => api.get('/api/admin/spend/trend', { params: { weeks } }).then(r => r.data),
  boxCost: (from: string, to: string): Promise<BoxCostReport> => api.get('/api/admin/spend/boxes', { params: { from, to } }).then(r => r.data),
  spendModel: (): Promise<SpendModel> => api.get('/api/admin/spend/config').then(r => r.data),
  saveSpendModel: (m: Omit<SpendModel, 'updatedAt'>): Promise<SpendModel> => api.put('/api/admin/spend/config', m).then(r => r.data),
  userGrowth: (bucket: GrowthBucket): Promise<UserGrowth> => api.get('/api/admin/users/growth', { params: { bucket } }).then(r => r.data),
  projects: (f: { userId?: string; instanceId?: string; provider?: string; archived?: boolean; staleDays?: number } = {}): Promise<AdminProject[]> =>
    api.get('/api/admin/projects', { params: { ...f, archived: f.archived ? 1 : undefined } }).then(r => r.data),
  projectCounts: (): Promise<ProjectCounts> => api.get('/api/admin/projects/counts').then(r => r.data),
  liveSessions: (): Promise<{ summary: SessionSummary; rows: AdminSessionRow[]; generatedAt: string }> => api.get('/api/admin/sessions/live').then(r => r.data),
  tokens: (range: AdminRange, groupBy: TokenGroup[]): Promise<TokenReport> => api.get('/api/admin/usage/tokens', q(range, { groupBy: groupBy.join(',') })).then(r => r.data),
  worktime: (range: AdminRange, groupBy: WorktimeGroup[]): Promise<WorktimeReport> => api.get('/api/admin/usage/worktime', q(range, { groupBy: groupBy.join(',') })).then(r => r.data),
  segments: (): Promise<SegmentsOverview> => api.get('/api/admin/segments').then(r => r.data),
  segmentUsers: (date?: string): Promise<SegmentUsers> => api.get('/api/admin/segments/users', date ? { params: { date } } : {}).then(r => r.data),
  signals: (): Promise<SignalsResponse> => api.get('/api/admin/signals').then(r => r.data),
  system: (): Promise<SystemHealth> => api.get('/api/admin/system').then(r => r.data),
  spawnLimits: (): Promise<SpawnLimitsReport> => api.get('/api/admin/spawn-limits').then(r => r.data),
  orchestratorHealth: (): Promise<OrchestratorHealth> => api.get('/api/admin/claude-runner/health').then(r => r.data),
  cloudSessions: (days = 7, limit = 50): Promise<AdminCloudSessions> => api.get('/api/admin/claude-runner/sessions', { params: { days, limit } }).then(r => r.data),
  cloudReport: (range: AdminRange, groupBy: CloudReportGroup): Promise<CloudReport> => api.get('/api/admin/claude-runner/report', q(range, { groupBy })).then(r => r.data),
  cloudCapacity: (): Promise<CloudCapacity> => api.get('/api/admin/claude-runner/capacity').then(r => r.data),
  cloudPipeline: (): Promise<PipelineHealth> => api.get('/api/admin/claude-runner/pipeline').then(r => r.data),
  cloudSummary: (): Promise<CloudSummary> => api.get('/api/admin/claude-runner/summary').then(r => r.data),
  adminTokens: (): Promise<AdminToken[]> => api.get('/api/admin/tokens').then(r => r.data),
  mintAdminToken: (name: string, expiresDays: number | null): Promise<AdminTokenCreated> => api.post('/api/admin/tokens', { name, expiresDays }).then(r => r.data),
  revokeAdminToken: (id: string) => api.delete(`/api/admin/tokens/${encodeURIComponent(id)}`).then(r => r.data),
  admins: (): Promise<AdminsResponse> => api.get('/api/admin/admins').then(r => r.data),
  setRole: (userId: string, role: 'admin' | 'member') => api.put(`/api/admin/admins/${encodeURIComponent(userId)}`, { role }).then(r => r.data),
  audit: (range: AdminRange, limit = 200): Promise<{ rows: AuditRow[]; limit: number }> => api.get('/api/admin/audit', q(range, { limit })).then(r => r.data),
  bugReports: (f: BugFilters): Promise<{ reports: BugListRow[] }> =>
    api.get('/api/admin/bug-reports', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).then(r => r.data),
  bugCounts: (): Promise<{ counts: Record<BugStatus, number> }> => api.get('/api/admin/bug-reports/counts').then(r => r.data),
  bugReport: (id: string): Promise<BugDetail> => api.get(`/api/admin/bug-reports/${encodeURIComponent(id)}`).then(r => r.data),
  triageBug: (id: string, change: BugChange): Promise<{ report: BugReport }> => api.patch(`/api/admin/bug-reports/${encodeURIComponent(id)}`, change).then(r => r.data),
};
