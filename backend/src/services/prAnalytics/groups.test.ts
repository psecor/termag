import { describe, it, expect } from 'vitest';
import { globToRegExp, parseGroup, resolveGroup, orgsToList, SEED_GROUPS } from './groups';

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
    for (const g of SEED_GROUPS) expect(parseGroup(g)).not.toHaveProperty('error');
    expect(orgsToList(SEED_GROUPS)).toEqual([]);
  });
});
