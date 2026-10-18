// Mirrors frontend/src/types/index.ts and the SessionRow in
// frontend/src/services/api.ts. Kept as a copy on purpose: the TUI is a
// separate package and must not drag the React frontend into its build.

export type WorkflowType = 'agent' | 'data';
export type Role = 'agent' | 'ctrl' | 'data' | 'data-ctrl' | 'review';
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
  /** On an agent row: the state of the workstream's Devin review (the web's review ring); absent from older backends. */
  reviewState?: 'reviewing' | 'waiting' | 'done' | 'exited' | null;
}

export interface CaptureResponse {
  session: string;
  content: string;
  styled?: boolean;
}

/** GET /api/cli/v1/whoami (backend/src/routes/cliApi.ts). */
export interface Whoami {
  user: { email: string; unixUsername: string; displayName: string };
  credential:
    | { kind: 'device'; deviceName: string; expiresAt: string; maxExpiresAt: string }
    | { kind: 'box'; boxId: string | null };
}
