import { describe, it, expect } from 'vitest';
import { globToRegExp, pathGlobToRegExp, scopeKey, scorePr, parseGroup, resolveGroup, orgsToList, SEED_GROUPS, DEFAULT_MIN_SHARE } from './groups';

const known = [
  { repo: 'acme/go-server-sdk', visibility: 'public', archived: false },
  { repo: 'acme/js-client-sdk', visibility: 'public', archived: false },
  { repo: 'acme/secret-sdk', visibility: 'private', archived: false },
  { repo: 'acme/old-sdk', visibility: 'public', archived: true },
  { repo: 'acme/app', visibility: 'internal', archived: false },
  { repo: 'acme/vault', visibility: 'private', archived: false },
];

describe('globToRegExp', () => {
  it('matches within a segment only', () => {
    expect(globToRegExp('acme/*-sdk').test('acme/go-server-sdk')).toBe(true);
    expect(globToRegExp('acme/*').test('acme/a/b')).toBe(false);
    expect(globToRegExp('Acme/A?P').test('acme/app')).toBe(true);
  });
});

describe('resolveGroup', () => {
  it('applies the visibility rule to patterns and topics but not explicit repos', () => {
    const g = { slug: 'x', name: 'x', sort: 0, excluded: [], members: [
      { kind: 'pattern' as const, value: 'acme/*-sdk' },
      { kind: 'repo' as const, value: 'acme/vault' },
    ] };
    expect(resolveGroup(g, known, new Map()).map(r => r.repo)).toEqual(['acme/go-server-sdk', 'acme/js-client-sdk', 'acme/vault']);
  });
  it('resolves topics, drops archived repos and exclusions', () => {
    const g = { slug: 'sdks', name: 'SDKs', sort: 0, excluded: ['acme/js-client-sdk'], members: [{ kind: 'topic' as const, value: 'sdk', org: 'acme' }] };
    const topics = new Map([['acme:sdk', ['acme/go-server-sdk', 'acme/js-client-sdk', 'acme/secret-sdk', 'acme/old-sdk']]]);
    expect(resolveGroup(g, known, topics)).toEqual([{ repo: 'acme/go-server-sdk', visibility: 'public' }]);
  });
  it('keeps an explicit repo the org list does not know, visibility unknown', () => {
    const g = { slug: 'x', name: 'x', sort: 0, excluded: [], members: [{ kind: 'repo' as const, value: 'other/thing' }] };
    expect(resolveGroup(g, known, new Map())).toEqual([{ repo: 'other/thing', visibility: '' }]);
  });
});

describe('parseGroup', () => {
  it('normalises a valid group', () => {
    expect(parseGroup({ slug: ' SDKs ', name: 'SDKs', members: [{ kind: 'topic', value: 'Some-SDK' }, { kind: 'repo', value: 'Acme/App' }], excluded: ['Acme/X'] }))
      .toEqual({ slug: 'sdks', name: 'SDKs', sort: 100, excluded: ['acme/x'], members: [{ kind: 'topic', value: 'some-sdk', org: 'example-org' }, { kind: 'repo', value: 'acme/app' }] });
  });
  it('rejects bad slugs, empty groups and malformed members', () => {
    expect(parseGroup({ slug: 'Bad Slug!', members: [{ kind: 'repo', value: 'a/b' }] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [{ kind: 'repo', value: 'nope' }] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [{ kind: 'team', value: 'a/b' }] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [{ kind: 'repo', value: 'a/b' }], excluded: ['bad'] })).toHaveProperty('error');
  });
});

describe('seeds', () => {
  it('are valid groups and need only the orgs their topics name', () => {
    for (const g of SEED_GROUPS) expect(parseGroup(g)).toEqual(g);
    expect(orgsToList(SEED_GROUPS)).toEqual([]);
  });
});

describe('pathGlobToRegExp', () => {
  it('matches ** at any depth, * and ? within a segment, case-sensitively', () => {
    expect(pathGlobToRegExp('internal/ai/**').test('internal/ai/ai_configs/service/x.go')).toBe(true);
    expect(pathGlobToRegExp('internal/ai/**').test('internal/aiother/x.go')).toBe(false);
    expect(pathGlobToRegExp('web/app/routes/app/**/projects.*.ai*').test('web/app/routes/app/projects.$projectKey.ai-configs.$aiConfigKey.tsx')).toBe(true);
    expect(pathGlobToRegExp('web/app/routes/app/**/projects.*.ai*').test('web/app/routes/app/__tests__/projects.$projectKey.ai.evaluations-test.tsx')).toBe(true);
    expect(pathGlobToRegExp('packages/e2e/playwright/e2e/aiConfig*').test('packages/e2e/playwright/e2e/aiConfigsList.spec.ts')).toBe(true);
    expect(pathGlobToRegExp('packages/e2e/playwright/e2e/aiConfig*').test('packages/e2e/playwright/e2e/sub/aiConfig.ts')).toBe(false);
    expect(pathGlobToRegExp('web/app/components/AiConfigs/**').test('web/app/components/aiconfigs/x.tsx')).toBe(false);
    expect(pathGlobToRegExp('a?c.go').test('abc.go')).toBe(true);
    expect(pathGlobToRegExp('a.go').test('abgo')).toBe(false);
  });
});

