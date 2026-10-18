import axios from 'axios';
import { connectionTracker } from '../utils/connectionTracker';
import type { ThemeSettings } from '../theme/schema';
import type { OrgAccess } from '../pages/settings/githubOrgCopy';
import { Project, BrowserTab, ChromeWindow, WorkflowType, AgentProvider, User, ProjectInvite, ProjectShareInfo, Instance, InstanceKind, BoxLifecycle, AutoTerminatedBox, Workstream, CloudSession, CloudSessionEvent, HandoffMode } from '../types';
import type { BoxGateState } from '../boxGate';

const api = axios.create({
  baseURL: '/termag',
  withCredentials: true,
});

// Every REST round-trip is evidence about reachability. An HTTP response of
// any status (even 401/500) proves a termag server answered; only a
// network-level failure — no response object — counts against us. This is
// what makes an outage show up the moment the user does anything, and it
// turns the existing 5s warp sample into a passive liveness probe for free.
api.interceptors.response.use(
  (res) => { connectionTracker.contact('http'); return res; },
  (err) => {
    if (err?.response) connectionTracker.contact('http');
    else connectionTracker.failure();
    return Promise.reject(err);
  },
);

// Mirrors backend routes/auth.ts AuthMode: 'okta' = identity from the ALB edge,
// 'oidc' = in-app OpenID Connect flow (container deployments), 'local' = the
// e2e stack's loopback-only sign-in with no identity provider.
export type AuthMode = 'google' | 'okta' | 'oidc' | 'local';

// Any subset of the user's preferences; the backend validates each field on
// its own. The theme is sent whole (see theme/schema.ts).
export interface PreferencesPatch {
  defaultAgentProvider?: AgentProvider;
  dotfilesRepoUrl?: string | null;
  theme?: ThemeSettings;
}

export const authApi = {
  me: (): Promise<User> => api.get('/auth/me').then(r => r.data),
  logout: () => api.post('/auth/logout').then(r => r.data),
  updatePreferences: (data: PreferencesPatch): Promise<User> =>
    api.put('/auth/me/preferences', data).then(r => r.data),
  /** First-run wizard finished/skipped (true) or re-offer it (false). */
  setOnboarded: (done: boolean): Promise<User> =>
    api.put('/auth/me/onboarding', { done }).then(r => r.data),
  // Which sign-in mechanism the backend is configured for (AUTH_MODE). Drives
  // the login page's provider label. Reachable unauthenticated.
  config: (): Promise<{ mode: AuthMode }> => api.get('/auth/config').then(r => r.data),
  // Mode-agnostic entry point; the backend routes to Google OAuth or the Okta
  // edge depending on AUTH_MODE.
  loginUrl: () => '/termag/auth/login',
};

// The deployment's flag values (TERMAG_FLAGS), read by useFlag (flags.ts).
export const featureFlagsApi = {
  get: (): Promise<{ flags: Record<string, unknown> }> =>
    api.get('/api/flags').then(r => r.data),
};

export interface ProjectTemplateInfo { id: string; label: string; repoUrl: string; blurb: string }

export const projectsApi = {
  list: (): Promise<Project[]> => api.get('/api/projects').then(r => r.data),
  create: (data: {
    name: string;
    description?: string;
    color?: string;
    instanceId?: string | null;
    initialAgent?: { enabled: boolean; provider: AgentProvider };
    /** Start as a clone of this GitHub repo; the clone runs in the agent pane before the agent launches. */
    repoUrl?: string | null;
    defaultBranch?: string | null;
    /** The session replay this tab is recording (observability.ts replaySessionId); the agent launch files its Claude Code spans under it. */
    replaySessionId?: string | null;
  }): Promise<Project> =>
    api.post('/api/projects', data).then(r => r.data),
  /** Known starter repos for "first project" (webapp, research); "custom" is any GitHub URL. */
  templates: (): Promise<ProjectTemplateInfo[]> => api.get('/api/projects/templates').then(r => r.data),
  update: (id: string, data: Partial<{ name: string; description: string; color: string }>) =>
    api.put(`/api/projects/${id}`, data).then(r => r.data),
  rename: (id: string, name: string): Promise<Project> =>
    api.post(`/api/projects/${id}/rename`, { name }).then(r => r.data),
  togglePin: (id: string): Promise<{ pinned: boolean }> =>
    api.post(`/api/projects/${id}/pin`).then(r => r.data),
  bulkPin: (projectIds: string[], pinned: boolean): Promise<{ updated: number }> =>
    api.post('/api/projects/bulk/pin', { projectIds, pinned }).then(r => r.data),
  archive: (id: string) =>
    api.post(`/api/projects/${id}/archive`).then(r => r.data),
  addWorkflow: (projectId: string, type: WorkflowType, provider?: AgentProvider) =>
    api.post(`/api/projects/${projectId}/workflows`, { type, provider }).then(r => r.data),
  removeWorkflow: (projectId: string, type: WorkflowType) =>
    api.delete(`/api/projects/${projectId}/workflows/${type}`).then(r => r.data),
  retryClone: (id: string): Promise<{ setupStatus: string }> =>
    api.post(`/api/projects/${id}/clone/retry`).then(r => r.data),
  startEmpty: (id: string): Promise<Project> =>
    api.post(`/api/projects/${id}/clone/start-empty`).then(r => r.data),
};

export const githubReposApi = {
  list: (refresh = false): Promise<unknown> =>
    api.get('/api/github/repos', { params: refresh ? { refresh: '1' } : {} }).then(r => r.data),
};

// MetaTerm — the pinned per-user "control tower" project on the orchestrator.
// open() is idempotent: creates the singleton on first call (201), then just
// ensures it's up and returns it (200).
export const metatermApi = {
  open: (): Promise<{ project: Project; created: boolean }> =>
    api.post('/api/metaterm').then(r => r.data),
};

// Workstreams are returned embedded on Project, so `list` is rarely needed;
// the create/remove helpers are what the UI actually invokes. DELETE may
// return a `branchDeleteWarning` string when `git branch -d` was refused
// (unmerged work) — non-fatal, the worktree is gone either way.
export interface WorkstreamDeleteResult {
  ok: true;
  branchDeleteWarning: string | null;
}

/** Slack collaboration: send a card about a workstream. */
export const collabApi = {
  send: (data: {
    projectId: string; workstream: string; kind: 'fyi' | 'help'; ask: string; context: string[];
    tried?: string; helpWanted?: string; to: { channel?: string; people?: string[] };
  }): Promise<{ id: string; state: string; permalink?: string | null }> =>
    api.post('/api/collab/drafts', { ...data, send: true }).then(r => r.data),
};

