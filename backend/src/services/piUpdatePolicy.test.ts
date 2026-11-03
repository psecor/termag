import { describe, expect, it } from 'vitest';
import { DEFAULT_PI_UPDATE_POLICY, parsePiUpdatePolicy } from './piUpdatePolicy';

describe('parsePiUpdatePolicy', () => {
  it('is the defaults for no value: the advisories\' floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parsePiUpdatePolicy(v)).toEqual(DEFAULT_PI_UPDATE_POLICY);
    expect(DEFAULT_PI_UPDATE_POLICY).toEqual({ floor: '0.79.0', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z and latest, never another dist-tag', () => {
    expect(parsePiUpdatePolicy({ floor: '1.0.2', target: '1.4.0', restart: 'idle' })).toMatchObject({ floor: '1.0.2', target: '1.4.0', restart: 'idle' });
    for (const bad of ['legacy-node20', 'stable', '1.4', '1.4.0; rm -rf ~']) expect(parsePiUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '0.79.0', target: 'latest' });
  });
});
