import { describe, expect, it, vi } from 'vitest';

// WorkTimeEntry rows as the groupBy would find them: (username, project, instanceId) with time.
const rows = vi.hoisted(() => [] as Array<{ username: string; project: string; instanceId: string; totalMs: number }>);
const groupBy = vi.hoisted(() => vi.fn(async ({ where }: { where: { project: { in: string[] }; username: { in: string[] } } }) =>
  rows.filter(r => where.project.in.includes(r.project) && where.username.in.includes(r.username) && r.totalMs > 0)
    .map(({ username, project, instanceId }) => ({ username, project, instanceId }))));
vi.mock('../db', () => ({ prisma: { workTimeEntry: { groupBy } } }));

const { mainUseKey, usedMains } = await import('./workstreamUse');

describe('usedMains: a main with any working time banked under its own name, on its own box', () => {
  it('finds the mains with agent or human time, and only those', async () => {
    rows.splice(0, rows.length,
      { username: 'ada', project: 'termag', instanceId: 'box1', totalMs: 5000 },
      // Another workstream's time is banked as <project>-<workstream>: not main's.
      { username: 'ada', project: 'app-ask-cmvsxyz', instanceId: 'box2', totalMs: 9000 },
      // The same name on another box, and none on this one.
      { username: 'ada', project: 'app', instanceId: 'box9', totalMs: 9000 },
      { username: 'ada', project: 'app', instanceId: 'box2', totalMs: 0 },
    );
    const used = await usedMains([
      { username: 'ada', project: 'termag', instanceId: 'box1' },
      { username: 'ada', project: 'app', instanceId: 'box2' },
    ]);
    expect([...used]).toEqual([mainUseKey({ username: 'ada', project: 'termag', instanceId: 'box1' })]);
  });

  it('reads a project with no box under the orchestrator\'s "" instance', async () => {
    rows.splice(0, rows.length, { username: 'ada', project: 'local', instanceId: '', totalMs: 1 });
    expect((await usedMains([{ username: 'ada', project: 'local', instanceId: null }])).size).toBe(1);
  });

  it('finds agent time banked under the tmux-safe username (. and : folded to _), and human time under the raw one', async () => {
    rows.splice(0, rows.length,
      { username: 'jane_doe', project: 'app', instanceId: 'box1', totalMs: 5000 },
      { username: 'ops:bot', project: 'tool', instanceId: 'box2', totalMs: 10 },
    );
    const used = await usedMains([
      { username: 'jane.doe', project: 'app', instanceId: 'box1' },
      { username: 'ops:bot', project: 'tool', instanceId: 'box2' },
    ]);
    expect(used.has(mainUseKey({ username: 'jane.doe', project: 'app', instanceId: 'box1' }))).toBe(true);
    expect(used.has(mainUseKey({ username: 'ops:bot', project: 'tool', instanceId: 'box2' }))).toBe(true);
  });

  it('asks nothing for no projects', async () => {
    groupBy.mockClear();
    expect((await usedMains([])).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