export const workstreamsApi = {
  list: (projectId: string): Promise<Workstream[]> =>
    api.get(`/api/projects/${projectId}/workstreams`).then(r => r.data),
  create: (projectId: string, data: { name: string; branch?: string; baseRef?: string }): Promise<Workstream> =>
    api.post(`/api/projects/${projectId}/workstreams`, data).then(r => r.data),
  remove: (projectId: string, workstreamId: string, force = false): Promise<WorkstreamDeleteResult> =>
    api.delete(`/api/projects/${projectId}/workstreams/${workstreamId}`, {
      params: force ? { force: 1 } : undefined,
    }).then(r => r.data),
  /** Rename the worktree dir + tmux sessions + row; the git branch is left alone. */
  rename: (projectId: string, workstreamId: string, name: string): Promise<Workstream> =>
    api.post(`/api/projects/${projectId}/workstreams/${workstreamId}/rename`, { name }).then(r => r.data),
  /** Switch the agent this workstream runs: stops the one in its agent pane, starts `provider` there. */
  switchAgent: (projectId: string, workstreamId: string, provider: string): Promise<{ ok: true; provider: string; changed: boolean; warning?: string | null }> =>
    api.post(`/api/projects/${projectId}/workstreams/${workstreamId}/agent`, { provider }).then(r => r.data),
};


