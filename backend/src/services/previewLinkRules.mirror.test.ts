// The Share dialog checks a preview link's name as it's typed with a copy of
// this file's grammar (frontend/src/previewLinks/rules.ts): the frontend can't
// import the backend. This runs both on the same names and fails when they
// disagree, so a change to one is made to the other.
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { MAX_LINK_LIFETIME_MS, MAX_TTL_HOURS, MIN_TTL_HOURS, RESERVED_PREVIEW_NAMES, nameRefusal, suggestName } from './previewLinkRules';

// A computed path, so the backend's tsc doesn't compile the frontend's file.
const FRONTEND_RULES = join(resolve(__dirname, '../../..'), 'frontend/src/previewLinks/rules.ts');

const NAMES = [
  'ab', 'abc', 'a-b', '-ab', 'ab-', 'Abc', 'a_b', 'a.b', 'shop', 'shop-feature-x', 'a'.repeat(40), 'a'.repeat(41), 'ab--cd', 'xn--abc',
  'a--b', '9lives', '', ' abc', ...RESERVED_PREVIEW_NAMES,
];
const SUGGESTIONS: Array<[string, string]> = [['Shop', 'main'], ['Shop', 'feature-x'], ['My App!', 'fix_1'], ['x', 'main'], ['--', 'main'], ['a'.repeat(50), 'ws'], ['xn', '--x']];

describe("the frontend's copy of the preview-link name rules", () => {
  it('refuses exactly the names the server refuses, for the same reason', async () => {
    const fe = await import(FRONTEND_RULES);
    for (const n of NAMES) expect([n, fe.nameRefusal(n)]).toEqual([n, nameRefusal(n)]);
    expect([...fe.RESERVED_PREVIEW_NAMES].sort()).toEqual([...RESERVED_PREVIEW_NAMES].sort());
  });

  it('suggests the same names, and has the same lifetime bounds', async () => {
    const fe = await import(FRONTEND_RULES);
    for (const [p, w] of SUGGESTIONS) expect([p, w, fe.suggestName(p, w)]).toEqual([p, w, suggestName(p, w)]);
    expect([fe.MIN_TTL_HOURS, fe.MAX_TTL_HOURS]).toEqual([MIN_TTL_HOURS, MAX_TTL_HOURS]);
    expect(fe.MAX_LINK_LIFETIME_DAYS * 86_400_000).toBe(MAX_LINK_LIFETIME_MS);
  });
});
