import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
vi.mock('./events', () => ({ registerEventHandlers: vi.fn() }));
vi.mock('./activeTargets', () => ({ loadActiveTargetsOrRetry: vi.fn(async () => { order.push('load'); }) }));

import { startSlackApp } from './app';
import { loadActiveTargetsOrRetry } from './activeTargets';

const app = { start: vi.fn(async () => { order.push('start'); }) };

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
    expect(order).toEqual(['load', 'start']);
    expect(loadActiveTargetsOrRetry).toHaveBeenCalledWith('SLACK');
  });
});