export interface AgentTokenInfo {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AgentTokenCreated extends AgentTokenInfo {
  token: string; // raw token, shown once
}

export const agentTokensApi = {
  list: (): Promise<AgentTokenInfo[]> => api.get('/api/agent-tokens').then(r => r.data),
  create: (name: string): Promise<AgentTokenCreated> =>
    api.post('/api/agent-tokens', { name }).then(r => r.data),
  revoke: (id: string) => api.delete(`/api/agent-tokens/${id}`).then(r => r.data),
};

// Devices signed in with `termag login`.
export interface CliDeviceInfo {
  id: string;
  deviceName: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export const cliDevicesApi = {
  list: (): Promise<CliDeviceInfo[]> => api.get('/api/cli-devices').then(r => r.data),
  revoke: (id: string) => api.delete(`/api/cli-devices/${id}`).then(r => r.data),
};

// Laptop SSH public keys, installed on every EC2 box the user owns.
export interface SshKeyInfo {
  id: string;
  type: string;
  bits: number;
  comment: string;
  fingerprint: string;
  createdAt: string;
}

// Box names by outcome of the push that follows a change; null when the
// orchestrator couldn't check. Pending boxes catch up on their agent's next connect.
export interface SshKeyBoxes {
  updated: string[];
  pending: string[];
}

export const sshKeysApi = {
  list: (): Promise<SshKeyInfo[]> => api.get('/api/ssh-keys').then(r => r.data),
  add: (publicKey: string): Promise<SshKeyInfo & { boxes: SshKeyBoxes | null }> =>
    api.post('/api/ssh-keys', { publicKey }).then(r => r.data),
  remove: (id: string): Promise<{ ok: true; boxes: SshKeyBoxes | null }> =>
    api.delete(`/api/ssh-keys/${id}`).then(r => r.data),
};

// Boxes (compute instances). create() with kind "ec2" (default) claims a warm
// box when the flag is on and one is available (`claimed: true`, status already
// ready). Otherwise it kicks off async EC2 provisioning and returns the row at
// `status: provisioning`; poll list() until it goes `ready`/`failed`. create()
// with kind "external" skips AWS and returns the raw token (+ agentWsUrl) once,
// for a self-managed host that the user runs the agent on themselves.
// terminate() may return 409 with the live-projects list when the box still
// has projects; re-send with { confirmed: true }.
export interface InstanceTerminateConflict {
  error: string;
  projects: Array<{ id: string; name: string }>;
  hint: string;
}

export interface InstanceCreated {
  instance: Instance;
  claimed?: boolean;    // true when create() took a warm box already ready
  token?: string;       // present for external (and the legacy no-AWS ec2 path)
  agentWsUrl?: string;  // present for external — the wss://…/ws/agent URL
  hint?: string;
}

export const instancesApi = {
  list: (): Promise<Instance[]> => api.get('/api/instances').then(r => r.data),
  get: (id: string): Promise<Instance> => api.get(`/api/instances/${id}`).then(r => r.data),
  create: (name: string, kind: InstanceKind = 'ec2'): Promise<InstanceCreated> =>
    api.post('/api/instances', { name, kind }).then(r => r.data),
  terminate: (id: string, confirmed = false) =>
    api.delete(`/api/instances/${id}`, { data: { confirmed } }).then(r => r.data),
  // 202 with the transitional status; poll list() until stopped / ready.
  stop: (id: string): Promise<{ ok: true; status: 'stopping' }> =>
    api.post(`/api/instances/${id}/stop`).then(r => r.data),
  start: (id: string): Promise<{ ok: true; status: 'starting' }> =>
    api.post(`/api/instances/${id}/start`).then(r => r.data),
  // 'stopping' when EC2 refused the hibernate and the backend stopped it instead.
  hibernate: (id: string): Promise<{ ok: true; status: 'hibernating' | 'stopping' }> =>
    api.post(`/api/instances/${id}/hibernate`).then(r => r.data),
  // A missing key leaves that setting alone; null turns it off.
  setLifecycle: (
    id: string,
    settings: { idleHibernateHours?: number | null; hibernatedTerminateDays?: number | null },
  ): Promise<{ lifecycle: BoxLifecycle }> =>
    api.patch(`/api/instances/${id}/lifecycle`, settings).then(r => r.data),
  autoTerminated: (): Promise<AutoTerminatedBox[]> =>
    api.get('/api/instances/auto-terminated').then(r => r.data),
  claimTiming: (id: string, ms: number, pickMs?: number | null): Promise<{ ok: true }> =>
    api.post(`/api/instances/${id}/claim-timing`, pickMs == null ? { ms } : { ms, pickMs }).then(r => r.data),
  dismissRepoPrompt: (id: string): Promise<Instance> =>
    api.post(`/api/instances/${id}/repo-prompt-dismiss`).then(r => r.data),
  onClaimLog: (id: string): Promise<{ log: string }> =>
    api.get(`/api/instances/${id}/on-claim-log`).then(r => r.data),
};

// The owner's Claude Code cloud sessions (backend routes/claudeSessions.ts).
// Owner only; nothing here is shared.
export interface CloudSessionsResponse { state: 'active' | 'recent'; days: number; sessions: CloudSession[]; generatedAt: string }
/** One spawn as GET /api/spawns/usage returns it (backend routes/spawns.ts spawnView). */
export interface SpawnNode {
  id: string;
  level: number;
  relationship: 'delegate' | 'peer' | string;
  state: string;
  title: string;
  provider: string;
  depth: number;
  child: { projectId: string | null; projectName: string; workstream: string; session: string; status: string };
  parent: { projectId: string | null; workstream: string | null; session: string } | null;
  /** The child's own report_back: its words, shown to its owner as plain text. */
  report: { status: string; summary: string; refs?: string[]; at: string } | null;
  error: string | null;
  createdAt: string;
  launchedAt: string | null;
  reportedAt: string | null;
  endedAt: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number } | null;
}

export interface SpawnLimitsView {
  maxDepth: number;
  maxOpenChildren: number;
  perHour: number;
  maxConcurrentPerUser: number;
  boxCapacity: number | null;
  hot: { memPct: number; loadPerCore: number; diskPct: number };
}

export interface SpawnUsage {
  budget: {
    limits: SpawnLimitsView;
    used: { depth: number; openHere: number | null; lastHour: number; running: number };
    finishedRunning: number;
    hints: Array<{ kind: string; message: string }>;
  };
  trees: Array<{ rootId: string; createdAt: string; nodes: SpawnNode[] }>;
  /** How many trees there were before the response's cap. */
  treesTotal: number;
  refusals: Array<{ reason: string; count: number }>;
  boxes: Array<{
    id: string; name: string;
    memUsedPct: number | null; diskUsedPct: number | null; loadPerCore: number | null;
    liveAgents: number | null; capacity: number | null; hotMemPct: number; sampledAt: string | null;
    heat: 'ok' | 'warm' | 'hot' | 'unknown'; heatReasons: string[];
    samples: Array<{ at: string; memUsedPct: number | null; loadPerCore: number | null; liveAgents: number | null }>;
  }>;
  days: number;
}

/** Agent spawn. */
export const spawnsApi = {
  usage: (): Promise<SpawnUsage> => api.get('/api/spawns/usage').then(r => r.data),
};

export const claudeSessionsApi = {
  list: (state: 'active' | 'recent' = 'active', days?: number): Promise<CloudSessionsResponse> =>
    api.get('/api/claude-sessions', { params: { state, days } }).then(r => r.data),
  events: (key: string): Promise<{ key: string; events: CloudSessionEvent[] }> =>
    api.get(`/api/claude-sessions/${encodeURIComponent(key)}/events`).then(r => r.data),
  runnerLog: (key: string, lines = 200): Promise<{ key: string; orderId: string; lines: number; log: string }> =>
    api.get(`/api/claude-sessions/${encodeURIComponent(key)}/runner-log`, { params: { lines } }).then(r => r.data),
  /** The owner's title after the fixed "Claude Cloud N" name; null clears it. */
  rename: (key: string, title: string | null): Promise<{ ok: true; key: string; title: string | null; name: string | null }> =>
    api.patch(`/api/claude-sessions/${encodeURIComponent(key)}/title`, { title }).then(r => r.data),
  /** Kills the runner's tmux session by exact name; the session parks on claude.ai and stays resumable. 409 when nothing is live. */
  end: (key: string): Promise<{ ok: true; key: string; orderId: string }> =>
    api.post(`/api/claude-sessions/${encodeURIComponent(key)}/end`).then(r => r.data),
};

export interface WarmPoolStatus {
  target: number;
  warm: number;
  warming: number;
  staleWarm: number;
  failedLastHour: number;
  breakerOpen: boolean;
  specHash: string | null;
}

export const warmPoolApi = {
  get: (): Promise<WarmPoolStatus> =>
    api.get('/api/warm-pool').then(r => r.data),
};

export interface UsageDayData {
  input: number;
  /** Includes reasoning tokens (folded in server-side). */
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Reasoning tokens, tagged separately for a future breakout (pi only). */
  reasoning: number;
  calls: number;
}

// Per-project token usage (server-attributed from each agent's usage-scan). One
// entry per project × workstream. `unattributed` = tokens the backend couldn't
// map to a project (Claude launched outside a project dir, or a host still on
// the old agent — see hosts[].schema === 1). `staleSince` is set when no host
// has reported for a while; the numbers are last-known, not live.
export interface UsageProjectSeries {
  projectId: string;
  name: string;
  color: string | null;
  kind?: string;
  workstream: string;
  days: Record<string, UsageDayData>;
}
export interface UsageHost {
  hostKey: string;
  instanceId: string | null;
  name: string;
  connected: boolean;
  lastScanAt: string | null;
  schema: 1 | 2 | null;
  error?: string;
}
export interface UsageResponse {
  days: Record<string, UsageDayData>;
  providers?: Record<string, Record<string, UsageDayData>>;
  projects?: UsageProjectSeries[];
  unattributed?: Record<string, UsageDayData>;
  hosts?: UsageHost[];
  staleSince?: string | null;
  generatedAt?: string;
}

export const activityApi = {
  heartbeat: (project: string, instanceId?: string | null) =>
    api.post('/api/status/heartbeat', { project, instanceId: instanceId ?? null }).then(r => r.data),
};

// Hyperspace targetWarp sample. Fire-and-forget; the backend rolls samples
// into per-minute buckets, so an occasional dropped sample is fine.
export interface WarpSeries {
  days: Array<{
    date: string;
    meanWarp: number;
    p95: number;
    maxWarp: number;
    activeMinutes: number;
  }>;
  hoursToday: Array<{
    hour: number;
    meanWarp: number;
    maxWarp: number;
    activeMinutes: number;
  }>;
}

export const warpApi = {
  sample: (value: number) =>
    api.post('/api/warp/sample', { value, ts: Date.now() })
      .then(r => r.data)
      .catch(() => { /* fire-and-forget */ }),
  series: (days = 30): Promise<WarpSeries> =>
    api.get('/api/warp/series', { params: { days } }).then(r => r.data),
};

// Per-project context-window occupancy over time. `peakTokens` is the max
// context reached in that day/hour (rolled up across the project's workstreams).
export interface ContextSeries {
  dateAxis: string[]; // 'YYYY-MM-DD', oldest → newest
  projects: Array<{
    projectId: string;
    name: string;
    color: string | null;
    days: Array<{ date: string; peakTokens: number }>;
    hoursToday: Array<{ hour: number; peakTokens: number }>;
  }>;
}

export const contextApi = {
  series: (days = 30): Promise<ContextSeries> =>
    api.get('/api/context/series', { params: { days } }).then(r => r.data),
};

// Project context-switch logger. Uses sendBeacon first so the event still
// fires when the page is closing; falls back to fetch with keepalive so a
// browser that quietly rejects the beacon (mime mismatch, disabled API)
// still gets the event through.
export interface VisitsStats {
  days: Array<{ date: string; switches: number }>;
  totalSwitches: number;
  todaySwitches: number;
  perHourToday: number[];     // 24 entries, index = hour (UTC)
  meanDwellMs: number;
  stdevInterSwitchMs: number;
}

/** One row of "Recents": a (project, workstream) session the user opened, newest first. */
export interface RecentRow {
  projectId: string;
  projectName: string;
  workstream: string;
  owner: string;
  access: 'owner' | 'collaborator';
  instanceId: string | null;
  archived: boolean;
  kind?: 'normal' | 'metaterm';
  color?: string | null;
  lastVisitedAt: string;
  status: 'working' | 'waiting' | 'idle' | 'not_running';
  statusUpdatedAt: string | null;
  /** The project's agent-side last activity (status writes), not the user's visit. */
  lastActiveAt: string;
  provider: string | null;
}

/** Fired on window after a visit is recorded so Recents consumers can refresh. */
export const VISIT_RECORDED_EVENT = 'termag:visit-recorded';

export const visitsApi = {
  record: (body: {
    projectId: string | null;
    previousProjectId: string | null;
    sessionTag?: string;
    workstream?: string | null;
  }) => {
    const url = '/termag/api/visits';
    const json = JSON.stringify(body);
    const notify = () => {
      try { window.dispatchEvent(new CustomEvent(VISIT_RECORDED_EVENT)); } catch { /* ignore */ }
    };
    try {
      const blob = new Blob([json], { type: 'application/json' });
      if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(url, blob)) {
        notify();
        return;
      }
    } catch { /* fall through to fetch */ }
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: json,
    }).then(notify).catch(() => { /* fire-and-forget */ });
  },
  stats: (days = 30): Promise<VisitsStats> =>
    api.get('/api/visits/stats', { params: { days } }).then(r => r.data),
  recent: (limit: number | 'all' = 10): Promise<RecentRow[]> =>
    api.get('/api/visits/recent', { params: { limit } }).then(r => r.data),
};

