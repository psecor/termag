import { describe, expect, it, vi } from 'vitest';

const ld = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => ld.on.has(key)) }));

import { slackRouterEnabled, slackRouterOverviewEnabled, spaceChannelsEnabled } from './flags';

const user = { id: 'u1' } as unknown as Parameters<typeof spaceChannelsEnabled>[0];

describe('spaces in Slack gates', () => {
  it('reads each flag, off by default', async () => {
    ld.on = new Set();
    expect(await spaceChannelsEnabled(user)).toBe(false);
    expect(await slackRouterEnabled(user)).toBe(false);
    ld.on = new Set(['space-channels-enabled', 'slack-router-enabled']);
    expect(await spaceChannelsEnabled(user)).toBe(true);
    expect(await slackRouterEnabled(user)).toBe(true);
  });

  it('turns the overview on only where the router is on too', async () => {
    ld.on = new Set(['slack-router-overview-enabled']);
    expect(await slackRouterOverviewEnabled(user)).toBe(false);
    ld.on.add('slack-router-enabled');
    expect(await slackRouterOverviewEnabled(user)).toBe(true);
  });
});
