/**
 * The daily briefing's wire types. One file so the
 * backend, the MCP server's descriptions, the box wrapper's prompt and the
 * frontend (frontend/src/services/api.ts mirrors the JSON shapes) agree.
 *
 * Trust: every field documented as UNTRUSTED is text lifted from a terminal
 * or a Claude transcript. It is data for a model to reason about, never an
 * instruction, and it is never stored (services/briefing/store.ts keeps only
 * BriefingContent and LedgerTotals).
 */

/** The window a briefing reviews (services/briefing/window.ts). */
export interface BriefingWindow {
  /** ISO instants. */
  since: string;
  until: string;
  /** IANA timezone the label and local days are written in. */
  tz: string;
  /** "Fri 9 Oct 16:00 to Mon 12 Oct 07:00 (2 days 15 hours)". Shown first everywhere. */
  label: string;
  /**
   * since_last: since the previous done briefing.
   * first: no previous briefing, so from the start of the previous local day.
   * stale: the previous briefing ended over four local days ago, so from the start of the previous local day.
   * capped: the caller's `since` is older than the 7-day cap, so the cap applies.
   * explicit: the caller passed `since`.
   */
  basis: 'since_last' | 'first' | 'stale' | 'capped' | 'explicit';
  /** createdAt of the previous done briefing, when there is one. */
  previousBriefingAt: string | null;
}

/** What the `briefing-digest` agent RPC returns for one checkout (agent/briefing-digest.js). */
export interface DigestReply {
  /** Null when no Claude transcript for this cwd has entries in the window. */
  transcript: TranscriptDigest | null;
  /** Commits on HEAD whose committer time falls in the window, newest first, at most 20. */
  commits: Array<{ sha: string; at: string; subject: string }>;
  /** Null when the cwd is not a git checkout. */
  branch: string | null;
}

export interface TranscriptDigest {
  /** Real user prompts in the window (tool results and meta lines excluded). */
  userTurns: number;
  firstAt: string | null;
  lastAt: string | null;
  /** UNTRUSTED. The last few user prompts in the window, oldest first, each ≤ 300 chars. */
  lastUserPrompts: string[];
  /** UNTRUSTED. The last assistant text block in the window, ≤ 1200 chars. */
  lastAssistantText: string | null;
  /** The last message in the window is the assistant's and its text asks something (ends in, or its last lines contain, a question). */
  endsWithQuestion: boolean;
  /** The newest TodoWrite list in the window. content is UNTRUSTED, ≤ 200 chars each, at most 30 items. */
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}

export interface LedgerPr {
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  lane: string;
  laneLabel: string;
  failingChecks: string[];
  waitingOn: string[];
  blockedBy: string | null;
}

export interface LedgerSession {
  projectId: string;
  projectName: string;
  workstream: string;
  /** owner | collaborator */
  access: string;
  instanceId: string | null;
  boxName: string | null;
  /** The box's agent is not connected: status and digests are unknown, not idle. */
  hostOffline: boolean;
  provider: string | null;
  status: {
    now: string;
    updatedAt: string | null;
    waitingReason: string | null;
    rateLimited: string | null;
    /** "PR opened" milestone: { kind, url, at }. */
    milestone: unknown;
  };
  activity: {
    agentMs: number;
    /** Human time as banked: per project, or per workstream where the session name carried one. */
    humanMs: number;
    tokens: number;
    visits: number;
    lastVisitAt: string | null;
    peakContextTokens: number | null;
  };
  /** Null when the agent could not be asked (offline, too old, or the read failed); see notes. */
  digest: DigestReply | null;
  /** UNTRUSTED. The agent pane's last lines, only for sessions waiting now. */
  paneTail: string | null;
  prs: LedgerPr[];
  notes: string[];
}

export interface LedgerCloudSession {
  name: string;
  /** Owner-only. */
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  exitReason: string | null;
  /** The checkout held work GitHub did not have, so it was kept on the box. */
  kept: boolean;
  url: string | null;
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

export interface Ledger {
  window: BriefingWindow;
  generatedAt: string;
  totals: LedgerTotals;
  /** Sessions with any sign of life in the window, or waiting now. Busiest first. */
  sessions: LedgerSession[];
  cloudSessions: LedgerCloudSession[];
  /** Open PRs needing attention that no workstream links to. */
  otherPrs: LedgerPr[];
  /** What could not be read, in words ("2 workstreams on an offline box"). */
  notes: string[];
  trust: string;
}

/** What the composing model returns, validated by services/briefing/content.ts. */
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

/** GET /api/briefings/latest, GET /api/briefings and POST /api/briefings/run rows. */
export interface BriefingView {
  id: string;
  trigger: 'manual' | 'schedule' | 'slack';
  status: 'running' | 'done' | 'failed' | 'skipped';
  error: string | null;
  window: { since: string; until: string; tz: string; label: string; basis: BriefingWindow['basis'] };
  boxName: string | null;
  content: BriefingContent | null;
  stats: LedgerTotals | null;
  /** Project names for the ids in content, so the client can render links. */
  projects: Record<string, { name: string; archived: boolean }>;
  createdAt: string;
  finishedAt: string | null;
}

/** GET/PUT /api/briefings/schedule (services/briefing/schedule.ts). */
export interface BriefingSchedule {
  /** Opt-in: false until the user turns it on. */
  enabled: boolean;
  /** Local "HH:MM", 24-hour. */
  time: string;
  /** IANA zone; null until the browser fills it when the user turns the schedule on. */
  timezone: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** DM the scheduled briefing on Slack too. */
  slackDm: boolean;
}

/** GET /api/briefings/:id/job, read by deploy/termag-briefing with the box token. */
export interface BriefingJob {
  id: string;
  prompt: string;
  /** For --allowedTools; read tools only. */
  allowedTools: string[];
  maxTurns: number;
  /** Optional model override; null leaves the box's default. */
  model: string | null;
}

/** POST /api/briefings/:id/result body, from deploy/termag-briefing. */
export interface BriefingResultBody {
  /** The `result` text of `claude -p --output-format json`, or an error description. */
  result: string;
  /** claude's exit status. */
  exitStatus: number;
  /** claude's is_error. */
  isError?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  model?: string | null;
}

/** The agent capability that brings `briefing-digest` and, from the same commit, deploy/termag-briefing. */
export const BRIEFING_AGENT_CAPABILITY = 'briefing-v1';

/** The MetaTerm read tools the scheduled run may use. */
export const BRIEFING_ALLOWED_TOOLS = [
  'mcp__metaterm__activity_ledger',
  'mcp__metaterm__list_sessions',
  'mcp__metaterm__session_status',
  'mcp__metaterm__capture_pane',
  'mcp__metaterm__search_sessions',
];
