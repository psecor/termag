import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { CHAT_NOTICE_KEEP, listChatNotices, recordChatNotices } from './chatNotices';

type Row = { id: string; workstreamId: string; kind: string; pane: string; text: string; runId: string | null; at: Date };
const rows: Row[] = [];
let n = 0;
const newest = (a: Row, b: Row) => b.at.getTime() - a.at.getTime() || (b.id < a.id ? -1 : 1);

vi.mock('../db', () => ({
  prisma: {
    workstream: {
      findUnique: vi.fn(async ({ where }: any) => (where.projectId_name.projectId === 'p1' && ['main', 'fix'].includes(where.projectId_name.name) ? { id: `ws-${where.projectId_name.name}` } : null)),
    },
    chatNotice: {
      create: vi.fn(async ({ data }: any) => { const r = { id: `n${String(++n).padStart(4, '0')}`, ...data }; rows.push(r); return r; }),
      findMany: vi.fn(async ({ where, skip = 0, take }: any) => rows.filter(r => r.workstreamId === where.workstreamId).sort(newest).slice(skip, take === undefined ? undefined : skip + take)),
      deleteMany: vi.fn(async ({ where }: any) => { const drop = new Set(where.id.in); for (let i = rows.length - 1; i >= 0; i--) if (drop.has(rows[i].id)) rows.splice(i, 1); return { count: drop.size }; }),
    },
  },
}));

const line = '[termag] Claude Code was updated to 2.1.320 (automatic nightly run); resuming your session.';

beforeEach(() => { rows.length = 0; n = 0; vi.mocked(prisma.chatNotice.create).mockClear(); });

describe('recordChatNotices', () => {
  it('stores each notice on its workstream, with the run, and lists them oldest first', async () => {
    const at = new Date('2026-11-04T03:12:00Z');
    expect(await recordChatNotices([
      { projectId: 'p1', workstream: 'main', pane: 'agent', text: line },
      { projectId: 'p1', workstream: 'main', pane: 'agent', text: line }, // the same pane twice in one report: once
      { projectId: 'p1', workstream: 'fix', pane: 'ctrl', text: line },
      { projectId: 'p1', workstream: 'gone', pane: 'agent', text: line }, // no such workstream
    ], 'run-1', at)).toBe(2);
    expect(rows.map(r => [r.workstreamId, r.pane, r.runId, r.kind])).toEqual([['ws-main', 'agent', 'run-1', 'tool-update'], ['ws-fix', 'ctrl', 'run-1', 'tool-update']]);
    expect(await listChatNotices('ws-main')).toEqual([{ id: 'n0001', kind: 'tool-update', pane: 'agent', text: line, at: at.toISOString() }]);
  });

  it('stores nothing that fails NOTICE_SAFE or is not a restart notice, nor a pane it does not know', async () => {
    expect(await recordChatNotices([
      { projectId: 'p1', workstream: 'main', pane: 'agent', text: "[termag] Claude's Code was updated; $(id)" },
      { projectId: 'p1', workstream: 'main', pane: 'agent', text: '<img src=x onerror=alert(1)>' },
      { projectId: 'p1', workstream: 'main', pane: 'agent', text: 'resuming your session.' },
      { projectId: 'p1', workstream: 'main', pane: 'shell' as never, text: line },
    ], null)).toBe(0);
    expect(prisma.chatNotice.create).not.toHaveBeenCalled();
  });

  it('keeps the newest CHAT_NOTICE_KEEP per workstream', async () => {
    for (let i = 0; i < CHAT_NOTICE_KEEP + 3; i++) await recordChatNotices([{ projectId: 'p1', workstream: 'main', pane: 'agent', text: line }], `run-${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)));
    const kept = await listChatNotices('ws-main');
    expect(kept).toHaveLength(CHAT_NOTICE_KEEP);
    expect(kept[0].at).toBe(new Date(Date.UTC(2026, 10, 1, 0, 3)).toISOString());
    expect(kept.at(-1)!.at).toBe(new Date(Date.UTC(2026, 10, 1, 0, CHAT_NOTICE_KEEP + 2)).toISOString());
  });

  it('never lists a stored row that would not pass now', async () => {
    rows.push({ id: 'old', workstreamId: 'ws-main', kind: 'tool-update', pane: 'agent', text: "[termag] it's", runId: null, at: new Date() });
    expect(await listChatNotices('ws-main')).toEqual([]);
  });
});
