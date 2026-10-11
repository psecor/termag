import axios from 'axios';
import { connectionTracker } from '../utils/connectionTracker';
import type { ThemeSettings } from '../theme/schema';
import type { OrgAccess } from '../pages/settings/githubOrgCopy';
import { Project, BrowserTab, ChromeWindow, WorkflowType, AgentProvider, User, ProjectInvite, ProjectShareInfo, Instance, InstanceKind, Workstream, CloudSession, CloudSessionEvent } from '../types';
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

export const sessionsApi = {
  list: (): Promise<SessionRow[]> => api.get('/api/sessions').then(r => r.data),
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

// The Review button: Devin reviewing a PR in the project's `review` tmux
// session (backend/src/routes/review.ts).
export interface ReviewGuessResponse {
  guess: import('../utils/review').PrGuess | null;
  branch: string | null;
  ghError: string | null;
}

export const reviewApi = {
  guess: (projectId: string, workstream: string): Promise<ReviewGuessResponse> =>
    api.get(`/api/projects/${encodeURIComponent(projectId)}/review/guess`, { params: { workstream } }).then(r => r.data),
  // No `status`: the pane's state rides the agent session's status over /ws/status
  // (written by the review sweep.md); nothing polls GET /review
  // any more. The route stays for on-demand probes and external callers.
  start: (projectId: string, body: { workstream: string; pr: number; url?: string | null }): Promise<{ ok: true; session: string; pr: number; url: string | null; startedAt: string }> =>
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
  | { state: 'not_deployed' }
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
  pendingChecks: string[];
  waitingOn: string[];
  blockedBy: string | null;
  mergedAt: string | null;
  mergeCommit: string | null;
  deploy: PrDeployState | null;
  workstream: PrWorkstreamLink | null;
  requestedAt: string | null;
  reviewTarget: PrWorkstreamLink | null;
}
export interface PrLane { id: PrLaneId; label: string; rows: PrRow[] }
export type PrPipelineResponse =
  | { connected: false }
  | {
      connected: true;
      viewer: string;
      lanes: PrLane[];
      prod: { sha: string | null; source: 'env' | 'git' | 'baked' | 'unknown' };
      boxes: number;
      fetchedAt: string;
      notes: string[];
    };
export const prsApi = {
  list: (): Promise<PrPipelineResponse> => api.get('/api/prs').then(r => r.data),
};
