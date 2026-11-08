import { describe, expect, it } from 'vitest';
import { DEFAULT_NODE_UPDATE_POLICY, parseNodeUpdatePolicy } from './nodeUpdatePolicy';

describe('parseNodeUpdatePolicy', () => {
  it('is the defaults for no value: the newest 24.x security release as the floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseNodeUpdatePolicy(v)).toEqual(DEFAULT_NODE_UPDATE_POLICY);
    expect(DEFAULT_NODE_UPDATE_POLICY).toEqual({ mode: 'off', floor: '24.22.1', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z and latest, never lts/* or anything a shell or a URL would read', () => {
    expect(parseNodeUpdatePolicy({ floor: '24.18.1', target: '24.22.2', restart: 'none' })).toMatchObject({ floor: '24.18.1', target: '24.22.2' });
    for (const bad of ['lts/*', 'v24.22.2', '24', '24.22.2; id', '../24.22.2', '$(id)']) {
      expect(parseNodeUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '24.22.1', target: 'latest' });
    }
  });
});
