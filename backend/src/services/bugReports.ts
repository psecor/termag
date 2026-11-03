/**
 * Bug reports: what `termag bug report` files and
 * /admin/bugs triages. Pure: the parsing, redaction, rate limit and sorting
 * here are unit-tested without a database; services/bugReportsPrisma.ts is
 * the store, routes/cliBugReports.ts and routes/admin/bugs.ts the thin routes.
 */
import { redactSecrets } from './secretPatterns';

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export const AREAS = ['spaces', 'asks', 'publish', 'boxes', 'chat', 'cli', 'broker', 'other'] as const;
export const STATUSES = ['new', 'triaged', 'duplicate', 'fixed', 'wontfix'] as const;
export type Severity = typeof SEVERITIES[number];
export type Area = typeof AREAS[number];
export type BugStatus = typeof STATUSES[number];

/** Per box (or per person, for a sign-in with no box), in any rolling hour. */
export const REPORTS_PER_HOUR = 20;
export const RATE_WINDOW_MS = 60 * 60_000;

export const LIMITS = {
  title: 200,
  body: 20_000,
  command: 2_000,
  errorOutput: 20_000,
  short: 200,
  capabilities: 100,
  search: 200,
  note: 2_000,
} as const;

/** What the caller sends to POST /api/cli/v1/bug-reports. */
export interface BugReportInput {
  title: string;
  body: string;
  severity: Severity;
  area: Area;
  command: string | null;
  errorOutput: string | null;
  cliVersion: string | null;
  agentProvider: string | null;
  agentModel: string | null;
  agentVersion: string | null;
  boxImage: string | null;
  projectId: string | null;
  workstream: string | null;
  /** The kinds of secret-shaped strings replaced in any field. */
  redacted: string[];
}

/** Where a report came from, as the orchestrator itself resolved it. */
export interface Reporter {
  reporterUserId: string;
  credential: 'box' | 'device';
  boxId: string | null;
  projectId: string | null;
  workstream: string | null;
  threadId: string | null;
  boxAgentCommit: string | null;
  boxAgentCapabilities: string[];
}

export interface BugReportRow extends Omit<BugReportInput, 'projectId' | 'workstream'>, Reporter {
  id: string;
  status: BugStatus;
  duplicateOfId: string | null;
  linkUrl: string | null;
  triagedAt: Date | null;
  createdAt: Date;
}

export interface BugReportEventRow {
  id: string;
  reportId: string;
  actorId: string;
  status: string | null;
  duplicateOfId: string | null;
  linkUrl: string | null;
  note: string | null;
  createdAt: Date;
}

export interface BugFilter {
  statuses?: BugStatus[];
  areas?: Area[];
  severities?: Severity[];
  search?: string;
  limit: number;
}

export interface TriageChange {
  status?: BugStatus;
  /** null clears it. */
  duplicateOfId?: string | null;
  /** null clears it. */
  linkUrl?: string | null;
  note?: string;
}

export interface BugReportStore {
  /** Reports filed since `since` by this box, or by this person with no box. */
  countRecent(key: { boxId: string | null; userId: string }, since: Date): Promise<number>;
  /** Where the report comes from: the project and thread only when they are the reporter's. */
  resolveReporter(base: { reporterUserId: string; credential: 'box' | 'device'; boxId: string | null }, claimed: { projectId: string | null; workstream: string | null }): Promise<Reporter>;
  create(input: BugReportInput, reporter: Reporter): Promise<BugReportRow>;
  /** At most `limit`, new reports first, then the rest, newest first within each (sortNewFirst's order). */
  list(filter: BugFilter): Promise<BugReportRow[]>;
  get(id: string): Promise<BugReportRow | null>;
  events(id: string): Promise<BugReportEventRow[]>;
  /** Reports marked duplicates of this one. */
  duplicatesOf(id: string): Promise<BugReportRow[]>;
  /**
   * Applies a validated change and records it as an event, in one transaction.
   * Marking a report a duplicate moves its own duplicates to the same original.
   */
  triage(id: string, change: TriageChange, actorId: string, at: Date): Promise<BugReportRow>;
  countsByStatus(): Promise<Record<string, number>>;
  /** Emails, box names and project names for the ids, for display. */
  names(ids: { users: string[]; boxes: string[]; projects: string[] }): Promise<{ users: Record<string, string>; boxes: Record<string, string>; projects: Record<string, string> }>;
}

