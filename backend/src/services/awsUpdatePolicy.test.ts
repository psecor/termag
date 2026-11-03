import { describe, expect, it } from 'vitest';
import { DEFAULT_AWS_UPDATE_POLICY, parseAwsUpdatePolicy } from './awsUpdatePolicy';

describe('parseAwsUpdatePolicy', () => {
  it('is the defaults for no value: the advisories\' floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseAwsUpdatePolicy(v)).toEqual(DEFAULT_AWS_UPDATE_POLICY);
    expect(DEFAULT_AWS_UPDATE_POLICY).toEqual({ floor: '2.35.3', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z and latest, never anything a shell or a URL would read', () => {
    expect(parseAwsUpdatePolicy({ floor: '2.38.5', target: '2.39.2', restart: 'idle' })).toMatchObject({ floor: '2.38.5', target: '2.39.2', restart: 'idle' });
    for (const bad of ['stable', '2.39', '2.39.2; rm -rf /', '../2.39.2', '2.39.2/../x', '$(id)']) {
      expect(parseAwsUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '2.35.3', target: 'latest' });
    }
  });
});
