// The project list fixes each chat's space at its first listing (plan-outbox
// #38; services/chatSpace.ts): its box's first granted space, kept through a
// reload and a later grant to the box.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const ws = [
    { id: 'ws1', name: 'main', spaceId: null as string | null, spaceFixedAt: null as Date | null },
    { id: 'ws2', name: 'side', spaceId: 's-beta' as string | null, spaceFixedAt: new Date(1) as Date | null },
  ];
  const grants = [{ instanceId: 'box1', spaceId: 's-alpha', createdAt: 1 }];
  return {
    ws, grants,
    prisma: {
      project: { findMany: vi.fn(async () => [{ id: 'p1', name: 'proj', instanceId: 'box1', user: { unixUsername: 'u' }, workflows: [], workstreams: ws.map(w => ({ ...w, _count: { chatTranscripts: 0 } })) }]) },
      projectShare: { findMany: vi.fn(async () => []) },
      // The used-main read (services/workstreamUse.ts): no working time banked.
      workTimeEntry: { groupBy: vi.fn(async () => []) },
      spaceBox: {
        findMany: vi.fn(async () => [...grants].sort((a, b) => a.createdAt - b.createdAt).map(g => ({ instanceId: g.instanceId, spaceId: g.spaceId }))),
      },
      workstream: {
        updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { spaceId: string | null; spaceFixedAt: Date } }) => {
          let count = 0;
          for (const w of ws) if (where.id.in.includes(w.id) && !w.spaceFixedAt) { Object.assign(w, data); count++; }
          return { count };
        }),
      },
    },
  };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

import { listProjectsFor } from './projects';

beforeEach(() => vi.clearAllMocks());

describe('listProjectsFor: each chat\'s space', () => {
  it('fixes an unfixed chat to its box\'s first grant, keeps a fixed one, and both survive a reload and a new grant', async () => {
    const first = await listProjectsFor('u1');
    expect(first[0].workstreams.map(w => [w.id, w.spaceId])).toEqual([['ws1', 's-alpha'], ['ws2', 's-beta']]);
    expect(db.prisma.workstream.updateMany).toHaveBeenCalledTimes(1);
    db.prisma.workstream.updateMany.mockClear();
    // The box is granted another space, dated first even: nothing moves.
    db.grants.unshift({ instanceId: 'box1', spaceId: 's-gamma', createdAt: 0 });
    const again = await listProjectsFor('u1');
    expect(again[0].workstreams.map(w => [w.id, w.spaceId])).toEqual([['ws1', 's-alpha'], ['ws2', 's-beta']]);
    expect(db.prisma.workstream.updateMany).not.toHaveBeenCalled();
  });

  it('never lists a space orchestrator\'s project, owned or shared (projectKind.ts inProjectLists)', async () => {
    await listProjectsFor('u1');
    const owned = (db.prisma.project.findMany.mock.calls[0] as unknown as [{ where: { kind: { in: string[] } } }])[0].where.kind.in;
    const shared = (db.prisma.projectShare.findMany.mock.calls[0] as unknown as [{ where: { project: { kind: { in: string[] } } } }])[0].where.project.kind.in;
    for (const kinds of [owned, shared]) {
      expect(kinds).toEqual(['normal', 'metaterm', 'automation']);
      expect(kinds).not.toContain('space-orchestrator');
    }
  });
});

