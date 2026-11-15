/**
 * Feedback about termag itself: what `termag feedback`
 * logs when a person says something about termag in a chat, and what
 * /admin/feedback lists. Pure: parsing, redaction, the rate limit and the
 * filters are unit-tested without a database; services/feedbackPrisma.ts is
 * the store, routes/cliFeedback.ts and routes/admin/feedback.ts the routes.
 *
 * It travels the same path as a bug report (services/bugReports.ts): the same
 * credentials, the same reporter context (services/cliReporter.ts), the same
 * redaction. Triage is lighter: a piece of feedback is `new` until an admin
 * marks it `seen`.
 */
import {
  parseClaimedPlace, parseClientContext, redactor,
  type ClaimedPlace, type ClientContext, type Reporter, type ResolveReporter,
} from './cliReporter';

export const KINDS = ['praise', 'problem', 'idea', 'other'] as const;
export const STATUSES = ['new', 'seen'] as const;
export type FeedbackKind = typeof KINDS[number];
export type FeedbackStatus = typeof STATUSES[number];

/** Per box (or per person, for a sign-in with no box), in any rolling hour. */
export const FEEDBACK_PER_HOUR = 20;
export const RATE_WINDOW_MS = 60 * 60_000;

export const LIMITS = { body: 5_000, search: 200 } as const;
export const MAX_LIST = 500;

/** What the caller sends to POST /api/cli/v1/feedback. */
export interface FeedbackInput extends ClientContext, ClaimedPlace {
  /** What the person said, in their words or close to them. */
  body: string;
  kind: FeedbackKind;
  /** The kinds of secret-shaped strings replaced. */
  redacted: string[];
}

export interface FeedbackRow extends Omit<FeedbackInput, 'projectId' | 'workstream'>, Reporter {
  id: string;
  status: FeedbackStatus;
  seenAt: Date | null;
  seenById: string | null;
  createdAt: Date;
}

export interface FeedbackFilter {
  statuses?: FeedbackStatus[];
  kinds?: FeedbackKind[];
  search?: string;
  limit: number;
}

export interface FeedbackStore {
  countRecent(key: { boxId: string | null; userId: string }, since: Date): Promise<number>;
  resolveReporter: ResolveReporter;
  create(input: FeedbackInput, reporter: Reporter): Promise<FeedbackRow>;
  /** At most `limit`, newest first. */
  list(filter: FeedbackFilter): Promise<FeedbackRow[]>;
  get(id: string): Promise<FeedbackRow | null>;
  /** Sets the status; `seen` records who and when, `new` clears them. */
  setStatus(id: string, status: FeedbackStatus, actorId: string, at: Date): Promise<FeedbackRow>;
  countsByStatus(): Promise<Record<string, number>>;
  names(ids: { users: string[]; boxes: string[]; projects: string[] }): Promise<{ users: Record<string, string>; boxes: Record<string, string>; projects: Record<string, string> }>;
}

type Parsed<T> = { ok: T } | { error: string };

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Validate and normalise a piece of feedback. Secret-shaped strings are
 * replaced (`[redacted: GitHub token]`) and their kinds kept: the feedback is
 * kept, the secret is not.
 */
export function parseFeedbackInput(raw: unknown): Parsed<FeedbackInput> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const { clean, redacted } = redactor();
  const body = str(b.body)?.trim() ?? '';
  if (!body) return { error: 'body is required: what the person said about termag' };
  if (body.length > LIMITS.body) return { error: `body is at most ${LIMITS.body} characters` };
  const kind = b.kind === undefined || b.kind === null || b.kind === '' ? 'other' : b.kind;
  if (!KINDS.includes(kind as FeedbackKind)) return { error: `kind is one of ${KINDS.join(', ')}` };
  return {
    ok: {
      body: clean(body)!,
      kind: kind as FeedbackKind,
      ...parseClientContext(b, clean),
      ...parseClaimedPlace(b),
      redacted: [...redacted],
    },
  };
}

/** True when this box (or person) may log more feedback now. */
export function underRateLimit(recent: number): boolean {
  return recent < FEEDBACK_PER_HOUR;
}

function listOf<T extends string>(raw: unknown, allowed: readonly T[], name: string): Parsed<T[] | undefined> {
  if (raw === undefined || raw === '') return { ok: undefined };
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  const bad = parts.find(p => !allowed.includes(p as T));
  if (bad) return { error: `${name} is one of ${allowed.join(', ')} (got "${bad}")` };
  return { ok: parts.length ? parts as T[] : undefined };
}

/** ?status=new,seen&kind=…&q=…&limit= for the admin list. */
export function parseFeedbackFilter(query: Record<string, unknown>): Parsed<FeedbackFilter> {
  const statuses = listOf(query.status, STATUSES, 'status');
  if ('error' in statuses) return statuses;
  const kinds = listOf(query.kind, KINDS, 'kind');
  if ('error' in kinds) return kinds;
  const q = str(query.q)?.trim() ?? '';
  if (q.length > LIMITS.search) return { error: `q is at most ${LIMITS.search} characters` };
  const limitRaw = query.limit === undefined || query.limit === '' ? MAX_LIST : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) return { error: 'limit is a positive whole number' };
  return {
    ok: {
      ...(statuses.ok ? { statuses: statuses.ok } : {}),
      ...(kinds.ok ? { kinds: kinds.ok } : {}),
      ...(q ? { search: q } : {}),
      limit: Math.min(limitRaw, MAX_LIST),
    },
  };
}

/** An admin's change: `{ status: 'seen' | 'new' }`. */
export function parseStatusChange(raw: unknown): Parsed<FeedbackStatus> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (!STATUSES.includes(b.status as FeedbackStatus)) return { error: `status is one of ${STATUSES.join(', ')}` };
  return { ok: b.status as FeedbackStatus };
}

/** Every status with its count, zeros included. */
export function fillCounts(counts: Record<string, number>): Record<FeedbackStatus, number> {
  return Object.fromEntries(STATUSES.map(s => [s, counts[s] ?? 0])) as Record<FeedbackStatus, number>;
}
