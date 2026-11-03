import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from '../../chat/reviews';

const send = vi.fn(async () => true);
vi.mock('../../services/api', async orig => ({ ...(await orig<object>()), chatApi: { send: (...a: unknown[]) => send(...(a as [])) } }));
const { checkTheFixes, fixesAsked, fixesFailed, fixesSending, followedUp } = await import('./FollowUpStrip');

beforeAll(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } });
});

const item = (workstream: string, headSha: string | null): QueueItem => ({
  key: 'example-org/termag#804', repo: 'example-org/termag', number: 804, title: 'Forward', author: 'e2e-fabian', url: '',
  section: 'pushed', why: [], at: null, row: null, agent: null, deferredUntil: null,
  session: { projectId: 'p', projectName: 'termag', workstream },
  round: {
    repo: 'example-org/termag', number: 804, round: 1, headSha: 'aaa', event: 'REQUEST_CHANGES', comments: 2, postedAt: '',
    now: { state: 'open', headSha, askedAgain: headSha === null, title: 'Forward', author: 'e2e-fabian', url: '' },
  },
} as QueueItem);

describe('Check the fixes', () => {
  it('is asked once per head', async () => {
    const it1 = item('rv-head', 'bbb');
    expect(followedUp(it1)).toBe('bbb');
    expect(fixesAsked(it1)).toBe(false);
    expect(await checkTheFixes(it1)).toBe(true);
    expect(fixesAsked(it1)).toBe(true);
    expect(fixesAsked(item('rv-head', 'ccc'))).toBe(false);
  });

  it("shows a send under way, and one that failed, to wherever it's looked at", async () => {
    vi.useFakeTimers();
    const it1 = item('rv-fail', 'ddd');
    send.mockClear();
    send.mockRejectedValue(new Error('the chat runner is not up'));
    const going = checkTheFixes(it1);
    expect(fixesSending(it1)).toBe(true);
    await vi.runAllTimersAsync();
    expect(await going).toBe(false);
    expect(send).toHaveBeenCalledTimes(5);
    expect(fixesSending(it1)).toBe(false);
    expect(fixesFailed(it1)).toBe(true);
    expect(fixesAsked(it1)).toBe(false);
    vi.useRealTimers();
    send.mockResolvedValue(true);
    expect(await checkTheFixes(it1)).toBe(true);
    expect(fixesFailed(it1)).toBe(false);
  });

  it("sends nothing while GitHub hasn't said what the head is, so it isn't sent again once it does", async () => {
    const it1 = item('rv-nohead', null);
    expect(followedUp(it1)).toBeNull();
    expect(fixesAsked(it1)).toBe(false);
    expect(await checkTheFixes(it1)).toBe(false);
    expect(fixesAsked(item('rv-nohead', 'eee'))).toBe(false);   // the head read: one to send now
  });
});
