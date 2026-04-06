import axios from 'axios';
import { Project, WorkTerminal, BrowserTab, ChromeWindow, WorkflowType } from '../types';

const api = axios.create({
  baseURL: '/termag',
  withCredentials: true,
});

export const authApi = {
  me: () => api.get('/auth/me').then(r => r.data),
  logout: () => api.post('/auth/logout').then(r => r.data),
  loginUrl: () => '/termag/auth/google',
};

export const projectsApi = {
  list: (): Promise<Project[]> => api.get('/api/projects').then(r => r.data),
  create: (data: { name: string; description?: string; color?: string }) =>
    api.post('/api/projects', data).then(r => r.data),
  update: (id: string, data: Partial<{ name: string; description: string; color: string }>) =>
    api.put(`/api/projects/${id}`, data).then(r => r.data),
  archive: (id: string) =>
    api.post(`/api/projects/${id}/archive`).then(r => r.data),
  addWorkflow: (projectId: string, type: WorkflowType) =>
    api.post(`/api/projects/${projectId}/workflows`, { type }).then(r => r.data),
  removeWorkflow: (projectId: string, type: WorkflowType) =>
    api.delete(`/api/projects/${projectId}/workflows/${type}`).then(r => r.data),
};

export const workTerminalsApi = {
  list: (): Promise<WorkTerminal[]> => api.get('/api/work-terminals').then(r => r.data),
  create: (name: string, sortOrder?: number) =>
    api.post('/api/work-terminals', { name, sortOrder }).then(r => r.data),
  remove: (id: string) => api.delete(`/api/work-terminals/${id}`).then(r => r.data),
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