export const usageApi = {
  get: (): Promise<UsageResponse> =>
    api.get('/api/usage').then(r => r.data),
  // Ask the backend to scan every connected agent now (throttled server-side)
  // and return the fresh payload.
  rescan: (): Promise<UsageResponse & { throttled?: boolean; agentConnected?: boolean }> =>
    api.post('/api/usage/rescan').then(r => r.data),
};

export interface WorktimeDay {
  totalMs: number;
  sessions: number;
}

export interface WorktimeResponse {
  days: Record<string, Record<string, WorktimeDay>>;
}

// Per-project rows behind /api/worktime. `projectId` is null when the banked
// name no longer resolves to a project (renamed/archived). Dates server-local.
export interface WorktimeProjectRow {
  projectId: string | null;
  projectName: string;
  workstream: string;
  provider: string; // provider id, or 'human'
  date: string;
  totalMs: number;
  sessions: number;
}

export interface WorktimeProjectsResponse {
  days: number;
  rows: WorktimeProjectRow[];
}

export const worktimeApi = {
  get: (days = 30): Promise<WorktimeResponse> =>
    api.get('/api/worktime', { params: { days } }).then(r => r.data),
  byProject: (days = 30): Promise<WorktimeProjectsResponse> =>
    api.get('/api/worktime/projects', { params: { days } }).then(r => r.data),
};

// One row per reachable tmux session (own + shared projects × live workstreams
// × roles) with agent connectivity, tmux liveness and the live status. The
// triage fields are lower-bound signals: `updatedAt` is the last status WRITE.
export interface SessionRow {
  projectId: string;
  projectName: string;
  owner: string;
  access: 'owner' | 'collaborator';
  workstream: string;
  role: 'agent' | 'ctrl' | 'data' | 'data-ctrl' | 'review';
  session: string;
  instanceId: string | null;
  connected: boolean;
  alive: boolean;
  status: 'working' | 'waiting' | 'idle' | 'not_running';
  contextTokens: number | null;
  updatedAt: string | null;
  waitingReason: 'approval' | 'user_input' | 'unknown' | null;
  rateLimited: string | null;
  provider: string | null;
  lastActiveAt: string;
  /** "PR opened/merged" awaiting a compact/clear decision; null when none. */
  milestone?: { kind: 'pr_created' | 'pr_merged'; url: string | null; at: string; contextTokens: number | null } | null;
}

/** GET /api/sessions/search. Line text is untrusted pane output: render as text. */
export interface PaneSearchMatch { line: number; text: string; before: string[]; after: string[] }
export interface PaneSearchHit {
  projectId: string; projectName: string; owner: string; access: string;
  workstream: string; role: string; session: string; status: string;
  matchCount: number; matches: PaneSearchMatch[];
}
export interface PaneSearchResult {
  query: string; lines: number; roles: string[];
  searched: number; unreachable: number; skipped: number;
  hits: PaneSearchHit[];
  cached?: boolean;
}

export interface ChatHistory {
  chatKey: string;
  workstream: string;
  sessionId: string | null;
  /** A turn is running on the box now; its events arrive on the status socket. */
  running: boolean;
  queued: number;
  /** The box holds queued messages from before its agent restarted, waiting for this (live) chat to resume them. */
  parked?: boolean;
  /** A repo chat's checkout is there; its first turn waits for it (a pane clone finishes after setup). */
  checkoutReady: boolean;
  /** Claude's transcript entries ({type, message}), oldest first (chat/sdkChat.ts fromHistory). */
  entries: unknown[];
  /** The turn still running, replayed from its own log (a durable runner); its prompt is cut from `entries`. */
  turn?: { turnId: string; events: Array<{ seq: number; event: unknown }> } | null;
}

