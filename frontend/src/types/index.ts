import type { ThemeSettings } from '../theme/schema';

export interface User {
  id: string;
  email: string;
  displayName: string;
  unixUsername: string;
  defaultAgentProvider: AgentProvider;
  dotfilesRepoUrl: string | null;
  theme: ThemeSettings;
  /** Effective role from /auth/me; drives the admin nav entry only (the server re-checks). */
  role?: 'admin' | 'member';
  /** When the first-run wizard was finished or skipped; null = never. */
  onboardedAt?: string | null;
  /** From /auth/me only: never onboarded AND no projects yet → send to /welcome. */
  needsOnboarding?: boolean;
}

export type WorkflowType = 'agent' | 'data';

export const SETUP_STATUSES = ['none', 'pending', 'cloning', 'ready', 'failed'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];
export type AgentProvider = string;

export interface Workflow {
  id: string;
  type: WorkflowType;
  provider?: AgentProvider | null;
  server: string;
  projectId: string;
  workstreamId?: string;
}

export interface Workstream {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  slackChannelId?: string | null;
  archived: boolean;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  archived: boolean;
  pinned?: boolean;
  lastActiveAt?: string;
  instanceId?: string | null;
  repoUrl?: string | null;
  repoDefaultBranch?: string | null;
  setupStatus?: SetupStatus | null;
  setupError?: string | null;
  workflows: Workflow[];
  workstreams: Workstream[];
  ownerUsername?: string;
  role?: 'owner' | 'collaborator';
  // 'metaterm' = the per-user pinned control-tower singleton; absent/'normal' otherwise.
  kind?: 'normal' | 'metaterm';
}

export type InstanceStatus =
  | 'provisioning' | 'awaiting-agent' | 'warming' | 'warm' | 'ready'
  | 'stopping' | 'stopped' | 'starting' | 'hibernating' | 'hibernated' | 'failed' | 'terminated';

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
  // The agent's first connect; readyAt - createdAt is the box's cold boot time.
  readyAt?: string | null;
  lastConnectedAt?: string | null;
  claimedAt?: string | null;
  onClaimStatus?: string | null;
  onClaimError?: string | null;
  hostUnixUser?: string | null;
  // The AMI the box launched from, and how the box-image flag chose it:
  // published, channel:<name>, pinned, or fallback:<what was asked>.
  imageId?: string | null;
  imageSource?: string | null;
  // Fixed at launch: only boxes launched hibernation-capable can hibernate.
  hibernationConfigured?: boolean;
  hibernatedAt?: string | null;
  // The 60-day refresh resumed this box and will hibernate it again.
  rehibernatePending?: boolean;
  repoPromptDismissedAt?: string | null;
  // Automatic lifecycle; on the list response only.
  lifecycle?: BoxLifecycle;
  _count?: { projects: number };
  // Only present on the single-box (getOne) response, used for delete-confirm.
  projects?: Array<{ id: string; name: string }>;
}

export interface BoxLifecycle {
  canAutoHibernate: boolean;
  idleHibernateHours: number | null;
  hibernatedTerminateDays: number | null;
  hibernateDueAt: string | null;
  terminateDueAt: string | null;
  parkedAt: string | null;
  // Only on a parked box: 'clean' keeps its own terminate limit, the others wait the long one.
  unsavedWork: 'clean' | 'unsaved' | 'unknown' | null;
  note: string | null;
  // Set when the setting is on but the box can't hibernate, so it never fires.
  warning: string | null;
}

