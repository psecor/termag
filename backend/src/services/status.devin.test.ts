import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { deleteStatus, setStatus } from './status';

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

const AGENT = 'psecor-proj-agent';
const REVIEW = 'psecor-proj-review';

function banked() {
  return vi.mocked(prisma.workTimeEntry.upsert).mock.calls.map(c => (c[0] as {
    create: { username: string; project: string; provider: string; totalMs: number };
  }).create);
}

// docs/devin-activity.md: Devin on a box posts with source devin-hooks, and a
// Review pane banks under its project.
describe('working time for Devin and Review panes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    vi.resetAllMocks();
    vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
  });
  afterEach(() => {
    deleteStatus(AGENT, 'i1');
    deleteStatus(REVIEW, 'i1');
    vi.useRealTimers();
  });

  it('books a devin-hooks span as devin', () => {
    setStatus(AGENT, 'working', { source: 'devin-hooks' }, undefined, 'i1');
    vi.advanceTimersByTime(90_000);
    setStatus(AGENT, 'idle', { source: 'devin-hooks' }, undefined, 'i1');
    expect(banked()).toEqual([expect.objectContaining({ username: 'psecor', project: 'proj', provider: 'devin', totalMs: 90_000 })]);
  });

  it('banks a Review pane under its project, with the reviewer as provider', () => {
    setStatus(REVIEW, 'working', { source: 'devin-hooks' }, undefined, 'i1');
    vi.advanceTimersByTime(60_000);
    setStatus(REVIEW, 'idle', { source: 'devin-hooks' }, undefined, 'i1');
    expect(banked()).toEqual([expect.objectContaining({ username: 'psecor', project: 'proj', provider: 'devin', totalMs: 60_000 })]);
  });

  it('banks a workstream Review pane under its workstream project', () => {
    const WS = 'psecor-proj-ws1-review';
    setStatus(WS, 'working', { source: 'devin-hooks' }, undefined, 'i1');
    vi.advanceTimersByTime(45_000);
    setStatus(WS, 'idle', { source: 'devin-hooks' }, undefined, 'i1');
    deleteStatus(WS, 'i1');
    expect(banked()).toEqual([expect.objectContaining({ username: 'psecor', project: 'proj-ws1', provider: 'devin', totalMs: 45_000 })]);
  });

  it('banks a parallel review slot (-review-<n>, docs/parallel-reviews.md)', () => {
    const SLOT = 'psecor-proj-review-2';
    setStatus(SLOT, 'working', { source: 'devin-hooks' }, undefined, 'i1');
    vi.advanceTimersByTime(20_000);
    setStatus(SLOT, 'idle', { source: 'devin-hooks' }, undefined, 'i1');
    deleteStatus(SLOT, 'i1');
    expect(banked()).toEqual([expect.objectContaining({ username: 'psecor', project: 'proj', provider: 'devin', totalMs: 20_000 })]);
  });

  it('still books a source-less span as claude (the Claude hooks)', () => {
    setStatus(REVIEW, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(30_000);
    setStatus(REVIEW, 'idle', {}, undefined, 'i1');
    expect(banked()).toEqual([expect.objectContaining({ project: 'proj', provider: 'claude', totalMs: 30_000 })]);
  });
});
