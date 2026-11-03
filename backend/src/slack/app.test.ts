import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
vi.mock('./events', () => ({ registerEventHandlers: vi.fn() }));
vi.mock('./activeTargets', () => ({ loadActiveTargetsOrRetry: vi.fn(async () => { order.push('load'); }) }));
vi.mock('./agentStore', () => ({ loadAgentThreadsOrRetry: vi.fn(async () => { order.push('load agent threads'); }) }));
vi.mock('./agentSession', () => ({
  stopAgentRunsForRestart: vi.fn(() => { order.push('stop agent runs'); return Promise.resolve(0); }),
  acceptAgentRuns: vi.fn(() => { order.push('accept agent runs'); }),
}));

import { startSlackApp, stopSlackApp } from './app';
import { loadActiveTargetsOrRetry } from './activeTargets';

const app = { start: vi.fn(async () => { order.push('start'); }), stop: vi.fn(async () => { order.push('stop'); }) };

describe('startSlackApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('loads the saved /t targets before connecting', async () => {
    expect(await startSlackApp(app)).toBe(true);
    expect(order).toEqual(['load', 'load agent threads', 'accept agent runs', 'start']);
    expect(loadActiveTargetsOrRetry).toHaveBeenCalledWith('SLACK');
  });
});

describe('stopSlackApp', () => {
  beforeEach(() => { order.length = 0; });

  it('stops this process\'s runs at once, then closes the connection', async () => {
    await stopSlackApp(app);
    expect(order).toEqual(['stop agent runs', 'stop']);
  });

  it('still stops the runs when closing the connection throws', async () => {
    app.stop.mockRejectedValueOnce(new Error('socket already closed'));
    await expect(stopSlackApp(app)).rejects.toThrow('socket already closed');
    expect(order).toEqual(['stop agent runs']);
  });
});