type Parsed<T> = { ok: T } | { error: string };

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A short single-line field: trimmed, at most LIMITS.short, null when empty or absent. */
function shortField(v: unknown): string | null {
  const s = str(v)?.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, LIMITS.short) : null;
}

/**
 * Validate and normalise a report. Every free-text field is scanned for
 * secret-shaped strings, which are replaced (`[redacted: GitHub token]`) and
 * their kinds kept in `redacted`: the report is kept, the secret is not. Long
 * error output keeps its tail, where the error usually is.
 */
export function parseBugReportInput(raw: unknown): Parsed<BugReportInput> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const redacted = new Set<string>();
  const clean = (s: string | null): string | null => {
    if (s === null) return null;
    const r = redactSecrets(s);
    for (const k of r.redacted) redacted.add(k);
    return r.text;
  };

  const title = str(b.title)?.replace(/\s+/g, ' ').trim() ?? '';
  if (!title) return { error: 'title is required' };
  if (title.length > LIMITS.title) return { error: `title is at most ${LIMITS.title} characters` };
  const body = str(b.body)?.trim() ?? '';
  if (!body) return { error: 'body is required: what you ran, what you expected, what happened' };
  if (body.length > LIMITS.body) return { error: `body is at most ${LIMITS.body} characters` };

  const severity = b.severity === undefined || b.severity === null ? 'medium' : b.severity;
  if (!SEVERITIES.includes(severity as Severity)) return { error: `severity is one of ${SEVERITIES.join(', ')}` };
  const area = b.area === undefined || b.area === null ? 'other' : b.area;
  if (!AREAS.includes(area as Area)) return { error: `area is one of ${AREAS.join(', ')}` };

  const command = str(b.command)?.trim() || null;
  if (command && command.length > LIMITS.command) return { error: `command is at most ${LIMITS.command} characters` };
  // Redacted before the tail is cut, so a key whose header falls outside the tail still goes.
  const errorRaw = clean(str(b.errorOutput));
  const errorOutput = errorRaw && errorRaw.trim()
    ? (errorRaw.length > LIMITS.errorOutput ? '…' + errorRaw.slice(-LIMITS.errorOutput) : errorRaw)
    : null;

  const projectId = str(b.projectId)?.trim() || null;
  const workstream = str(b.workstream)?.trim() || null;
  return {
    ok: {
      title: clean(title)!,
      body: clean(body)!,
      severity: severity as Severity,
      area: area as Area,
      command: clean(command),
      errorOutput,
      cliVersion: clean(shortField(b.cliVersion)),
      agentProvider: clean(shortField(b.agentProvider)),
      agentModel: clean(shortField(b.agentModel)),
      agentVersion: clean(shortField(b.agentVersion)),
      boxImage: clean(shortField(b.boxImage)),
      projectId: projectId && /^[A-Za-z0-9_-]{1,80}$/.test(projectId) ? projectId : null,
      workstream: workstream && /^[A-Za-z0-9_.-]{1,100}$/.test(workstream) ? workstream : null,
      redacted: [...redacted],
    },
  };
}

/** The ask thread a workstream belongs to: an ask runs in `ask-<thread id>`. */
export function threadIdOf(workstream: string | null): string | null {
  const m = workstream?.match(/^ask-([A-Za-z0-9]{8,40})$/);
  return m ? m[1] : null;
}

/** True when this box (or person) may file another report now. */
export function underRateLimit(recent: number): boolean {
  return recent < REPORTS_PER_HOUR;
}

function listOf<T extends string>(raw: unknown, allowed: readonly T[], name: string): Parsed<T[] | undefined> {
  if (raw === undefined || raw === '') return { ok: undefined };
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  const bad = parts.find(p => !allowed.includes(p as T));
  if (bad) return { error: `${name} is one of ${allowed.join(', ')} (got "${bad}")` };
  return { ok: parts.length ? parts as T[] : undefined };
}

