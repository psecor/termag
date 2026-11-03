import { describe, it, expect } from 'vitest';
import { buildSyncPlan, orgApiBase, orgExportPath, parseExport, type OrgMember, type OrgTeam } from './teamSync';

const registry: OrgTeam[] = [
  { tag: 'platform-team', label: 'Platform', parent: 'producteng', hidden: false },
  { tag: 'observability', label: 'Observability', parent: 'producteng', hidden: true },
];
const m = (o: Partial<OrgMember>): OrgMember => ({ start: '2026-10-03', ...o });
const byTag = (rows: Record<string, OrgMember[]>) => new Map(Object.entries(rows));

describe('buildSyncPlan', () => {
  it('maps the registry to teams, in its order, with hidden and parent', () => {
    const plan = buildSyncPlan(registry, new Map(), () => null);
    expect(plan.teams).toEqual([
      { key: 'platform-team', name: 'Platform', parent: 'producteng', hidden: false, sort: 0 },
      { key: 'observability', name: 'Observability', parent: 'producteng', hidden: true, sort: 1 },
    ]);
  });

  it('resolves a login from the org-tree github, lowercased, and from the fallback map', () => {
    const plan = buildSyncPlan(registry, byTag({
      'platform-team': [m({ email: 'hbrown@example.com', name: 'Hal Brown', github: 'lhenry' })],
      observability: [m({ email: 'jrae@example.com', name: 'Jus Rae', github: null })],
    }), (email, github) => github ?? (email === 'jrae@example.com' ? 'JustinR' : null));
    expect(plan.members).toEqual([
      { teamKey: 'platform-team', login: 'lhenry', email: 'hbrown@example.com', name: 'Hal Brown', start: new Date('2026-10-03'), end: null, openStart: false },
      { teamKey: 'observability', login: 'justinr', email: 'jrae@example.com', name: 'Jus Rae', start: new Date('2026-10-03'), end: null, openStart: false },
    ]);
  });

  it('skips a member with no login at all, and one with a bad date', () => {
    const plan = buildSyncPlan(registry, byTag({
      'platform-team': [m({ email: 'jsmith@example.com', github: null }), m({ email: 'x@x.com', github: 'x', start: 'not-a-date' })],
    }), () => null);
    expect(plan.members).toEqual([]);
    expect(plan.skipped).toBe(2);
  });

  it('skips a member whose end is not a date, rather than failing the whole write (Devin, #1094)', () => {
    const plan = buildSyncPlan(registry, byTag({
      'platform-team': [m({ github: 'ok' }), m({ github: 'bad', end: 'junk' })],
    }), (_e, gh) => gh);
    expect(plan.members.map(x => x.login)).toEqual(['ok']);
    expect(plan.skipped).toBe(1);
  });

  it('carries open_start and a former end', () => {
    const plan = buildSyncPlan(registry, byTag({
      'platform-team': [m({ email: 'a@x.com', github: 'a', open_start: true, end: '2026-10-20' })],
    }), (_email, github) => github);
    expect(plan.members[0]).toMatchObject({ openStart: true, end: new Date('2026-10-20') });
  });
});

describe('orgApiBase', () => {
  it('is null when unset, and trims a trailing slash', () => {
    expect(orgApiBase({} as NodeJS.ProcessEnv)).toBeNull();
    expect(orgApiBase({ ORG_EXPLORER_API: 'http://10.0.0.5:3042/org/api/' } as unknown as NodeJS.ProcessEnv)).toBe('http://10.0.0.5:3042/org/api');
  });
});

describe('export', () => {
  it('reads a file path when set, else null', () => {
    expect(orgExportPath({} as NodeJS.ProcessEnv)).toBeNull();
    expect(orgExportPath({ ORG_EXPLORER_EXPORT: '/tmp/teams.json' } as unknown as NodeJS.ProcessEnv)).toBe('/tmp/teams.json');
  });
  it('parses the export into the registry and each team\'s members', () => {
    const { registry, membersByTag } = parseExport({
      teams: [{ tag: 'platform-team', label: 'Platform', parent: 'producteng' }],
      members: { 'platform-team': { current: [m({ email: 'a@x.com', github: 'a' })], former: [m({ email: 'b@x.com', github: 'b', end: '2026-10-01' })] } },
    });
    expect(registry).toEqual([{ tag: 'platform-team', label: 'Platform', parent: 'producteng' }]);
    expect(membersByTag.get('platform-team')?.map(x => x.github)).toEqual(['a', 'b']);
  });
  it('tolerates a missing members map', () => {
    expect(parseExport({ teams: [] })).toEqual({ registry: [], membersByTag: new Map() });
  });
});
