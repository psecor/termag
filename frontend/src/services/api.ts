import axios from 'axios';
import { Project, BrowserTab, ChromeWindow, WorkflowType, AgentProvider, User } from '../types';

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
    initialAgent?: { enabled: boolean; provider: AgentProvider };
  }) =>
    api.post('/api/projects', data).then(r => r.data),
  update: (id: string, data: Partial<{ name: string; description: string; color: string }>) =>
    api.put(`/api/projects/${id}`, data).then(r => r.data),
  rename: (id: string, name: string): Promise<Project> =>
    api.post(`/api/projects/${id}/rename`, { name }).then(r => r.data),
  archive: (id: string) =>
    api.post(`/api/projects/${id}/archive`).then(r => r.data),
  addWorkflow: (projectId: string, type: WorkflowType, provider?: AgentProvider) =>
    api.post(`/api/projects/${projectId}/workflows`, { type, provider }).then(r => r.data),
  removeWorkflow: (projectId: string, type: WorkflowType) =>
    api.delete(`/api/projects/${projectId}/workflows/${type}`).then(r => r.data),
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
