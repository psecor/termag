import axios from 'axios';
import { Project, BrowserTab, ChromeWindow, WorkflowType, AgentProvider, User, ProjectInvite, ProjectShareInfo, Instance, InstanceKind, Workstream } from '../types';

const api = axios.create({
  baseURL: '/termag',
  withCredentials: true,
});

export const authApi = {
  me: (): Promise<User> => api.get('/auth/me').then(r => r.data),
  logout: () => api.post('/auth/logout').then(r => r.data),
  updatePreferences: (data: { defaultAgentProvider: AgentProvider }): Promise<User> =>
    api.put('/auth/me/preferences', data).then(r => r.data),
  loginUrl: () => '/termag/auth/google',
};

export const projectsApi = {
  list: (): Promise<Project[]> => api.get('/api/projects').then(r => r.data),
  create: (data: {
    name: string;
    description?: string;
    color?: string;
    instanceId?: string | null;
    initialAgent?: { enabled: boolean; provider: AgentProvider };
  }) =>
    api.post('/api/projects', data).then(r => r.data),
  update: (id: string, data: Partial<{ name: string; description: string; color: string }>) =>
    api.put(`/api/projects/${id}`, data).then(r => r.data),
  rename: (id: string, name: string): Promise<Project> =>
    api.post(`/api/projects/${id}/rename`, { name }).then(r => r.data),
  togglePin: (id: string): Promise<{ pinned: boolean }> =>
    api.post(`/api/projects/${id}/pin`).then(r => r.data),
  archive: (id: string) =>
    api.post(`/api/projects/${id}/archive`).then(r => r.data),
  addWorkflow: (projectId: string, type: WorkflowType, provider?: AgentProvider) =>
    api.post(`/api/projects/${projectId}/workflows`, { type, provider }).then(r => r.data),
  removeWorkflow: (projectId: string, type: WorkflowType) =>
    api.delete(`/api/projects/${projectId}/workflows/${type}`).then(r => r.data),
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

// Boxes (compute instances). create() with kind "ec2" (default) kicks off async
// EC2 provisioning and returns the row at `status: provisioning`; poll list()
// until it goes `ready`/`failed`. create() with kind "external" skips AWS and
// returns the raw token (+ agentWsUrl) once, for a self-managed host that the
// user runs the agent on themselves. terminate() may return 409 with the
// live-projects list when the box still has projects — re-send with
// { confirmed: true }.
export interface InstanceTerminateConflict {
  error: string;
  projects: Array<{ id: string; name: string }>;
  hint: string;
}

export interface InstanceCreated {
  instance: Instance;
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
};

export interface UsageDayData {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  calls: number;
}

export interface UsageResponse {
  days: Record<string, UsageDayData>;
  providers?: Record<string, Record<string, UsageDayData>>;
}

export const activityApi = {
  heartbeat: (project: string) =>
    api.post('/api/status/heartbeat', { project }).then(r => r.data),
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

export const visitsApi = {
  record: (body: {
    projectId: string | null;
    previousProjectId: string | null;
    sessionTag?: string;
  }) => {
    const url = '/termag/api/visits';
    const json = JSON.stringify(body);
    try {
      const blob = new Blob([json], { type: 'application/json' });
      if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(url, blob)) {
        return;
      }
    } catch { /* fall through to fetch */ }
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: json,
    }).catch(() => { /* fire-and-forget */ });
  },
  stats: (days = 30): Promise<VisitsStats> =>
    api.get('/api/visits/stats', { params: { days } }).then(r => r.data),
};

export const usageApi = {
  get: (): Promise<UsageResponse> =>
    api.get('/api/usage').then(r => r.data),
};

export interface WorktimeDay {
  totalMs: number;
  sessions: number;
}

export interface WorktimeResponse {
  days: Record<string, Record<string, WorktimeDay>>;
}

export const worktimeApi = {
  get: (days = 30): Promise<WorktimeResponse> =>
    api.get('/api/worktime', { params: { days } }).then(r => r.data),
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
