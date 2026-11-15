// The words on a session's sidebar card (chat/sessionCard.ts).
import { describe, expect, it } from 'vitest';
import { boxParked, boxTip, chipAge, chipKind, chipSince, chipTip, prPill, projectTip, shortAge } from './sessionCard';

const NOW = Date.parse('2026-11-13T20:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('the status chip', () => {
  it('colours Needs you one way whatever it waits on, and a failed turn red', () => {
    expect(chipKind('approval')).toBe('needs');
    expect(chipKind('unread')).toBe('needs');
    expect(chipKind('error')).toBe('error');
    expect(chipKind('working')).toBe('working');
    expect(chipKind('done')).toBe('done');
    expect(chipKind('off')).toBe('off');
  });

  it('says the time in its status in one unit', () => {
    // Under a minute is 1m.
    expect(shortAge(0)).toBe('1m');
    expect(shortAge(20_000)).toBe('1m');
    expect(shortAge(59_999)).toBe('1m');
    expect(shortAge(60_000)).toBe('1m');
    expect(shortAge(8 * MIN + 59_000)).toBe('8m');
    expect(shortAge(3 * HOUR + 40 * MIN)).toBe('3h');
    expect(shortAge(2 * DAY + 5 * HOUR)).toBe('2d');
    expect(chipAge(ago(14 * MIN), NOW)).toBe('14m');
    expect(chipAge(null, NOW)).toBeNull();
    expect(chipAge('not a date', NOW)).toBeNull();
    // A clock a little ahead of the server's never reads negative.
    expect(chipAge(new Date(NOW + 5000).toISOString(), NOW)).toBe('1m');
  });

  it('means one thing per mark, in words', () => {
    expect(chipTip({ kind: 'working', unseen: false }, '7m')).toBe('Working for 7m');
    expect(chipTip({ kind: 'approval', unseen: false, text: 'Needs you · approval' }, '8m')).toBe('Needs you · approval, waiting 8m');
    // A finished review is Needs you too (chat/rowState.ts), and says so, not that it asked something.
    expect(chipTip({ kind: 'unread', unseen: false, text: 'Needs you · review #12 ready' }, '22m')).toBe('Needs you · review #12 ready, waiting 22m');
    expect(chipTip({ kind: 'unread', unseen: false }, '8m')).toBe('Needs you, waiting 8m');
    expect(chipTip({ kind: 'error', unseen: false, text: 'Needs you · failed' }, '2d')).toBe('Needs you · failed, 2d ago');
    expect(chipTip({ kind: 'done', unseen: false }, '35m')).toBe('Idle for 35m: it finished its turn');
    expect(chipTip({ kind: 'done', unseen: true }, '18m')).toBe("Idle for 18m, and you haven't looked yet");
    expect(chipTip({ kind: 'off', unseen: false }, '2d')).toBe('Not running for 2d: opening it starts it again');
    expect(chipTip({ kind: 'off', unseen: false }, '2d', true)).toBe('Not running for 2d: its box is parked, and opening it wakes the box');
    // Unseen is a dot, not a state: a stop you haven't looked at keeps its words and says so.
    expect(chipTip({ kind: 'off', unseen: true }, '5m')).toBe("Not running for 5m, and you haven't looked yet: opening it starts it again");
    expect(chipTip({ kind: 'working', unseen: false }, null)).toBe('Working');
  });
});

describe('the box icon', () => {
  it('says which box, whether it is up, its size and how long', () => {
    expect(boxTip({ name: 'termag-18', status: 'ready', instanceType: 'm7i.2xlarge', lastConnectedAt: ago(6 * HOUR) }, 'termag-18', NOW))
      .toBe('termag-18\nRunning · m7i.2xlarge\nup 6h');
  });

  it('says a parked box wakes when a session opens', () => {
    const box = { name: 'review-box', status: 'stopped' as const, instanceType: 'm7i.xlarge' };
    expect(boxParked(box)).toBe(true);
    expect(boxParked({ status: 'hibernated' })).toBe(true);
    expect(boxParked({ status: 'ready' })).toBe(false);
    expect(boxTip(box, 'review-box', NOW)).toBe('review-box\nParked · m7i.xlarge\nOpening a session here wakes it');
  });

  it("is only the label for a box that isn't the person's own", () => {
    expect(boxTip(undefined, "Ada's box", NOW)).toBe("Ada's box");
  });
});

describe('the project icon', () => {
  it('names the project, its repositories, its sessions and PRs, and the model', () => {
    expect(projectTip({ name: 'termag + desktop', repos: ['example-org/termag', 'example-org/termag-desktop'], sessions: 3, prs: 1, model: 'Claude' }))
      .toBe('termag + desktop\nexample-org/termag\nexample-org/termag-desktop\n3 sessions · 1 PR\nModel: Claude');
    expect(projectTip({ name: 'Scratch', repos: [], sessions: 1, prs: 0, model: 'Kimi' }))
      .toBe('Scratch\nNo repository\n1 session · 0 PRs\nModel: Kimi');
  });
});

it('shows a PR as its number', () => {
  expect(prPill('example-org/termag#1802')).toBe('#1802');
  expect(prPill(null)).toBeNull();
});

describe("the chip's time", () => {
  const row = (over: Partial<Parameters<typeof chipSince>[0]> = {}) => ({
    status: 'not_running' as const, ring: null, review: null, updatedAt: ago(MIN), statusSince: null, ...over,
  });

  it("is never its project's: a session with no status of its own has no time to show", () => {
    // buildRows gives such a row its project's lastActiveAt; the chip read "Not running for 1m".
    expect(chipSince(row(), { ownStatus: false, live: false })).toBeNull();
    expect(chipSince(row({ statusSince: ago(3 * DAY) }), { ownStatus: false, live: true })).toBeNull();
  });

  it('counts from when the session entered its status, then from its last status write', () => {
    expect(chipSince(row({ status: 'idle', statusSince: ago(2 * HOUR), updatedAt: ago(MIN) }), { ownStatus: true, live: false })).toBe(ago(2 * HOUR));
    expect(chipSince(row({ status: 'idle', updatedAt: ago(5 * MIN) }), { ownStatus: true, live: false })).toBe(ago(5 * MIN));
  });

  it("counts a review-led row from its review, unless the open chat's live status leads", () => {
    const review = { state: 'done', at: ago(20 * MIN), doneAt: ago(9 * MIN) } as never;
    const led = row({ status: 'idle', ring: 'done', review, statusSince: ago(4 * HOUR) });
    expect(chipSince(led, { ownStatus: true, live: false })).toBe(ago(9 * MIN));
    expect(chipSince(led, { ownStatus: true, live: true })).toBe(ago(4 * HOUR));
  });
});
