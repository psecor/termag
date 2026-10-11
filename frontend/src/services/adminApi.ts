/**
 * Client for the admin REST surface (/api/admin).
 * Response shapes mirror backend/src/services/admin/*.
 */
import axios from 'axios';

const api = axios.create({ baseURL: '/termag', withCredentials: true });

export type AdminRange = 'today' | '7d' | '30d';
const q = (range: AdminRange, extra: Record<string, string | number | boolean | undefined> = {}) => ({
  params: { range, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== '')) },
});

export interface AdminInstance {
  id: string; name: string; kind: string; status: string; region: string | null;
  ec2InstanceId: string | null; hostname: string | null;
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

export type TokenGroup = 'day' | 'user' | 'provider' | 'host' | 'project';
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number; total: number; cacheRatio: number | null; estimated: number }
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
export interface AuditRow { id: string; at: string; actorId: string; actor: string; tokenId: string | null; surface: string; action: string; args: Record<string, unknown> | null; outcome: string; status: number | null }

export const adminApi = {
  overview: (range: AdminRange): Promise<AdminOverview> => api.get('/api/admin/overview', q(range)).then(r => r.data),
  instances: (all = false): Promise<AdminInstance[]> => api.get('/api/admin/fleet/instances', { params: all ? { all: 1 } : {} }).then(r => r.data),
  instance: (id: string): Promise<AdminInstanceDetail> => api.get(`/api/admin/fleet/instances/${encodeURIComponent(id)}`).then(r => r.data),
  fleetOverview: (): Promise<FleetOverview> => api.get('/api/admin/fleet/overview').then(r => r.data),
  provisioning: (range: AdminRange): Promise<ProvisioningStats> => api.get('/api/admin/fleet/provisioning', q(range)).then(r => r.data),
  users: (range: AdminRange): Promise<AdminUser[]> => api.get('/api/admin/users', q(range)).then(r => r.data),
  user: (id: string, range: AdminRange): Promise<AdminUserDetail> => api.get(`/api/admin/users/${encodeURIComponent(id)}`, q(range)).then(r => r.data),
  activeUsers: (range: AdminRange): Promise<ActiveUsers> => api.get('/api/admin/users/active', q(range)).then(r => r.data),
  projects: (f: { userId?: string; instanceId?: string; provider?: string; archived?: boolean; staleDays?: number } = {}): Promise<AdminProject[]> =>
    api.get('/api/admin/projects', { params: { ...f, archived: f.archived ? 1 : undefined } }).then(r => r.data),
  projectCounts: (): Promise<ProjectCounts> => api.get('/api/admin/projects/counts').then(r => r.data),
  liveSessions: (): Promise<{ summary: SessionSummary; rows: AdminSessionRow[]; generatedAt: string }> => api.get('/api/admin/sessions/live').then(r => r.data),
  tokens: (range: AdminRange, groupBy: TokenGroup[]): Promise<TokenReport> => api.get('/api/admin/usage/tokens', q(range, { groupBy: groupBy.join(',') })).then(r => r.data),
  worktime: (range: AdminRange, groupBy: WorktimeGroup[]): Promise<WorktimeReport> => api.get('/api/admin/usage/worktime', q(range, { groupBy: groupBy.join(',') })).then(r => r.data),
  signals: (): Promise<SignalsResponse> => api.get('/api/admin/signals').then(r => r.data),
  system: (): Promise<SystemHealth> => api.get('/api/admin/system').then(r => r.data),
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
};
