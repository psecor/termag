// Mirrors frontend/src/types/index.ts and the SessionRow in
// frontend/src/services/api.ts. Kept as a copy on purpose: the TUI is a
// separate package and must not drag the React frontend into its build.

export type WorkflowType = 'agent' | 'data';
export type Role = 'agent' | 'ctrl' | 'data' | 'data-ctrl';
export type AgentStatusValue = 'working' | 'waiting' | 'idle' | 'not_running';

export interface Workflow {
  id: string;
  type: WorkflowType;
  provider?: string | null;
  server: string;
  projectId: string;
  workstreamId?: string;
}

export interface Workstream {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  archived: boolean;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  archived: boolean;
  pinned?: boolean;
  lastActiveAt?: string;
  instanceId?: string | null;
  workflows: Workflow[];
  workstreams: Workstream[];
  ownerUsername?: string;
  role?: 'owner' | 'collaborator';
  kind?: 'normal' | 'metaterm';
}

/** One row per reachable tmux session — GET /api/sessions. */
export interface SessionRow {
  projectId: string;
  projectName: string;
  owner: string;
  access: 'owner' | 'collaborator';
  workstream: string;
  role: Role;
  session: string;
  instanceId: string | null;
  connected: boolean;
  alive: boolean;
  status: AgentStatusValue;
  contextTokens: number | null;
  updatedAt: string | null;
  waitingReason: 'approval' | 'user_input' | 'unknown' | null;
  rateLimited: string | null;
  provider: string | null;
  lastActiveAt: string;
}

export interface CaptureResponse {
  session: string;
  content: string;
  styled?: boolean;
}
