import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: Array<{ where: any; data: any }> = [];
// Running automation runs, as automationHoldsSession reads them.
const runs: Array<{ instanceId: string; wakeBox: boolean; workstream: string; project: string; owner: string }> = [];
const runQueries: any[] = [];
vi.mock('../db', () => ({
  prisma: {
    instance: { updateMany: async (args: any) => { writes.push(args); return { count: 1 }; } },
    automationRun: {
      findMany: async ({ where }: any) => {
        runQueries.push(where);
        if (where.instanceId === 'broken') throw new Error('db down');
        return runs
          .filter(r => r.instanceId === where.instanceId && r.wakeBox === where.automation.wakeBox)
          .map(r => ({ workstream: { name: r.workstream }, automation: { project: { name: r.project, user: { unixUsername: r.owner } } } }));
      },
    },
  },
}));

const { ACTIVITY_WRITE_INTERVAL_MS, automationHoldsSession, boxInUseFields, isTerminalReport, noteAgentWorking, noteAutomationRunActivity, noteBoxActivity, resetBoxActivityThrottle } =
  await import('./boxActivity');

const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { writes.length = 0; runs.length = 0; runQueries.length = 0; resetBoxActivityThrottle(); });

describe('noteAutomationRunActivity', () => {
  it('restarts a ready box\'s clock at once, awaited and unthrottled', async () => {
    const at = new Date('2026-10-30T00:07:29Z');
    noteBoxActivity('b1', at.getTime() - 1000);
    await settle();
    await noteAutomationRunActivity('b1', at);
    expect(writes.at(-1)).toEqual({ where: { id: 'b1', status: 'ready' }, data: { lastActivityAt: at } });
    await noteAutomationRunActivity(null, at);
    expect(writes).toHaveLength(2);
  });
});

describe('noteBoxActivity', () => {
  it('writes at most once a minute per box', async () => {
    noteBoxActivity('b1', 1_000);
    noteBoxActivity('b1', 1_000 + ACTIVITY_WRITE_INTERVAL_MS - 1);
    noteBoxActivity('b2', 2_000);
    noteBoxActivity('b1', 1_000 + ACTIVITY_WRITE_INTERVAL_MS);
    await new Promise(r => setTimeout(r, 0));
    expect(writes.map(w => [w.where.id, w.data.lastActivityAt.getTime()])).toEqual([
      ['b1', 1_000], ['b2', 2_000], ['b1', 1_000 + ACTIVITY_WRITE_INTERVAL_MS],
    ]);
  });

  it("only moves a ready box's clock, so a parked box still reads as untouched", async () => {
    noteBoxActivity('b1', 1_000);
    await settle();
    expect(writes[0].where).toEqual({ id: 'b1', status: 'ready' });
  });

  it('ignores a missing box', () => {
    noteBoxActivity(null);
    noteBoxActivity(undefined);
    expect(writes).toEqual([]);
  });

  it('boxInUseFields restarts the clock, clears the parked state and holds back the next activity write', () => {
    expect(boxInUseFields('b1', 5_000)).toEqual({ lastActivityAt: new Date(5_000), parkedAt: null, autoParkedAt: null, lifecycleNote: null });
    noteBoxActivity('b1', 5_000 + 1);
    expect(writes).toEqual([]);
  });
});

describe('isTerminalReport', () => {
  it("recognises xterm's own replies", () => {
    for (const data of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b[I', '\x1b[O',
      '\x1b]11;rgb:0000/0000/0000\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b[I\x1b[O']) {
      expect(isTerminalReport(data), JSON.stringify(data)).toBe(true);
    }
  });

  it('counts keystrokes, arrows, mouse scrolls and pastes as a person', () => {
    for (const data of ['a', '\r', '\x03', '\x1b[A', '\x1b[2~', '\x1b[<64;10;5M', 'hello\x1b[I', '\x1b']) {
      expect(isTerminalReport(data), JSON.stringify(data)).toBe(false);
    }
  });
});

describe('noteAgentWorking', () => {
  it("counts an agent's work as activity", async () => {
    noteAgentWorking('b1', 'vic-api-agent', 1_000);
    await settle(); await settle();
    expect(writes.map(w => w.where.id)).toEqual(['b1']);
  });

  it("doesn't count the turns of an automation run that can wake the box, and looks it up at most once a minute", async () => {
    runs.push({ instanceId: 'b1', wakeBox: true, workstream: 'run-2026-10-23-0900', project: 'api', owner: 'vic' });
    noteAgentWorking('b1', 'vic-api-run-2026-10-23-0900-agent', 1_000);
    noteAgentWorking('b1', 'vic-api-run-2026-10-23-0900-agent', 2_000);
    await settle(); await settle();
    expect(writes).toEqual([]);
    expect(runQueries).toEqual([{ instanceId: 'b1', state: 'running', workstreamId: { not: null }, automation: { wakeBox: true } }]);
  });

  it("never keeps a keystroke from moving the clock while an automation's turns are held", async () => {
    runs.push({ instanceId: 'b1', wakeBox: true, workstream: 'run-1', project: 'api', owner: 'vic' });
    noteAgentWorking('b1', 'vic-api-run-1-agent', 1_000);
    await settle(); await settle();
    noteBoxActivity('b1', 1_500);
    noteAgentWorking('b1', 'vic-api-run-1-agent', 30_000);
    await settle(); await settle();
    expect(writes.map(w => [w.where.id, w.data.lastActivityAt.getTime()])).toEqual([['b1', 1_500]]);
    expect(runQueries).toHaveLength(1);
  });

  it("still counts another session's work, and an automation that can't wake the box", async () => {
    runs.push({ instanceId: 'b1', wakeBox: true, workstream: 'run-1', project: 'api', owner: 'vic' });
    runs.push({ instanceId: 'b2', wakeBox: false, workstream: 'run-1', project: 'api', owner: 'vic' });
    noteAgentWorking('b1', 'vic-api-agent', 1_000);
    noteAgentWorking('b2', 'vic-api-run-1-agent', 1_000);
    await settle(); await settle();
    expect(writes.map(w => w.where.id).sort()).toEqual(['b1', 'b2']);
  });

  it('counts the work when the lookup fails, and ignores a missing box', async () => {
    await expect(automationHoldsSession('broken', 'vic-api-agent')).rejects.toThrow('db down');
    noteAgentWorking(null, 'x');
    noteAgentWorking('broken', 'vic-api-agent', 1_000);
    await settle(); await settle();
    expect(writes.map(w => w.where.id)).toEqual(['broken']);
  });
});
