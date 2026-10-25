import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { prisma } from '../db';
import { deleteStatus, markAgentPaneStopped, setStatus, updateStatusMeta } from './status';
import { AUTO_IDLE_MS, hydrateStatus, toRow } from './statusPersistence';
import { rememberUserKey, resetUserKeysForTests } from './userKeys';

/**
 * The product events the status pipeline records: one `agent.status.changed` per change of `status`, carrying how
 * long the previous status lasted, and one `agent.session.ended` per stop.
 * Read off a log exporter, as the backend sends them.
 */

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

const S = 'ada-research-agent';
const exporter = new InMemoryLogRecordExporter();
// The session-name events resolve the user id off the main thread; the
// records land once those promises have run.
const flush = () => new Promise(resolve => setImmediate(resolve));
const events = () => exporter.getFinishedLogRecords().map(r => r.attributes);

beforeAll(() => {
  logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] }));
});

describe('the status pipeline as product events', () => {
  beforeEach(() => {
    // Only what status.ts schedules; setImmediate stays real for flush().
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    vi.resetAllMocks();
    vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    resetUserKeysForTests();
    rememberUserKey('ada', 'u1');
    exporter.reset();
  });
  afterEach(() => {
    deleteStatus(S, 'i1');
    deleteStatus('ghost-research-agent', 'i1');
    vi.useRealTimers();
  });

  it('records a change of status with how long the previous status lasted, not a repeat or a meta write', async () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    await flush();
    expect(events()).toEqual([{
      'event.name': 'agent.status.changed', 'termag.user.id': 'u1', 'termag.box.id': 'i1',
      'termag.status': 'working', 'termag.provider': 'claude',
    }]);

    // A hook POST during the turn and a context-token sample both bump
    // updatedAt; neither is a transition, and neither restarts the clock.
    vi.advanceTimersByTime(90_000);
    setStatus(S, 'working', { message: 'Running a tool' }, undefined, 'i1');
    updateStatusMeta(S, { contextTokens: 42_000 }, 'i1');
    vi.advanceTimersByTime(30_000);
    setStatus(S, 'idle', {}, undefined, 'i1');
    await flush();

    const [, idle, ...rest] = events();
    expect(rest).toEqual([]);
    expect(idle).toEqual({
      'event.name': 'agent.status.changed', 'termag.user.id': 'u1', 'termag.box.id': 'i1',
      'termag.status': 'idle', 'termag.previousStatus': 'working', 'termag.previousStatusSeconds': 120, 'termag.provider': 'claude',
    });
  });

  it('names the waiting reason on a waiting transition only, and the provider from the source', async () => {
    setStatus(S, 'working', { source: 'codex-app-server' }, undefined, 'i1');
    vi.advanceTimersByTime(5_000);
    setStatus(S, 'waiting', { source: 'codex-app-server', waitingReason: 'approval' }, undefined, 'i1');
    vi.advanceTimersByTime(7_000);
    setStatus(S, 'working', { source: 'codex-app-server' }, undefined, 'i1');
    await flush();
    expect(events().map(a => [a['termag.status'], a['termag.waitingReason'], a['termag.previousStatusSeconds'], a['termag.provider']])).toEqual([
      ['working', undefined, undefined, 'codex'],
      ['waiting', 'approval', 5, 'codex'],
      ['working', undefined, 7, 'codex'],
    ]);
  });

  it('counts the time since the status began on the auto-idle safety net too', async () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS + 1);
    vi.advanceTimersByTime(60_000);
    setStatus(S, 'working', {}, undefined, 'i1');
    await flush();
    const last = events().at(-1)!;
    expect(last['termag.previousStatus']).toBe('idle');
    expect(last['termag.previousStatusSeconds']).toBe(60);
  });

  it('records one agent.session.ended per stop, with the status the agent was in', async () => {
    setStatus(S, 'working', { source: 'codex-app-server' }, undefined, 'i1');
    markAgentPaneStopped(S, 'i1');
    markAgentPaneStopped(S, 'i1');
    await flush();
    const ended = events().filter(a => a['event.name'] === 'agent.session.ended');
    expect(ended).toEqual([{
      'event.name': 'agent.session.ended', 'termag.user.id': 'u1', 'termag.box.id': 'i1',
      'termag.kind': 'interactive', 'termag.provider': 'codex', 'termag.lastStatus': 'working',
    }]);
    // The ended event goes first: it names the status the agent was in.
    expect(events().map(a => a['termag.status'])).toEqual(['working', undefined, 'not_running']);
  });

  it('records nothing for a session whose username no user is behind', async () => {
    setStatus('ghost-research-agent', 'working', {}, undefined, 'i1');
    await flush();
    expect(events()).toEqual([]);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { unixUsername: 'ghost' }, select: { id: true } });
  });

  it('starts a hydrated working entry at its span, and keeps the clock across the restart', async () => {
    const startedAt = new Date('2026-10-20T11:58:00Z');
    const now = Date.parse('2026-10-20T12:00:00Z');
    const row = toRow('i1', S, { status: 'working', updatedAt: new Date('2026-10-20T11:59:30Z') }, { startedAt: startedAt.getTime(), provider: 'claude' });
    const [h] = hydrateStatus([row], now);
    expect(h.status.statusSince).toEqual(startedAt);
  });
});