describe('scorePr', () => {
  // A product inside a monorepo: its directories, and its ticket key.
  const ac = { paths: ['internal/ai/**', 'web/components/Ai*/**'], minShare: DEFAULT_MIN_SHARE, keys: ['PROJ'] };
  const other = (n: number) => Array.from({ length: n }, (_, i) => `packages/other/f${i}.ts`);

  it('takes a PR with at least the share of its files under the paths', () => {
    expect(scorePr(ac, ['internal/ai/ai_configs/sync/a.go', 'internal/ai/ai_configs/sync/b.go', 'go.mod'], 'Add the config sync domain')).toEqual({ matched: 2, inGroup: true });
  });
  it('leaves out a repo-wide sweep that grazes the paths', () => {
    expect(scorePr(ac, ['web/components/AiConfigs/a.tsx', 'web/components/AiMonitoring/b.tsx', ...other(29)], 'chore(lint): promote root oxlint warn rules to errors')).toEqual({ matched: 2, inGroup: false });
  });
  it('takes a low-share PR that touches the paths and carries the ticket key', () => {
    expect(scorePr(ac, ['internal/ai/ai_configs/service/eval.go', ...other(6)], '[PROJ-3181] Add tools to EvaluationResponse')).toEqual({ matched: 1, inGroup: true });
    expect(scorePr(ac, other(6), '[PROJ-3523] remove my flag')).toEqual({ matched: 0, inGroup: false });
    expect(scorePr(ac, ['internal/ai/x.go', ...other(9)], 'PROJECT-1 not the key')).toEqual({ matched: 1, inGroup: false });
  });
  it('takes nothing without files', () => {
    expect(scorePr(ac, [], '[PROJ-1] empty')).toEqual({ matched: 0, inGroup: false });
  });
});

describe('path members', () => {
  const pathMember = (paths: string[], minShare?: number, keys?: string[]) => ({ kind: 'path' as const, value: 'acme/app', paths, minShare, keys });

  it('parse with defaults, normalised', () => {
    expect(parseGroup({ slug: 'x', members: [{ kind: 'path', value: 'Acme/App', paths: [' a/** ', 'a/**', 'b.go'], keys: ['aic'] }] }))
      .toMatchObject({ members: [{ kind: 'path', value: 'acme/app', paths: ['a/**', 'b.go'], minShare: 0.2, keys: ['AIC'] }] });
  });
  it('reject a member without paths, a bad glob, a bad share or a bad key', () => {
    expect(parseGroup({ slug: 'x', members: [{ kind: 'path', value: 'acme/app', paths: [] }] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [{ kind: 'path', value: 'acme/app', paths: ['a b'] }] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [{ kind: 'path', value: 'acme/app', paths: ['a/**'], minShare: 1.5 }] })).toHaveProperty('error');
    expect(parseGroup({ slug: 'x', members: [{ kind: 'path', value: 'acme/app', paths: ['a/**'], keys: ['PROJ-1'] }] })).toHaveProperty('error');
  });
  it('resolve to a scoped repo at any visibility, merged per repo', () => {
    const g = { slug: 'x', name: 'x', sort: 0, excluded: [], members: [pathMember(['a/**'], 0.3, ['AIC']), pathMember(['b/**'], 0.1, ['ACX'])] };
    expect(resolveGroup(g, known, new Map())).toEqual([{ repo: 'acme/app', visibility: 'internal', scope: { paths: ['a/**', 'b/**'], minShare: 0.1, keys: ['AIC', 'ACX'] } }]);
  });
  it('lose to a whole-repo member of the same repo, and to an exclusion', () => {
    const whole = { slug: 'x', name: 'x', sort: 0, excluded: [], members: [pathMember(['a/**']), { kind: 'repo' as const, value: 'acme/app' }] };
    expect(resolveGroup(whole, known, new Map())).toEqual([{ repo: 'acme/app', visibility: 'internal' }]);
    const excluded = { slug: 'x', name: 'x', sort: 0, excluded: ['acme/app'], members: [pathMember(['a/**'])] };
    expect(resolveGroup(excluded, known, new Map())).toEqual([]);
  });
});

describe('scopeKey', () => {
  it('is the same whatever the key and array order, as after a JSONB round-trip', () => {
    const a = { paths: ['b/**', 'a/**'], minShare: 0.2, keys: ['AIC'] };
    const b = JSON.parse('{"keys":["AIC"],"minShare":0.2,"paths":["a/**","b/**"]}');
    expect(scopeKey(a)).toBe(scopeKey(b));
    expect(scopeKey(a)).not.toBe(scopeKey({ ...a, minShare: 0.3 }));
    expect(scopeKey(a)).not.toBe(scopeKey({ ...a, paths: ['a/**'] }));
    expect(scopeKey(null)).toBeNull();
  });
});
