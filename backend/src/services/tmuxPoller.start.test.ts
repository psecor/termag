import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TMUX_POLLER_USAGE_FILE = join(mkdtempSync(join(tmpdir(), 'tmux-poller-')), 'usage.json');

let releaseFindMany: (rows: unknown[]) => void = () => {};
const findMany = vi.fn(() => new Promise<unknown[]>(resolve => { releaseFindMany = resolve; }));
vi.mock('../db', () => ({ prisma: { workflow: { findMany } } }));
vi.mock('./tmux', () => ({ capturePaneText: vi.fn(), isAgentRunning: vi.fn(), sessionName: vi.fn() }));
vi.mock('./status', () => ({ getStatus: vi.fn(), setStatus: vi.fn(), notifyStatusChange: vi.fn() }));
vi.mock('../providers/registry', () => ({ PROVIDERS: {}, pollerProviderIds: () => ['cursor'] }));

const { startTmuxPoller, stopTmuxPoller } = await import('./tmuxPoller');

beforeEach(() => { vi.useFakeTimers(); findMany.mockClear(); });
afterEach(() => { stopTmuxPoller(); vi.useRealTimers(); });

describe('startTmuxPoller as leadership comes and goes', () => {
  it('a stop while the start is still reading the database leaves no timers armed', async () => {
    const start = startTmuxPoller();
    stopTmuxPoller();
    releaseFindMany([]);
    await start;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second start while one is in flight joins it instead of arming a second set of timers', async () => {
    const first = startTmuxPoller();
    const second = startTmuxPoller();
    expect(findMany).toHaveBeenCalledTimes(1);
    releaseFindMany([]);
    await Promise.all([first, second]);
    expect(vi.getTimerCount()).toBe(2); // the poll and the persist interval, once
    stopTmuxPoller();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts again after a stop that cut a start short', async () => {
    const cut = startTmuxPoller();
    stopTmuxPoller();
    releaseFindMany([]);
    await cut;
    const again = startTmuxPoller();
    releaseFindMany([]);
    await again;
    expect(vi.getTimerCount()).toBe(2);
  });
});
