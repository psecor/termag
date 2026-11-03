import { beforeEach, describe, expect, it, vi } from 'vitest';

// An admin's uploaded export (POST /api/admin/prs/teams/import): validated, then the same sync as the file or the API.
const writes = vi.hoisted(() => ({ upserts: [] as string[], deleted: [] as unknown[], created: [] as Array<{ teamKey: string; login: string }> }));
vi.mock('../../db', () => {
  const tx = {
    team: { upsert: async ({ where }: { where: { key: string } }) => { writes.upserts.push(where.key); } },
    teamMembership: {
      deleteMany: async ({ where }: { where: unknown }) => { writes.deleted.push(where); },
      // skipDuplicates, as Postgres does it: a row with the same team, login and start is not written twice.
      createMany: async ({ data }: { data: Array<{ teamKey: string; login: string; start: Date }> }) => {
        const seen = new Set<string>();
        const fresh = data.filter(d => { const k = `${d.teamKey}|${d.login}|${d.start.toISOString()}`; if (seen.has(k)) return false; seen.add(k); return true; });
        writes.created.push(...fresh);
        return { count: fresh.length };
      },
    },
  };
  return { prisma: { $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx), userCredential: { findMany: async () => [] } } };
});

const { exportProblem, syncTeams } = await import('./teamSync');

const EXPORT = {
  teams: [{ tag: 'platform-team', label: 'Platform', parent: 'producteng' }, { tag: 'producteng', label: 'Product Eng', parent: null }],
  members: {
    'platform-team': { current: [{ email: 'ada@example.com', github: 'Ada', start: '2026-09-17' }], former: [{ email: 'bo@example.com', start: '2026-09-17', end: '2026-10-01' }] },
    producteng: { current: [{ email: 'cy@example.com', github: 'cy', start: '2026-09-17', open_start: true }] },
  },
};

beforeEach(() => { writes.upserts = []; writes.deleted = []; writes.created = []; });

describe('exportProblem', () => {
  it('takes a real export', () => {
    expect(exportProblem(EXPORT)).toBeNull();
  });
  it('names what is wrong with anything else', () => {
    expect(exportProblem(null)).toMatch(/JSON object/);
    expect(exportProblem([])).toMatch(/JSON object/);
    expect(exportProblem({ teams: [], members: {} })).toBe('The export has no teams');
    expect(exportProblem({ teams: [{ label: 'x' }], members: {} })).toBe('Every team needs a tag');
    expect(exportProblem({ teams: [{ tag: 'a' }] })).toBe('The export has no members');
    expect(exportProblem({ teams: [{ tag: 'a' }], members: { a: { current: 'nope' } } })).toMatch(/roster of a/);
    expect(exportProblem({ teams: Array.from({ length: 1001 }, (_, i) => ({ tag: `t${i}` })), members: {} })).toMatch(/more than 1000/);
  });
  it('takes only tags and parents the admin routes take as team keys (Devin, #1094)', () => {
    expect(exportProblem({ teams: [{ tag: 'Platform' }], members: {} })).toMatch(/"Platform" is not a team key/);
    expect(exportProblem({ teams: [{ tag: 'platform team' }], members: {} })).toMatch(/not a team key/);
    expect(exportProblem({ teams: [{ tag: 'platform-team', parent: 'ProductEng' }], members: {} })).toMatch(/parent "ProductEng" is not a team key/);
    expect(exportProblem({ teams: [{ tag: 'platform-team', parent: null }], members: {} })).toBeNull();
  });
  it('refuses a roster entry that would break the sync, saying which (Devin, #1094)', () => {
    const one = (m: unknown) => exportProblem({ teams: [{ tag: 'a' }], members: { a: { current: [m] } } });
    expect(one(null)).toBe('A member of a is not an object');
    expect(one({ github: 42, start: '2026-09-17' })).toBe('A member of a has a github that is not text');
    expect(one({ email: 'x@example.com' })).toMatch(/no valid start date/);
    expect(one({ start: '2026-09-17', end: 'junk' })).toMatch(/end that is not a date/);
    expect(one({ email: 'x@example.com', github: null, start: '2026-09-17', end: null })).toBeNull();
  });
});

describe('syncTeams with an uploaded export', () => {
  it('writes the teams and the members it can resolve, the rest skipped, as source upload', async () => {
    const r = await syncTeams({ exportData: EXPORT, loginMap: new Map([['bo@example.com', 'bo']]), apiBase: 'http://never', exportPath: '/never' });
    expect(r).toEqual({ teams: 2, members: 3, skipped: 0, source: 'upload' });
    expect(writes.upserts).toEqual(['platform-team', 'producteng']);
    expect(writes.created.map(m => `${m.teamKey}:${m.login}`)).toEqual(['platform-team:ada', 'platform-team:bo', 'producteng:cy']);
    // Synced rows of those teams only are replaced; manual ones stay.
    expect(writes.deleted).toEqual([{ source: 'synced', teamKey: { in: ['platform-team', 'producteng'] } }]);
  });
  it('reports what was written, not what was listed: a member twice in a roster is one row (Devin, #1094)', async () => {
    const twice = { start: '2026-09-17', email: 'ada@example.com', github: 'ada' };
    const r = await syncTeams({ exportData: { teams: [{ tag: 'platform-team' }], members: { 'platform-team': { current: [twice], former: [twice] } } }, loginMap: new Map() });
    expect(r.members).toBe(1);
  });
  it('refuses a broken export before writing anything', async () => {
    await expect(syncTeams({ exportData: { teams: [] }, loginMap: new Map() })).rejects.toThrow('The export has no teams');
    expect(writes.upserts).toEqual([]);
    expect(writes.deleted).toEqual([]);
  });
});
