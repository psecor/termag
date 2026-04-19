export interface User {
  id: string;
  email: string;
  displayName: string;
  unixUsername: string;
}

export type WorkflowType = 'agent' | 'data';

export interface Workflow {
  id: string;
  type: WorkflowType;
  server: string;
  projectId: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  archived: boolean;
  workflows: Workflow[];
}



export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favIcon?: string;
  windowId?: number;
}

export interface ChromeWindow {
  windowId: number;
  tabs: Array<{ url: string; title: string; favIcon?: string }>;
}

export type AgentStatusValue = 'working' | 'waiting' | 'idle' | 'not_running';

export interface AgentStatus {
  status: AgentStatusValue;
  updatedAt: string;
  message?: string;
}

// Keyed by tmux session name
export type StatusMap = Record<string, AgentStatus>;

export const STATUS_EMOJI: Record<AgentStatusValue, string> = {
  working: '🟢',
  waiting: '🟡',
  idle: '🔴',
  not_running: '💤',
};
