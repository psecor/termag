import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: Array<{ where: any; data: any }> = [];
vi.mock('../db', () => ({
  prisma: { instance: { updateMany: async (args: any) => { writes.push(args); return { count: 1 }; } } },
}));

const { ACTIVITY_WRITE_INTERVAL_MS, boxInUseFields, isTerminalReport, noteBoxActivity, resetBoxActivityThrottle } =
  await import('./boxActivity');

beforeEach(() => { writes.length = 0; resetBoxActivityThrottle(); });

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

  it('ignores a missing box', () => {
    noteBoxActivity(null);
    noteBoxActivity(undefined);
    expect(writes).toEqual([]);
  });

  it('boxInUseFields restarts the clock, clears the parked state and holds back the next activity write', () => {
    expect(boxInUseFields('b1', 5_000)).toEqual({ lastActivityAt: new Date(5_000), parkedAt: null, lifecycleNote: null });
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
