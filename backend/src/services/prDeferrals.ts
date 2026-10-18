/**
 * Deferred rows of the PR overlay:
 * a PR or branch the user has seen and put off, left out of "Needs you" and
 * the PRs tile until its time is up. Stored per user, so the dashboard, the
 * tile and the phone agree; served alongside GET /api/prs but outside its
 * memo, so a deferral shows on the next read.
 *
 * A deferral is only a date: it does not watch the PR. Deferring again pushes
 * the date on from the current one ("another day"), and an expired deferral
 * is dropped the next time the list is read.
 */

import { prisma } from '../db';
import { PrInputError } from './prReview';

const DAY_MS = 24 * 60 * 60_000;
export const MAX_DEFER_DAYS = 30;

export interface PrDeferral { key: string; until: string }

export interface DeferInput { key: string; days: number }

// The overlay's row keys (frontend utils/prPipeline.ts rowParam): owner/name#n, or owner/name:branch.
const PR_KEY = /^[\w.-]+\/[\w.-]+#\d{1,9}$/;
const BRANCH_KEY = /^([\w.-]+\/[\w.-]+)?:\S{1,255}$/;

export function parseDeferKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 300 || !(PR_KEY.test(raw) || BRANCH_KEY.test(raw))) {
    throw new PrInputError('Not a pull request or branch');
  }
  return raw;
}

export function parseDeferInput(raw: unknown): DeferInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const key = parseDeferKey(r.key);
  const days = r.days === undefined ? 1 : r.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DEFER_DAYS) {
    throw new PrInputError(`days must be a whole number from 1 to ${MAX_DEFER_DAYS}`);
  }
  return { key, days };
}

/** The new end of a deferral: `days` on from the current one if it is still running, else from now. */
export function deferredUntil(current: Date | null, days: number, now: Date): Date {
  const from = current && current.getTime() > now.getTime() ? current.getTime() : now.getTime();
  return new Date(from + days * DAY_MS);
}

/** The store, injectable so the routes are testable without a database. */
export interface DeferralStore {
  list: (userId: string, now: Date) => Promise<PrDeferral[]>;
  defer: (userId: string, input: DeferInput, now: Date) => Promise<PrDeferral>;
  undefer: (userId: string, key: string) => Promise<void>;
}

export const prismaDeferrals: DeferralStore = {
  async list(userId, now) {
    const rows = await prisma.prDeferral.findMany({ where: { userId }, orderBy: { until: 'asc' } });
    const expired = rows.filter(r => r.until.getTime() <= now.getTime());
    if (expired.length) {
      await prisma.prDeferral.deleteMany({ where: { userId, until: { lte: now } } }).catch(() => undefined);
    }
    return rows.filter(r => r.until.getTime() > now.getTime()).map(r => ({ key: r.key, until: r.until.toISOString() }));
  },
  async defer(userId, input, now) {
    // One user's two tabs racing is harmless: the later write wins, a day either way.
    const current = await prisma.prDeferral.findUnique({ where: { userId_key: { userId, key: input.key } } });
    const until = deferredUntil(current?.until ?? null, input.days, now);
    await prisma.prDeferral.upsert({
      where: { userId_key: { userId, key: input.key } },
      create: { userId, key: input.key, until },
      update: { until },
    });
    return { key: input.key, until: until.toISOString() };
  },
  async undefer(userId, key) {
    await prisma.prDeferral.deleteMany({ where: { userId, key } });
  },
};
