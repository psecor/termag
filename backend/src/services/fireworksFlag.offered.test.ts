import { beforeEach, describe, expect, it, vi } from 'vitest';

const ld = vi.hoisted(() => ({ bool: vi.fn(), json: vi.fn() }));
vi.mock('./featureFlags', () => ({ boolVariation: ld.bool, jsonVariation: ld.json }));
vi.mock('../db', () => ({ prisma: {} }));

import { fireworksOfferedTo } from './fireworksFlag';

const viewer = { id: 'u1', googleEmail: 'u@example.com', displayName: 'U', unixUsername: 'u', defaultAgentProvider: 'claude' } as never;
const KIMI = 'accounts/fireworks/models/kimi-k3';
const ROUTE = { FIREWORKS_GATEWAY_URL: 'https://gateway.example/fireworks' };

describe('fireworksOfferedTo', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    ld.bool.mockReset().mockResolvedValue(true);
    ld.json.mockReset().mockResolvedValue({ models: [{ id: KIMI }] });
  });

  it("offers the viewer's list where the orchestrator has the route", async () => {
    vi.stubEnv('FIREWORKS_GATEWAY_URL', ROUTE.FIREWORKS_GATEWAY_URL);
    expect((await fireworksOfferedTo(viewer))?.models.map(m => m.id)).toEqual([KIMI]);
  });

  it('offers none without the route, and none when a flag read fails, rather than failing the menus', async () => {
    vi.stubEnv('FIREWORKS_GATEWAY_URL', '');
    expect(await fireworksOfferedTo(viewer)).toBeNull();
    vi.stubEnv('FIREWORKS_GATEWAY_URL', ROUTE.FIREWORKS_GATEWAY_URL);
    ld.bool.mockRejectedValueOnce(new Error('flag source unreachable'));
    expect(await fireworksOfferedTo(viewer)).toBeNull();
  });
});
