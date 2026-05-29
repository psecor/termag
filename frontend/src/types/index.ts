export interface User {
  id: string;
  email: string;
  displayName: string;
  unixUsername: string;
  defaultAgentProvider: AgentProvider;
}

export type WorkflowType = 'agent' | 'data';
export type AgentProvider = string;

export interface Workflow {
  id: string;
  type: WorkflowType;
  provider?: AgentProvider | null;
  server: string;
  projectId: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  archived: boolean;
  pinned?: boolean;
  lastActiveAt?: string;
  workflows: Workflow[];
  ownerUsername?: string;
  role?: 'owner' | 'collaborator';
}

export type InstanceStatus = 'provisioning' | 'awaiting-agent' | 'ready' | 'failed' | 'terminated';

export type InstanceKind = 'ec2' | 'external';

export interface Instance {
  id: string;
  name: string;
  kind: InstanceKind;
  status: InstanceStatus;
  ec2InstanceId?: string | null;
  region?: string | null;
  hostname?: string | null;
  provisioningError?: string | null;
  createdAt: string;
  lastConnectedAt?: string | null;
  _count?: { projects: number };
  // Only present on the single-box (getOne) response, used for delete-confirm.
  projects?: Array<{ id: string; name: string }>;
}

export interface ProjectInvite {
  id: string;
  projectName: string;
  inviterName: string;
  inviterUsername: string;
  createdAt: string;
}

export interface ProjectShareInfo {
  id: string;
  userName: string;
  userEmail: string;
  unixUsername: string;
  createdAt: string;
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
  source?: string;
  waitingReason?: 'approval' | 'user_input' | 'unknown' | null;
  activityScore?: number;
  tokenBurst?: number;
  activeTurn?: boolean;
  threadId?: string;
  pollerMeta?: Record<string, any>;
  contextTokens?: number;
  rateLimited?: string | null;
}

// Keyed by tmux session name
export type StatusMap = Record<string, AgentStatus>;

export const STATUS_EMOJI: Record<AgentStatusValue, string> = {
  working: '🟢',
  waiting: '🟡',
  idle: '🔴',
  not_running: '💤',
};