// A box the lifecycle sweep terminated in the last 7 days.
export interface AutoTerminatedBox {
  id: string;
  name: string;
  autoTerminatedAt: string;
  lifecycleNote: string | null;
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

// Claude Code cloud sessions on the owner's boxes.
// Mirrors backend/src/services/claudeSessions.ts, CloudSessionView.
export type CloudSessionState = 'queued' | 'starting' | 'running' | 'ended' | 'lost';

export interface CloudSessionRun {
  orderId: string;
  instanceId: string;
  boxName: string;
  slot: number;
  /** The runner's tmux session on the box: the status map key with instanceId. */
  sessionName: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  exitStatus: number | null;
  exitReason: string | null;
  /** true: the runner's tmux session is live; false: gone; null: the box did not answer. */
  alive: boolean | null;
  /** Token usage the session posted about itself (cumulative); null until the first post. */
  usage: CloudRunUsage | null;
  /** The session directory's size when it ended, and whether the checkout was kept for unpushed work. */
  checkoutBytes: number | null;
  kept: boolean | null;
}

export interface CloudRunUsage {
  input: number; output: number; cacheRead: number; cacheCreate: number; total: number;
  calls: number | null; model: string | null; at: string;
}

export interface CloudSession {
  /** The Anthropic session id, or `order:<id>` for a run from before session ids were kept. */
  key: string;
  sessionId: string | null;
  url: string | null;
  /** The session's ordinal among the owner's sessions. */
  seq: number | null;
  /** "Claude Cloud 3": every session's fixed name; the prompt or owner title is separate. */
  name: string;
  title: string | null;
  clientPlatform: string | null;
  state: CloudSessionState;
  exitReason: string | null;
  queuedReason: string | null;
  /** For `queued`: when the current unbroken run of refusals began. */
  queuedSince: string | null;
  current: CloudSessionRun | null;
  runs: CloudSessionRun[];
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
}

export interface CloudSessionEvent {
  sessionId: string;
  orderId: string;
  instanceId: string | null;
  kind: string;
  detail: string | null;
  at: string;
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
  /** When the agent last came to rest (working/waiting → idle/not_running); ISO. Drives the unseen-stop marker. */
  stoppedAt?: string | null;
  /** "Just opened/merged a PR" — the natural moment to compact or clear context. */
  milestone?: SessionMilestone | null;
  /**
   * A Devin review pane's live state, written by the backend's review sweep
   * (services/reviewSweep.ts) and pushed over /ws/status
   *. Null/absent = no review pane for this session.
   */
  review?: SessionReview | null;
  /**
   * A handoff of this agent pane in flight or just finished, written by the
   * backend's handoff route and sweep and pushed over /ws/status.
   * Null/absent = none.
   */
  handoff?: SessionHandoff | null;
}

export type HandoffMode = 'clear' | 'compact' | 'restart';

export interface SessionHandoff {
  id: string;
  state: 'requested' | 'writing' | 'written' | 'resetting' | 'done' | 'failed' | 'aborted';
  mode: HandoffMode;
  /** restart only: the provider being started, when it differs from the one running. */
  toProvider: string | null;
  /** Why it failed or was aborted, or why the asked-for mode fell back. */
  reason: string | null;
  /** ISO timestamp of the last change. */
  at: string;
}

export interface SessionMilestone {
  kind: 'pr_created' | 'pr_merged';
  /** PR link; null when none was captured, or when the viewer is a collaborator (stripped server-side). */
  url: string | null;
  /** ISO timestamp (Dates arrive as strings over the status WebSocket). */
  at: string;
  /** Context size recorded with the milestone; the live reading goes null on its own when idle. */
  contextTokens: number | null;
}

// Keyed by tmux session name
export type StatusMap = Record<string, AgentStatus>;

/**
 * The review ring's input: what the backend's review
 * sweep last read off the `review` tmux session, riding the AGENT session's
 * status. Timestamps arrive as ISO strings over the status WebSocket.
 */
export interface SessionReview {
  state: 'reviewing' | 'waiting' | 'done' | 'exited';
  pr: number | null;
  /** The PR link; null for shared viewers (stripped server-side). */
  url: string | null;
  /** The review tool's provider id (devin / claude / cursor); absent = Devin. */
  reviewer?: string;
  /** When the state last changed. */
  at: string;
  /** When a probe last moved INTO done. */
  doneAt: string | null;
  /** When the viewer focused the review terminal while the review was done. */
  seenAt: string | null;
}

/**
 * What each status is called wherever it is spelled out. `idle` is "Ready":
 * the agent finished and is waiting for its next task, which is not a fault.
 */
export const STATUS_LABEL: Record<AgentStatusValue, string> = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Ready',
  not_running: 'Not running',
};
