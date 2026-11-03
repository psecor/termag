// The Prisma queries behind space memory's history (spaceStorePrisma.ts), run
// against a small evaluator of the `where` subset they use, since there is no
// database harness: the filter must happen in the database, before `take`.
import { describe, expect, it } from 'vitest';
import { isMemoryEvent, memoryEventsQuery, pruneEventsWhere } from './spaceMemory';

type Row = { id: string; spaceId: string; at: Date; action: string; path: string | null };
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every(w => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some(w => matches(row, w));
    if (key === 'NOT') {
      // SQL: NOT over a NULL comparison is NULL, which no row satisfies.
      if (row.path === null) return false;
      return !matches(row, cond as Where);
    }
    const value = (row as Record<string, unknown>)[key];
    if (cond === null) return value === null;
    if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
    return Object.entries(cond as Where).every(([op, arg]) => {
      if (value === null || value === undefined) return false;
      switch (op) {
        case 'startsWith': return String(value).startsWith(arg as string);
        case 'contains': return String(value).includes(arg as string);
        case 'in': return (arg as unknown[]).includes(value);
        case 'lt': return (value as Date) < (arg as Date);
        case 'gte': return (value as Date) >= (arg as Date);
        default: throw new Error(`no ${op}`);
      }
    });
  });
}

const t = (n: number) => new Date(Date.UTC(2026, 9, 27) - n * 60_000);
const row = (id: string, path: string | null, at: Date, action = 'file.put'): Row => ({ id, spaceId: 's', at, action, path });

describe('memoryEventsQuery (Bugbot, #769)', () => {
  it('fills its window with memory events only: tool writes never crowd out the writers', () => {
    // A tool rewrites its data.json every few minutes; the memory file was written once, long before.
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => row(`tool${i}`, '.termag/tools/tracker/data.json', t(i))),
      ...Array.from({ length: 50 }, (_, i) => row(`skill${i}`, '.termag/skills/demo-kit/SKILL.md', t(i))),
      row('mem', '.termag/memory/a.md', t(100)),
      row('moved', 'drafts/b.md -> .termag/memory/b.md', t(101), 'file.mv'),
    ];
    const q = memoryEventsQuery('s', t(1000), 10);
    const got = rows.filter(r => matches(r, q.where)).sort((a, b) => +b.at - +a.at).slice(0, q.take).filter(r => isMemoryEvent(r));
    expect(got.map(r => r.id)).toEqual(['mem', 'moved']);
  });
});

describe('pruneEventsWhere (Bugbot, #769)', () => {
  const before = t(10);
  const deleted = (r: Row) => matches(r, pruneEventsWhere(before));

  it('never prunes memory events, moves into .termag/ included, however old', () => {
    expect(deleted(row('m', '.termag/memory/a.md', t(50)))).toBe(false);
    expect(deleted(row('mv-in', 'drafts/a.md -> .termag/memory/a.md', t(50), 'file.mv'))).toBe(false);
    expect(deleted(row('mv-out', '.termag/memory/a.md -> drafts/a.md', t(50), 'file.mv'))).toBe(false);
    expect(deleted(row('ancient', '.termag/memory/a.md', t(1_000_000)))).toBe(false);
  });

  it('prunes everything else at the normal cutoff: tools, skills, moves into either, other paths, no path', () => {
    expect(deleted(row('tool', '.termag/tools/t/data.json', t(50)))).toBe(true);
    expect(deleted(row('mv-tool', 'x.json -> .termag/tools/t/data.json', t(50), 'file.mv'))).toBe(true);
    expect(deleted(row('skill', '.termag/skills/demo-kit/SKILL.md', t(50)))).toBe(true);
    expect(deleted(row('mv-skill', 'x.md -> .termag/skills/demo-kit/SKILL.md', t(50), 'file.mv'))).toBe(true);
    expect(deleted(row('file', 'a.md', t(50)))).toBe(true);
    expect(deleted(row('none', null, t(50), 'space.rename'))).toBe(true);
    expect(deleted(row('fresh', 'a.md', t(1)))).toBe(false);
  });
});