/** ?status=new,triaged&area=…&severity=…&q=…&limit= for the admin list. */
export function parseBugFilter(query: Record<string, unknown>): Parsed<BugFilter> {
  const statuses = listOf(query.status, STATUSES, 'status');
  if ('error' in statuses) return statuses;
  const areas = listOf(query.area, AREAS, 'area');
  if ('error' in areas) return areas;
  const severities = listOf(query.severity, SEVERITIES, 'severity');
  if ('error' in severities) return severities;
  const q = str(query.q)?.trim() ?? '';
  if (q.length > LIMITS.search) return { error: `q is at most ${LIMITS.search} characters` };
  const max = 500;
  const limitRaw = query.limit === undefined || query.limit === '' ? max : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) return { error: 'limit is a positive whole number' };
  return {
    ok: {
      ...(statuses.ok ? { statuses: statuses.ok } : {}),
      ...(areas.ok ? { areas: areas.ok } : {}),
      ...(severities.ok ? { severities: severities.ok } : {}),
      ...(q ? { search: q } : {}),
      limit: Math.min(limitRaw, max),
    },
  };
}

const GITHUB_LINK_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+\/?$/;

/**
 * An admin's change to a report. `duplicateOf` marks it a duplicate (and
 * sets the status); moving it off `duplicate` clears the pointer. `link` is a
 * github.com issue or pull request URL, `null` or "" to clear it.
 */
export function parseTriageChange(raw: unknown, reportId: string): Parsed<TriageChange> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const change: TriageChange = {};
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status as BugStatus)) return { error: `status is one of ${STATUSES.join(', ')}` };
    change.status = b.status as BugStatus;
  }
  if (b.duplicateOf !== undefined && b.duplicateOf !== null && b.duplicateOf !== '') {
    const dup = str(b.duplicateOf)?.trim() ?? '';
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(dup)) return { error: 'duplicateOf is a bug report id' };
    if (dup === reportId) return { error: 'a report cannot be a duplicate of itself' };
    if (change.status && change.status !== 'duplicate') return { error: 'duplicateOf goes with status duplicate' };
    change.status = 'duplicate';
    change.duplicateOfId = dup;
  } else if (change.status === 'duplicate') {
    return { error: 'status duplicate needs duplicateOf: the report it duplicates' };
  } else if (change.status) {
    change.duplicateOfId = null;
  }
  if (b.link !== undefined) {
    const link = b.link === null ? '' : str(b.link)?.trim();
    if (link === undefined || link === null) return { error: 'link is a GitHub issue or pull request URL' };
    if (link && !GITHUB_LINK_RE.test(link)) return { error: 'link is a GitHub issue or pull request URL (https://github.com/<owner>/<repo>/issues/<n> or /pull/<n>)' };
    change.linkUrl = link ? link.replace(/\/$/, '') : null;
  }
  if (b.note !== undefined) {
    const note = str(b.note)?.trim() ?? '';
    if (note.length > LIMITS.note) return { error: `note is at most ${LIMITS.note} characters` };
    if (findsSecret(note)) return { error: 'note holds a secret-shaped string' };
    if (note) change.note = note;
  }
  if (change.status === undefined && change.linkUrl === undefined && change.note === undefined) {
    return { error: 'nothing to change: give status, duplicateOf, link or note' };
  }
  return { ok: change };
}

function findsSecret(text: string): boolean {
  return redactSecrets(text).redacted.length > 0;
}

/** New reports first, then the rest; newest first within each. */
export function sortNewFirst<T extends { status: string; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    Number(b.status === 'new') - Number(a.status === 'new') || b.createdAt.getTime() - a.createdAt.getTime());
}

/** Every status with its count, zeros included. */
export function fillCounts(counts: Record<string, number>): Record<BugStatus, number> {
  return Object.fromEntries(STATUSES.map(s => [s, counts[s] ?? 0])) as Record<BugStatus, number>;
}