/** The simple UI's chat on a chat-runner project (backend routes/chat.ts). */
export const chatApi = {
  history: (projectId: string, workstream: string): Promise<ChatHistory> =>
    api.get(`/api/projects/${encodeURIComponent(projectId)}/chat`, { params: { workstream } }).then(r => r.data),
  send: (projectId: string, workstream: string, text: string): Promise<{ queued: boolean; turnId?: string; position?: number }> =>
    api.post(`/api/projects/${encodeURIComponent(projectId)}/chat/messages`, { workstream, text }).then(r => r.data),
  interrupt: (projectId: string, workstream: string): Promise<{ interrupted: boolean; dropped?: string[] }> =>
    api.post(`/api/projects/${encodeURIComponent(projectId)}/chat/interrupt`, { workstream }).then(r => r.data),
};

export const sessionsApi = {
  list: (): Promise<SessionRow[]> => api.get('/api/sessions').then(r => r.data),
  /**
   * Find a phrase in the recent text of every live pane the user may reach
   * (agent, ctrl and review by default), newest mention first. One search per
   * 3 s per caller (429); a repeat inside 15 s is served from the cache.
   * An older backend answers with index.html: check the shape
   * (mobile/paneSearch.ts asPaneSearchResult) before rendering.
   */
  search: (q: string, params: { lines?: number; roles?: string[] } = {}): Promise<PaneSearchResult> =>
    api.get('/api/sessions/search', { params: { q, lines: params.lines, roles: params.roles?.join(',') } }).then(r => r.data),
  /**
   * Type into one of a project's panes, routed through the owner's agent (tmux
   * is per unix user). `keys` is typed literally; `enter` (default true) presses
   * Enter afterwards. Used by the PR context prompt for `/compact` and `/clear`.
   */
  sendKeys: (projectId: string, role: 'agent' | 'ctrl' | 'review', body: { workstream?: string; keys: string; enter?: boolean; literal?: boolean }): Promise<{ ok: true }> =>
    api.post(`/api/projects/${encodeURIComponent(projectId)}/sessions/${role}/send-keys`, body).then(r => r.data),
  /**
   * The last `lines` of one pane as text, routed through the owner's agent.
   * `styled` keeps SGR escapes (tmux -e) so a reader can tell dimmed ghost
   * text from typed text. Rate limited server-side to 1/s per session (429).
   * The phone client renders this as a conversation.
   */
  capture: (projectId: string, role: 'agent' | 'ctrl' | 'review', params: { workstream?: string; lines?: number; styled?: boolean }): Promise<{ session: string; content: string; styled: boolean }> =>
    api.get(`/api/projects/${encodeURIComponent(projectId)}/sessions/${role}/capture`, {
      params: { workstream: params.workstream, lines: params.lines, styled: params.styled ? '1' : undefined },
    }).then(r => r.data),
};

// Agent handoff: the agent writes a handoff, its
// context is cleared or compacted in place or the pane restarts, and the next
// agent starts on the handoff. Progress arrives on the session's status
// (AgentStatus.handoff), not by polling.
export const handoffApi = {
  start: (projectId: string, workstreamId: string, body: { mode: HandoffMode; provider?: string; note?: string; surface?: 'web' | 'mobile' }): Promise<{ handoff: { id: string; mode: HandoffMode; state: string }; note?: string }> =>
    api.post(`/api/projects/${projectId}/workstreams/${workstreamId}/handoff`, body).then(r => r.data),
  abort: (id: string): Promise<{ id: string; state: string }> =>
    api.post(`/api/handoffs/${id}/abort`).then(r => r.data),
};

// The Review button: Devin reviewing a PR in the project's `review` tmux
// session (backend/src/routes/review.ts).
export interface ReviewGuessResponse {
  guess: import('../utils/review').PrGuess | null;
  branch: string | null;
  ghError: string | null;
  /** owner/name of the workstream's GitHub remote; null when there is none or it could not be read (older backends omit it). */
  repo?: string | null;
  /** True when `repo` is definite: a null repo then means no GitHub remote, and a bare PR number is refused. */
  repoKnown?: boolean;
  /** The prompt body the dialog shows before Start (older backends omit it). */
  promptTemplate?: string;
  promptSource?: 'repo' | 'home' | 'builtin';
  /** The template file it came from ("~/.termag-review-prompt.md"), null for the built-in one. */
  promptSourceLabel?: string | null;
  /** Template files that were there but unusable, one line each. */
  promptWarnings?: string[];
  /** The fixed last line (attribution for anything the reviewer posts); shown, not editable. */
  promptFooter?: string;
  /** The review tools on offer (older backends omit it: Devin only). `footer` is that tool's attribution line. */
  reviewers?: Array<{ id: string; name: string; note: string; footer: string }>;
  defaultReviewer?: string;
}

export const reviewApi = {
  guess: (projectId: string, workstream: string): Promise<ReviewGuessResponse> =>
    api.get(`/api/projects/${encodeURIComponent(projectId)}/review/guess`, { params: { workstream } }).then(r => r.data),
  // No `status`: the pane's state rides the agent session's status over /ws/status
  // (written by the review sweep.md); nothing polls GET /review
  // any more. The route stays for on-demand probes and external callers.
  start: (projectId: string, body: { workstream: string; pr: number; url?: string | null; prompt?: string; reviewer?: string }): Promise<{ ok: true; session: string; pr: number; url: string | null; reviewer?: string; startedAt: string }> =>
    api.post(`/api/projects/${encodeURIComponent(projectId)}/review`, body).then(r => r.data),
  stop: (projectId: string, workstream: string): Promise<{ ok: true }> =>
    api.delete(`/api/projects/${encodeURIComponent(projectId)}/review`, { params: { workstream } }).then(r => r.data),
  // Called when the review terminal takes focus while the review is ready:
  // clears the sidebar's ring.
  seen: (projectId: string, workstream: string): Promise<{ ok: true }> =>
    api.post(`/api/projects/${encodeURIComponent(projectId)}/review/seen`, { workstream }).then(r => r.data),
};

export const statusApi = {
  /** Drop a session's "PR opened — compact or clear?" milestone without acting on it. */
  dismissMilestone: (session: string, instanceId?: string | null): Promise<{ ok: true }> =>
    api.post('/api/status/milestone/dismiss', { session, instanceId: instanceId ?? null }).then(r => r.data),
};

