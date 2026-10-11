import { describe, it, expect } from 'vitest';
import { resolveTermagVersion, type VersionDeps } from './termagVersion';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const missing = () => Promise.reject(new Error('ENOENT'));

function deps(over: Partial<VersionDeps>): VersionDeps {
  return { env: {}, gitHead: missing, readBaked: missing, ...over };
}

describe('resolveTermagVersion', () => {
  it('prefers the env, then the checkout, then the baked file', async () => {
    const all = { gitHead: async () => `${B}\n`, readBaked: async () => `${C}\n` };
    expect(await resolveTermagVersion(deps({ env: { TERMAG_GIT_SHA: A }, ...all }))).toEqual({ sha: A, source: 'env' });
    expect(await resolveTermagVersion(deps(all))).toEqual({ sha: B, source: 'git' });
    expect(await resolveTermagVersion(deps({ readBaked: all.readBaked }))).toEqual({ sha: C, source: 'baked' });
  });
  it('ignores values that are not full SHAs', async () => {
    const got = await resolveTermagVersion(deps({ env: { TERMAG_GIT_SHA: 'main' }, readBaked: async () => '\n' }));
    expect(got).toEqual({ sha: null, source: 'unknown' });
  });
  it('lower-cases what it reports', async () => {
    expect((await resolveTermagVersion(deps({ env: { TERMAG_GIT_SHA: A.toUpperCase() } }))).sha).toBe(A);
  });
});
