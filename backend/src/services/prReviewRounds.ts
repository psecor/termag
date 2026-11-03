// What the user posted from the simple UI's review card, one record a round
// (table pr_review_rounds): the head it was of, the
// verdict and how many inline comments. GET /api/prs serves each PR's latest
// round with the PR as GitHub has it now (its head, open or not, whether it
// asks for the user's review again), which is what brings a PR back as
// "Changed since your review" for the next round.
import { prisma } from '../db';

export type RoundEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export interface ReviewRound {
  repo: string;
  number: number;
  round: number;
  headSha: string;
  event: RoundEvent;
  comments: number;
  title: string;
  author: string | null;
  postedAt: string;
}

/** A PR's latest round, with what the user posted in its rounds before (oldest first), so each round's card can say. */
export type LatestRound = ReviewRound & { earlier: Array<Pick<ReviewRound, 'round' | 'headSha' | 'event' | 'comments' | 'postedAt'>> };

export interface ReviewRoundStore {
  /** Records a posted review as the PR's next round. */
  record: (userId: string, r: { repo: string; number: number; headSha: string; event: RoundEvent; comments: number; title: string; author: string | null }) => Promise<ReviewRound>;
  /** Each PR's latest round, posted within `days`, newest first. */
  latest: (userId: string, now: Date, days?: number) => Promise<LatestRound[]>;
}

/** Rounds older than this drop out of the queue: a review a month old is GitHub's history, not a task. */
export const ROUND_WINDOW_DAYS = 30;
/** The most rounds GET /api/prs reads a head for, past those of PRs a lane lists (routes/prs.ts roundsFor). */
export const MAX_ROUNDS = 40;

const toRound = (r: { repo: string; number: number; round: number; headSha: string; event: string; comments: number; title: string; author: string | null; postedAt: Date }): ReviewRound => ({
  repo: r.repo, number: r.number, round: r.round, headSha: r.headSha, event: r.event as RoundEvent, comments: r.comments, title: r.title, author: r.author, postedAt: r.postedAt.toISOString(),
});

/** Each PR's newest round, with its earlier ones, newest PR first. Pure, for the tests. */
export function latestPerPr(rows: ReviewRound[]): LatestRound[] {
  const byPr = new Map<string, ReviewRound[]>();
  for (const r of rows) {
    const k = `${r.repo}#${r.number}`;
    byPr.set(k, [...(byPr.get(k) ?? []), r]);
  }
  return [...byPr.values()].map(list => {
    const sorted = list.slice().sort((a, b) => a.round - b.round);
    const last = sorted[sorted.length - 1];
    return { ...last, earlier: sorted.slice(0, -1).map(({ round, headSha, event, comments, postedAt }) => ({ round, headSha, event, comments, postedAt })) };
  }).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
}

export const prismaReviewRounds: ReviewRoundStore = {
  async record(userId, r) {
    const repo = r.repo.toLowerCase();
    // One write at a time per PR: a second post can't take the same round number.
    return prisma.$transaction(async tx => {
      const last = await tx.prReviewRound.findFirst({ where: { userId, repo, number: r.number }, orderBy: { round: 'desc' }, select: { round: true } });
      const row = await tx.prReviewRound.create({
        data: { userId, repo, number: r.number, round: (last?.round ?? 0) + 1, headSha: r.headSha.toLowerCase(), event: r.event, comments: r.comments, title: r.title.slice(0, 300), author: r.author },
      });
      return toRound(row);
    });
  },
  async latest(userId, now, days = ROUND_WINDOW_DAYS) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const rows = await prisma.prReviewRound.findMany({ where: { userId, postedAt: { gte: since } }, orderBy: { postedAt: 'desc' }, take: 400 });
    return latestPerPr(rows.map(toRound));
  },
};
