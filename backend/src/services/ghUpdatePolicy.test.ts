import { describe, expect, it } from 'vitest';
import { DEFAULT_GH_UPDATE_POLICY, parseGhUpdatePolicy } from './ghUpdatePolicy';

describe('parseGhUpdatePolicy', () => {
  it('is the defaults for no value: the advisories\' floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseGhUpdatePolicy(v)).toEqual(DEFAULT_GH_UPDATE_POLICY);
    expect(DEFAULT_GH_UPDATE_POLICY).toEqual({ mode: 'off', floor: '2.102.0', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z and latest, never another tag or anything a shell or apt would read', () => {
    expect(parseGhUpdatePolicy({ floor: '2.97.0', target: '2.103.3', restart: 'idle' })).toMatchObject({ floor: '2.97.0', target: '2.103.3', restart: 'idle' });
    for (const bad of ['stable', '2.103', '2.103.3; rm -rf /', '2.103.3 gh=1.0.0', '2.45.0-1ubuntu0.3', '$(id)']) {
      expect(parseGhUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '2.102.0', target: 'latest' });
    }
  });
});