export const sharingApi = {
  invite: (projectId: string, inviteeEmail: string) =>
    api.post(`/api/projects/${projectId}/invite`, { inviteeEmail }).then(r => r.data),
  listInvites: (): Promise<ProjectInvite[]> =>
    api.get('/api/invites').then(r => r.data),
  acceptInvite: (inviteId: string) =>
    api.post(`/api/invites/${inviteId}/accept`).then(r => r.data),
  declineInvite: (inviteId: string) =>
    api.post(`/api/invites/${inviteId}/decline`).then(r => r.data),
  listShares: (projectId: string): Promise<ProjectShareInfo[]> =>
    api.get(`/api/projects/${projectId}/shares`).then(r => r.data),
  revokeShare: (projectId: string, shareId: string) =>
    api.delete(`/api/projects/${projectId}/shares/${shareId}`).then(r => r.data),
  leaveProject: (projectId: string) =>
    api.delete(`/api/projects/${projectId}/leave`).then(r => r.data),
};

export const browserApi = {
  getSnapshot: (): Promise<{ windows: ChromeWindow[]; snapshotAt: string | null }> =>
    api.get('/api/browser/snapshot').then(r => r.data),
  getTabs: (projectId: string): Promise<BrowserTab[]> =>
    api.get(`/api/browser/projects/${projectId}/tabs`).then(r => r.data),
  saveTabs: (projectId: string, tabs: Array<{ url: string; title: string; favIcon?: string; windowId?: number }>) =>
    api.post(`/api/browser/projects/${projectId}/tabs`, { tabs }).then(r => r.data),
  deleteTab: (projectId: string, tabId: string) =>
    api.delete(`/api/browser/projects/${projectId}/tabs/${tabId}`).then(r => r.data),
};

// Settings status for brokered credentials. Responses never
// include a credential value.
export interface CredentialsStatus {
  claudeGateway: { available: boolean; enabled: boolean };
  github: {
    available: boolean;
    connected: { label: string; updatedAt: string; orgs: Record<string, OrgAccess> } | null;
    boxGate: BoxGateState;
  };
}

export const credentialsApi = {
  get: (): Promise<CredentialsStatus> => api.get('/api/credentials').then(r => r.data),
  setClaudeGateway: (enabled: boolean): Promise<{ enabled: boolean }> =>
    api.put('/api/credentials/claude-gateway', { enabled }).then(r => r.data),
  connectGithub: (token: string): Promise<{ label: string }> =>
    api.put('/api/credentials/github', { token }).then(r => r.data),
  disconnectGithub: () => api.delete('/api/credentials/github').then(r => r.data),
  recheckGithub: (): Promise<void> => api.post('/api/credentials/github/recheck').then(() => undefined),
};

// The PR pipeline (backend routes/prs.ts): the user's
// pull requests in lanes, read from GitHub with their stored token.
export type PrLaneId =
  | 'in_progress' | 'needs_pr' | 'checks' | 'needs_approval' | 'needs_my_review'
  | 'ready_to_merge' | 'merged_not_deployed' | 'deployed' | 'merged';
export interface PrWorkstreamLink { projectId: string; projectName: string; workstream: string }
export type PrDeployState =
  | { state: 'unknown'; reason: string }
  | { state: 'not_deployed'; baked?: boolean | null }
  | { state: 'orchestrator_only'; boxesBehind: number; boxesUnknown: number; boxes: number }
  | { state: 'deployed'; boxesUnknown: number; boxes: number };
export interface PrRow {
  kind: 'pr' | 'branch';
  lane: PrLaneId;
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  author: string | null;
  headRefName: string;
  baseRefName: string;
  at: string | null;
  badges: string[];
  failingChecks: string[];
  /** Red checks, by name or (names unread) by the rollup alone; absent from older backends. */
  checksFailed?: boolean;
  pendingChecks: string[];
  waitingOn: string[];
  blockedBy: string | null;
  mergedAt: string | null;
  mergeCommit: string | null;
  deploy: PrDeployState | null;
  workstream: PrWorkstreamLink | null;
  /** How `workstream` was found: the live checkout, or a stored link (backend services/workstreamPrs.ts); absent from older backends. */
  linkedBy?: 'checkout' | 'created' | 'branch' | 'manual' | null;
  requestedAt: string | null;
  reviewTarget: PrWorkstreamLink | null;
}
export interface PrLane { id: PrLaneId; label: string; rows: PrRow[] }
export interface PrCheckout { projectId: string; workstream: string; repo: string }
export interface PrEarlier { repo: string; number: number; workstream: PrWorkstreamLink; at: string | null }
export type PrPipelineResponse =
  | { connected: false }
  | {
      connected: true;
      viewer: string;
      lanes: PrLane[];
      prod: { sha: string | null; source: 'env' | 'git' | 'baked' | 'unknown' };
      boxes: number;
      /** Between merge and prod: the newest orchestrator image, and Publish AMI runs in flight (null: not asked). */
      deploy?: PrDeployPipeline;
      /** The Deployed and Merged lanes cover merges from this many days back (absent from an older backend). */
      mergedWindowDays?: number;
      fetchedAt: string;
      notes: string[];
      /** Which repository each workstream is a checkout of, when its box said; absent from older backends. */
      checkouts?: PrCheckout[];
      /** Rows the user deferred, by overlay row key (absent from an older backend). */
      deferred?: PrDeferral[];
      /** Stored workstream links whose PR no lane lists (backend services/workstreamPrs.ts earlierLinks); absent from older backends. */
      earlier?: PrEarlier[];
    };
/** A row put off until `until` (ISO): out of "Needs you" and the PRs tile till then. */
export interface PrDeferral { key: string; until: string }
export interface PrBakeRun { url: string; status: string; event: string; createdAt: string | null }
export interface PrDeployPipeline {
  image: { sha: string | null; createdAt: string | null } | null;
  bakes: PrBakeRun[] | null;
  workflowUrl: string;
}
export interface PrFile { path: string; additions: number; deletions: number; changeType: string }
export interface PrReviewSummary { author: string | null; state: string; submittedAt: string | null }
/** One PR up close (backend services/prReview.ts), for a row's overview. */
export interface PrOverview {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  viewer: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  body: string;
  createdAt: string | null;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  mergeable: string;
  checkRollup: string | null;
  checks: { name: string; state: 'pending' | 'failed' | 'passed' }[];
  requestedReviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PrFile[];
  filesTruncated: boolean;
  reviews: PrReviewSummary[];
  viewerReview: PrReviewSummary | null;
  viewerCanReview: boolean;
  mergeStateStatus: string;
  autoMerge: boolean;
  nodeId: string | null;
  headSha: string | null;
  autoMergeMethod: PrMergeMethod | null;
  mergeSettings: { methods: PrMergeMethod[]; defaultMethod: PrMergeMethod | null; autoMergeAllowed: boolean };
  viewerCanMerge: boolean;
  /** The head commit's failed suites: Actions runs termag can re-run, other apps it cannot. */
  failedSuites: { runs: { runId: number; workflow: string }[]; other: string[] };
  requestedUsers: string[];
  requestedTeams: string[];
}
export interface PrRerunResult {
  rerun: { runId: number; workflow: string }[];
  refused: { runId: number; workflow: string; error: string }[];
  other: string[];
}
export type PrMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';
export type PrMergeRequest =
  | { mode: 'now'; method: PrMergeMethod; sha: string }
  | { mode: 'auto'; method: PrMergeMethod }
  | { mode: 'cancel_auto' };
