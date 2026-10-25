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
  /** The user marked this session's left-open item done (and it has done nothing since) or deferred it. */
  dismissed: boolean;
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

/** A spawned agent whose parent went away and that nobody adopted. Metadata only: no brief or report text. */
export interface LedgerSpawnOrphan {
  spawnId: string;
  projectId: string | null;
  workstream: string;
  /** Owner-only, like a cloud session's title. */
  title: string;
  state: string;
  orphanedAt: string;
  /** It reported and nobody has read it. */
  unreadReport: boolean;
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
  /** Orphaned spawns waiting for someone; absent when the dep is not wired. */
  spawnOrphans?: LedgerSpawnOrphan[];
  /** Open PRs no workstream links to: attention, waiting on approval, or team reviews. */
  otherPrs: LedgerPr[];
  /** Habits over the last PATTERN_DAYS days, without the ones the user marked done or deferred. */
  patterns: LedgerPattern[];
  charts: BriefingCharts;
  /** What could not be read, in words ("2 workstreams on an offline box"). */
  notes: string[];
  trust: string;
}

/**
 * A habit worth changing, found by services/briefing/patterns.ts over the last
 * PATTERN_DAYS days from what termag records. Deterministic: the id is stable
 * across briefings, so Done and Defer can name it.
 */
export interface LedgerPattern {
  /** "big-context:<projectId>:<workstream>", "stale-workstreams", … */
  id: string;
  kind: 'big-context' | 'stale-workstreams' | 'branches-without-pr' | 'undeployed-merges' | 'many-switches' | 'waiting-long';
  /** What was seen, in plain words with the numbers ("termag · main peaked at 388k tokens of context"). */
  finding: string;
  projectId: string | null;
  workstream: string | null;
}

/** Series for the card's charts (services/briefing/charts.ts). Database only, no model. */
export interface BriefingCharts {
  /** The last 7 local days, oldest first, ending with the window's last day. */
  days: Array<{ day: string; humanMs: number; agentMs: number; tokens: number }>;
  /** Time in the window per project, busiest first, at most 8. */
  projects: Array<{ projectId: string; name: string; humanMs: number; agentMs: number }>;
}

/** One bullet's PR: "owner/name#123". */
export type PrRef = string;

/** What the composing model returns (version 2), validated by services/briefing/content.ts. */
export interface BriefingContent {
  version: 2;
  /** One sentence. */
  headline: string;
  /** What got done, a few bullets per project. */
  workedOn: Array<{
    projectId: string | null;
    workstream: string | null;
    text: string;
    prs: PrRef[];
  }>;
  /** Dangling work, decisions and actions, in the order to take them. */
  leftOpen: Array<{
    /** Set by the backend: what Done and Defer name ("open:<projectId>:<workstream>"); null when it names no session or PR. */
    key: string | null;
    projectId: string | null;
    workstream: string | null;
    kind: 'question' | 'decision' | 'action' | 'blocked';
    title: string;
    detail: string;
    evidence: 'transcript' | 'todo' | 'status' | 'pr' | 'git' | 'cloud' | 'pane';
    pr: PrRef | null;
  }>;
  /** Habits worth changing, each from a LedgerPattern. */
  workBetter: Array<{
    /** "pattern:<LedgerPattern.id>". */
    key: string;
    projectId: string | null;
    workstream: string | null;
    text: string;
    why: string;
  }>;
}

/** The first shape, still in rows written before version 2; store.ts reads it as version 2. */
export interface BriefingContentV1 {
  summary: string;
  carryovers: Array<{
    projectId: string | null;
    workstream: string | null;
    kind: BriefingContent['leftOpen'][number]['kind'];
    title: string;
    detail: string;
    evidence: BriefingContent['leftOpen'][number]['evidence'];
  }>;
  suggestions: Array<{ projectId: string | null; workstream: string | null; text: string; why: string }>;
}

/** Done or Defer on one item of a briefing (services/briefing/dismissals.ts). */
export interface BriefingDismissal {
  key: string;
  kind: 'done' | 'defer';
  until: string;
  createdAt: string;
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
  /** Null on rows written before the charts. */
  charts: BriefingCharts | null;
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
