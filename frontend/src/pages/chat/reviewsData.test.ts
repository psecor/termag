import { describe, expect, it } from 'vitest';
import type { PrPipelineResponse, PrRow } from '../../services/api';
import type { ReviewQueue } from '../../chat/reviews';
import { joinReviewSessions, markReviewSession, moreReviewSessions, pruneReviewMarks, type ReviewMark } from './reviewsData';

const QUEUE: ReviewQueue = { items: [], deferred: [], grouped: [], reviewed: [], groups: [], viewer: 'e2e-octocat', needYou: 0 };
const pr = { repo: 'example-org/termag', number: 804, title: 'Forward', author: 'e2e-fabian', url: 'https://github.com/example-org/termag/pull/804' };
const ws = (workstream: string) => ({ projectId: 'p', projectName: 'termag', workstream });
const read = ({ rows = [], earlier = [] }: { rows?: Partial<PrRow>[]; earlier?: unknown[] }) => ({
  connected: true, viewer: 'e2e-octocat', lanes: [{ id: 'mine', label: 'Mine', rows: rows.map(r => ({ kind: 'pr', ...r })) }], earlier,
} as unknown as PrPipelineResponse);
const mark = (workstream: string, at: number): Record<string, ReviewMark> => ({ [`p|${workstream}`]: { ...pr, session: ws(workstream), at } });

describe('review sessions the queue does not list', () => {
  it("are a manual link in any lane to someone else's PR, never a workstream on your own", () => {
    const prs = read({ rows: [
      { repo: pr.repo, number: 804, author: 'e2e-fabian', title: 'Forward', linkedBy: 'manual', workstream: ws('rv-theirs') },
      { repo: pr.repo, number: 805, author: 'E2E-Octocat', title: 'Mine', linkedBy: 'manual', workstream: ws('my-pr') },
      { repo: pr.repo, number: 806, author: 'e2e-fabian', title: 'Branch', linkedBy: 'branch', workstream: ws('on-its-branch') },
    ] });
    expect(moreReviewSessions(QUEUE, prs, Date.now(), {}).map(i => [i.number, i.session?.workstream])).toEqual([[804, 'rv-theirs']]);
  });

  it("take a link no lane lists (earlier) only when this browser marked it a review of that PR", () => {
    const prs = read({ earlier: [{ repo: pr.repo, number: 804, at: null, source: 'manual', workstream: ws('rv-pasted') }] });
    expect(moreReviewSessions(QUEUE, prs, Date.now(), {})).toEqual([]);
    expect(moreReviewSessions(QUEUE, prs, Date.now(), mark('rv-pasted', 0))).toEqual([expect.objectContaining({ number: 804, title: 'Forward' })]);
  });

  it('never take a review of your own PR, even one this browser marked, once only earlier lists it', () => {
    const prs = read({ earlier: [{ repo: pr.repo, number: 804, at: null, source: 'manual', workstream: ws('my-own') }] });
    const mine = { 'p|my-own': { ...pr, author: 'E2E-Octocat', session: ws('my-own'), at: 0 } };
    expect(moreReviewSessions(QUEUE, prs, Date.now(), mine)).toEqual([]);
    expect(moreReviewSessions(QUEUE, prs, 0, mine)).toEqual([]);   // nor while the mark is fresh
  });

  it('take a just-made session for two minutes, before a read lists its link', () => {
    const now = Date.now();
    expect(moreReviewSessions(QUEUE, null, now, mark('rv-new', now))).toEqual([expect.objectContaining({ number: 804 })]);
    expect(moreReviewSessions(QUEUE, null, now + 120_000, mark('rv-new', now))).toEqual([]);
  });

  it('leave out what the queue lists', () => {
    const queue = { ...QUEUE, items: [{ session: ws('rv-theirs') }] } as unknown as ReviewQueue;
    const prs = read({ rows: [{ repo: pr.repo, number: 804, author: 'e2e-fabian', linkedBy: 'manual', workstream: ws('rv-theirs') }] });
    expect(moreReviewSessions(queue, prs, Date.now(), {})).toEqual([]);
  });

  it("join the queue's item for the same PR, so a PR an agent review put there has one row", () => {
    const prs = read({ rows: [{ repo: pr.repo, number: 804, author: 'e2e-fabian', title: 'Forward', linkedBy: 'manual', workstream: ws('rv-theirs') }] });
    const agentItem = { key: 'example-org/termag#804', repo: pr.repo, number: 804, section: 'reviewing', session: null, row: null } as unknown as ReviewQueue['items'][number];
    const queue = { ...QUEUE, items: [agentItem] };
    const joined = joinReviewSessions(queue, moreReviewSessions(queue, prs, Date.now(), {}));
    expect(joined.more).toEqual([]);
    expect(joined.queue.items[0].session).toEqual(ws('rv-theirs'));
    // Another session on a PR whose item has one: its own row, under its own key.
    const twice = joinReviewSessions(joined.queue, moreReviewSessions(queue, prs, Date.now(), {}));
    expect(twice.more.map(m => m.key)).toEqual(['example-org/termag#804@p|rv-theirs']);
  });

  it('key two review sessions on one PR the queue does not list apart', () => {
    const prs = read({ rows: [
      { repo: pr.repo, number: 804, author: 'e2e-fabian', title: 'Forward', linkedBy: 'manual', workstream: ws('rv-one') },
      { repo: pr.repo, number: 804, author: 'e2e-fabian', title: 'Forward', linkedBy: 'manual', workstream: ws('rv-two') },
    ] });
    const keys = joinReviewSessions(QUEUE, moreReviewSessions(QUEUE, prs, Date.now(), {})).more.map(m => m.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("stop taking a session once it's unlinked, and keep the mark through a read that lists no links", () => {
    markReviewSession(ws('rv-gone'), pr);
    const linked = read({ earlier: [{ repo: pr.repo, number: 804, at: null, source: 'manual', workstream: ws('rv-gone') }] });
    const later = Date.now() + 120_000;
    expect(moreReviewSessions(QUEUE, linked, later).map(i => i.number)).toEqual([804]);
    expect(moreReviewSessions(QUEUE, read({}), later)).toEqual([]);           // no link listed: not a review
    pruneReviewMarks(later);                                                  // a read with no links forgets nothing
    expect(moreReviewSessions(QUEUE, linked, later).map(i => i.number)).toEqual([804]);
    pruneReviewMarks(Date.now() + 31 * 86_400_000);                           // a month on: tidied away
    expect(moreReviewSessions(QUEUE, linked, later)).toEqual([]);
  });
});