export interface PrMergeResult { merged: boolean; sha: string | null; autoMerge: boolean; message: string | null }
export type PrReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
const prPath = (repo: string, number: number) => {
  const [owner, name] = repo.split('/');
  return `/api/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`;
};
export const prsApi = {
  list: (): Promise<PrPipelineResponse> => api.get('/api/prs').then(r => r.data),
  /** Bakes main's orchestrator image; the bake deploys itself (publish-ami.yml). */
  bake: (): Promise<{ ok: true; workflowUrl: string }> => api.post('/api/prs/bake').then(r => r.data),
  /** Defers a row (its rowParam key) for `days`; deferring a deferred row adds the days to its end. */
  defer: (key: string, days = 1): Promise<PrDeferral> => api.put('/api/prs/deferrals', { key, days }).then(r => r.data),
  /** Brings a deferred row back. */
  undefer: (key: string): Promise<void> => api.delete('/api/prs/deferrals', { params: { key } }).then(() => undefined),
  /** Attaches a PR to one of the user's workstreams, until changed by hand. */
  link: (repo: string, number: number, projectId: string, workstream: string): Promise<{ ok: true }> =>
    api.put('/api/prs/links', { repo, number, projectId, workstream }).then(r => r.data),
  /** A new workstream on the PR's own branch, attached to it (the agent checks out pull/<n>/head, or adopts its worktree). */
  newWorkstream: (repo: string, number: number, projectId: string, name: string): Promise<{ id: string; name: string; branch: string; sessionLaunchWarnings?: string[] }> =>
    api.post(`${prPath(repo, number)}/workstream`, { projectId, name }, { timeout: 630_000 }).then(r => r.data),
  /** Drops a PR's stored workstream link. */
  unlink: (repo: string, number: number): Promise<void> => api.delete('/api/prs/links', { params: { repo, number } }).then(() => undefined),
  overview: (repo: string, number: number): Promise<PrOverview> => api.get(prPath(repo, number)).then(r => r.data),
  /** Submits the user's own review on GitHub, with their stored token. */
  review: (repo: string, number: number, event: PrReviewEvent, body: string): Promise<{ id: number | null; state: string | null; url: string | null }> =>
    api.post(`${prPath(repo, number)}/review`, { event, body }).then(r => r.data),
  /** Merges now (pinned to the head commit shown), or turns auto-merge on or off, as the user. */
  merge: (repo: string, number: number, req: PrMergeRequest): Promise<PrMergeResult> =>
    api.post(`${prPath(repo, number)}/merge`, req).then(r => r.data),
  /** Re-runs the failed jobs of the head commit's failed Actions runs. */
  rerunFailed: (repo: string, number: number): Promise<PrRerunResult> =>
    api.post(`${prPath(repo, number)}/rerun-failed`).then(r => r.data),
  /** Requests (or re-requests) reviews; GitHub notifies each reviewer. */
  requestReviewers: (repo: string, number: number, users: string[], teams: string[]): Promise<{ users: string[]; teams: string[] }> =>
    api.post(`${prPath(repo, number)}/reviewers`, { users, teams }).then(r => r.data),
  /** Posts a conversation comment on the PR, as the user. */
  comment: (repo: string, number: number, body: string): Promise<{ url: string | null }> =>
    api.post(`${prPath(repo, number)}/comment`, { body }).then(r => r.data),
};

// ── Daily briefing ──────────────────────────────────
// Mirrors backend/src/services/briefing/types.ts.

export interface BriefingContent {
  summary: string;
  carryovers: Array<{
    projectId: string | null;
    workstream: string | null;
    kind: 'question' | 'decision' | 'action' | 'blocked';
    title: string;
    detail: string;
    evidence: 'transcript' | 'todo' | 'status' | 'pr' | 'git' | 'cloud' | 'pane';
  }>;
  suggestions: Array<{
    projectId: string | null;
    workstream: string | null;
    text: string;
    why: string;
  }>;
}

export interface LedgerTotals {
  agentMs: number;
  humanMs: number;
  tokens: number;
  sessionsTouched: number;
  switches: number;
  waitingNow: number;
  prsNeedingAttention: number;
  keptCheckouts: number;
  offlineBoxes: number;
}

export type BriefingStatus = 'running' | 'done' | 'failed' | 'skipped';

export interface BriefingView {
  id: string;
  trigger: 'manual' | 'schedule' | 'slack';
  status: BriefingStatus;
  error: string | null;
  /** basis: how the window was chosen (backend services/briefing/window.ts); absent on older rows. */
  window: { since: string; until: string; tz: string; label: string; basis?: 'since_last' | 'first' | 'stale' | 'capped' | 'explicit' };
  boxName: string | null;
  content: BriefingContent | null;
  stats: LedgerTotals | null;
  projects: Record<string, { name: string; archived: boolean }>;
  createdAt: string;
  finishedAt: string | null;
}

export interface BriefingLatest {
  /** Newest done briefing. */
  latest: BriefingView | null;
  /** Newest row newer than `latest` that is running, failed or skipped. */
  pending: BriefingView | null;
}

export interface BriefingSchedule {
  enabled: boolean;
  /** Local "HH:MM", 24-hour. */
  time: string;
  timezone: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  slackDm: boolean;
}

export const briefingsApi = {
  latest: (): Promise<BriefingLatest> => api.get('/api/briefings/latest').then(r => r.data),
  list: (limit = 20): Promise<{ briefings: BriefingView[] }> =>
    api.get('/api/briefings', { params: { limit } }).then(r => r.data),
  run: (tz: string): Promise<BriefingView> => api.post('/api/briefings/run', { tz }).then(r => r.data),
  schedule: (): Promise<BriefingSchedule> => api.get('/api/briefings/schedule').then(r => r.data),
  saveSchedule: (s: BriefingSchedule): Promise<BriefingSchedule> =>
    api.put('/api/briefings/schedule', s).then(r => r.data),
};

