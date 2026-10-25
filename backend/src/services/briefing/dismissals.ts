/**
 * Done and "Defer a day" on briefing items, stored per user the way PR deferrals are (services/prDeferrals.ts):
 * a key and a date. The card hides a dismissed item at once; the next
 * briefing leaves it out (the ledger drops dismissed patterns and flags
 * dismissed sessions).
 *
 *   pattern:<LedgerPattern.id>      Work better      done: 14 days   defer: 1 day
 *   open:<projectId>:<workstream>   Left open        done: 7 days, or until the session does something new
 *   open:pr:<owner/name>#<n>        Left open (a PR no session links to)
 */
import { prisma } from '../../db';
import type { BriefingDismissal } from './types';

const DAY_MS = 24 * 60 * 60_000;
export const DONE_PATTERN_DAYS = 14;
export const DONE_OPEN_DAYS = 7;
export const DEFER_DAYS = 1;

export class DismissInputError extends Error {}

const PATTERN_KEY = /^pattern:\S{1,240}$/;
const OPEN_KEY = /^open:[\w-]{1,64}:\S{1,255}$/;
const OPEN_PR_KEY = /^open:pr:[\w.-]+\/[\w.-]+#\d{1,9}$/;

export function openKey(projectId: string | null, workstream: string | null, pr: string | null): string | null {
  if (projectId) return `open:${projectId}:${workstream || 'main'}`;
  if (pr) return `open:pr:${pr}`;
  return null;
}

export const patternKey = (id: string) => `pattern:${id}`;

export function parseDismissInput(raw: unknown): { key: string; action: 'done' | 'defer' } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const key = r.key;
  if (typeof key !== 'string' || key.length > 300 || !(PATTERN_KEY.test(key) || OPEN_PR_KEY.test(key) || OPEN_KEY.test(key))) {
    throw new DismissInputError('Not a briefing item');
  }
  if (r.action !== 'done' && r.action !== 'defer') throw new DismissInputError('action must be done or defer');
  return { key, action: r.action };
}

/** Defer again pushes a day on from the current end; Done starts its own span from now. */
export function dismissedUntil(key: string, action: 'done' | 'defer', current: { kind: string; until: Date } | null, now: Date): Date {
  if (action === 'done') return new Date(now.getTime() + (key.startsWith('pattern:') ? DONE_PATTERN_DAYS : DONE_OPEN_DAYS) * DAY_MS);
  const from = current && current.kind === 'defer' && current.until.getTime() > now.getTime() ? current.until.getTime() : now.getTime();
  return new Date(from + DEFER_DAYS * DAY_MS);
}

export const isActive = (d: Pick<BriefingDismissal, 'until'>, now: Date) => Date.parse(d.until) > now.getTime();

/**
 * Whether a session's left-open item stays out of the next briefing: while
 * deferred, and once done until the session does something after the click.
 */
export function sessionDismissed(d: BriefingDismissal | undefined, lastActivityAt: string | null, now: Date): boolean {
  if (!d || !isActive(d, now)) return false;
  if (d.kind === 'defer') return true;
  const last = lastActivityAt ? Date.parse(lastActivityAt) : NaN;
  return !Number.isFinite(last) || last <= Date.parse(d.createdAt);
}

export interface DismissalStore {
  list: (userId: string, now: Date) => Promise<BriefingDismissal[]>;
  dismiss: (userId: string, input: { key: string; action: 'done' | 'defer' }, now: Date) => Promise<BriefingDismissal>;
  restore: (userId: string, key: string) => Promise<void>;
}

const view = (r: { key: string; kind: string; until: Date; at: Date }): BriefingDismissal =>
  ({ key: r.key, kind: r.kind === 'done' ? 'done' : 'defer', until: r.until.toISOString(), createdAt: r.at.toISOString() });

export const prismaDismissals: DismissalStore = {
  async list(userId, now) {
    const rows = await prisma.briefingDismissal.findMany({ where: { userId }, orderBy: { until: 'asc' } });
    if (rows.some(r => r.until.getTime() <= now.getTime())) {
      await prisma.briefingDismissal.deleteMany({ where: { userId, until: { lte: now } } }).catch(() => undefined);
    }
    return rows.filter(r => r.until.getTime() > now.getTime()).map(view);
  },
  // One statement, so two clicks on the same key cannot both read the old row:
  // a Defer on a running deferral adds a day to its end in the update itself
  // (dismissedUntil's rule, done by Postgres), anything else starts from now.
  async dismiss(userId, input, now) {
    const fresh = dismissedUntil(input.key, input.action, null, now);
    const extend = input.action === 'defer';
    const rows = await prisma.$queryRaw<Array<{ key: string; kind: string; until: Date; at: Date }>>`
      INSERT INTO "briefing_dismissals" ("userId", "key", "kind", "until", "at")
      VALUES (${userId}, ${input.key}, ${input.action}, ${fresh}, ${now})
      ON CONFLICT ("userId", "key") DO UPDATE SET
        "kind" = EXCLUDED."kind",
        "at" = EXCLUDED."at",
        "until" = CASE
          WHEN ${extend} AND "briefing_dismissals"."kind" = 'defer' AND "briefing_dismissals"."until" > EXCLUDED."at"
            THEN "briefing_dismissals"."until" + make_interval(days => ${DEFER_DAYS}::int)
          ELSE EXCLUDED."until"
        END
      RETURNING "key", "kind", "until", "at"
    `;
    return view(rows[0]);
  },
  async restore(userId, key) {
    await prisma.briefingDismissal.deleteMany({ where: { userId, key } });
  },
};