// Spaces: shared file stores across boxes (backend routes/spaces.ts,
// docs/spaces.md). Every route answers 404 while the spaces-enabled flag is
// off for the user. Bytes never pass through here: these return presigned S3
// URLs that the browser uses directly.
export interface SpaceView {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  usedBytes: number;
  quotaBytes: number;
  role?: 'owner' | 'editor' | 'viewer';
  readOnly?: boolean;
}
export interface SpaceTreeDir { name: string; path: string }
export interface SpaceTreeFile { name: string; path: string; size: number; modifiedAt: string | null; etag?: string }
export interface SpaceTree { prefix: string; dirs: SpaceTreeDir[]; files: SpaceTreeFile[]; nextCursor: string | null }
export interface SpaceMember { userId: string; email: string; displayName: string; role: 'owner' | 'editor' | 'viewer'; addedAt: string }
export interface SpaceInvite { id: string; email: string; role: 'owner' | 'editor' | 'viewer'; addedAt: string }
export interface SpaceBoxGrant {
  id: string;
  name: string;
  kind: string;
  status: string;
  ownerEmail: string | null;
  mine: boolean;
  /** Boxes that reach the space through this one. */
  children: Array<{ id: string; name: string; via: string }>;
}
export interface SpaceEvent {
  id: string;
  at: string;
  action: string;
  path: string | null;
  bytes: number | null;
  actorUserId: string | null;
  actorInstanceId: string | null;
  via: string | null;
}
export interface SpaceSignedUrl { url: string; expiresAt: string; size: number; contentType: string | null }
export type SpaceUploadStart =
  | { kind: 'single'; path: string; method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: string }
  | { kind: 'multipart'; path: string; uploadId: string; partBytes: number; partCount: number };

const sp = (space: string) => `/api/spaces/${encodeURIComponent(space)}`;

export const spacesApi = {
  list: (): Promise<{ spaces: SpaceView[] }> => api.get('/api/spaces').then(r => r.data),
  create: (name: string, description?: string): Promise<{ space: SpaceView }> =>
    api.post('/api/spaces', { name, description }).then(r => r.data),
  update: (space: string, patch: { name?: string; description?: string | null }): Promise<{ space: SpaceView }> =>
    api.patch(sp(space), patch).then(r => r.data),
  remove: (space: string): Promise<{ ok: true }> => api.delete(sp(space)).then(r => r.data),

  members: (space: string): Promise<{ members: SpaceMember[]; invites: SpaceInvite[] }> =>
    api.get(`${sp(space)}/members`).then(r => r.data),
  addMember: (space: string, email: string, role: string): Promise<{ member?: SpaceMember; invite?: SpaceInvite }> =>
    api.post(`${sp(space)}/members`, { email, role }).then(r => r.data),
  setRole: (space: string, userId: string, role: string): Promise<{ ok: true }> =>
    api.patch(`${sp(space)}/members/${encodeURIComponent(userId)}`, { role }).then(r => r.data),
  removeMember: (space: string, userId: string): Promise<{ ok: true; removedBoxes: number }> =>
    api.delete(`${sp(space)}/members/${encodeURIComponent(userId)}`).then(r => r.data),
  removeInvite: (space: string, inviteId: string): Promise<{ ok: true }> =>
    api.delete(`${sp(space)}/invites/${encodeURIComponent(inviteId)}`).then(r => r.data),

  boxes: (space: string): Promise<{ boxes: SpaceBoxGrant[] }> => api.get(`${sp(space)}/boxes`).then(r => r.data),
  addBox: (space: string, box: string): Promise<{ box: { id: string; name: string } }> =>
    api.post(`${sp(space)}/boxes`, { box }).then(r => r.data),
  removeBox: (space: string, instanceId: string): Promise<{ ok: true }> =>
    api.delete(`${sp(space)}/boxes/${encodeURIComponent(instanceId)}`).then(r => r.data),

  tree: (space: string, prefix: string, cursor?: string | null): Promise<SpaceTree> =>
    api.get(`${sp(space)}/tree`, { params: { prefix, ...(cursor ? { cursor } : {}) } }).then(r => r.data),
  download: (space: string, path: string, inline = false): Promise<SpaceSignedUrl> =>
    api.post(`${sp(space)}/files/download`, { path, inline }).then(r => r.data),
  startUpload: (space: string, path: string, size: number, contentType: string): Promise<SpaceUploadStart> =>
    api.post(`${sp(space)}/files/upload`, { path, size, contentType }).then(r => r.data),
  uploaded: (space: string, path: string): Promise<{ ok: true; size: number }> =>
    api.post(`${sp(space)}/files/uploaded`, { path }).then(r => r.data),
  partUrls: (space: string, uploadId: string, path: string, size: number, partNumbers: number[]): Promise<{ parts: Array<{ partNumber: number; url: string }> }> =>
    api.post(`${sp(space)}/uploads/${encodeURIComponent(uploadId)}/parts`, { path, size, partNumbers }).then(r => r.data),
  completeUpload: (space: string, uploadId: string, path: string, parts: Array<{ partNumber: number; etag: string }>): Promise<{ ok: true; size: number }> =>
    api.post(`${sp(space)}/uploads/${encodeURIComponent(uploadId)}/complete`, { path, parts }).then(r => r.data),
  abortUpload: (space: string, uploadId: string, path: string): Promise<{ ok: true }> =>
    api.delete(`${sp(space)}/uploads/${encodeURIComponent(uploadId)}`, { params: { path } }).then(r => r.data),
  move: (space: string, from: string, to: string): Promise<{ ok: boolean; moved: number; failed: string[] }> =>
    api.post(`${sp(space)}/files/move`, { from, to }).then(r => r.data),
  removeFiles: (space: string, path: string, recursive = false): Promise<{ ok: boolean; deleted: number; failed: string[] }> =>
    api.delete(`${sp(space)}/files`, { params: { path, ...(recursive ? { recursive: '1' } : {}) } }).then(r => r.data),

  events: (space: string, limit = 100): Promise<{ events: SpaceEvent[] }> =>
    api.get(`${sp(space)}/events`, { params: { limit } }).then(r => r.data),
};
