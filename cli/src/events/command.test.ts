import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { run } from '../main.js';
import { installFakeStatus, type FakeStatus } from '../test/fakeStatus.js';
import { startFakeOrchestrator, type FakeOrchestrator } from '../test/fakeOrchestrator.js';

let home: string;
let orch: FakeOrchestrator;
let status: FakeStatus;
let out: string[];
let err: string[];
let interrupt: (() => void) | undefined;

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'laptop.local',
    interactive: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    pollIntervalMs: 10,
    untilInterrupted: () => new Promise<void>((resolve) => { interrupt = resolve; }),
    ...overrides,
  };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting; stdout: ${out.join('\n')} stderr: ${err.join('\n')}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const events = () => out.map(l => JSON.parse(l) as Record<string, unknown>);
const withoutAt = (e: Record<string, unknown>) => { const { at: _at, ...rest } = e; return rest; };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-events-'));
  orch = await startFakeOrchestrator();
  status = installFakeStatus(orch);
  interrupt = undefined;
  out = [];
  err = [];
  expect(await run(['login'], ctx())).toBe(0);
  out = [];
  err = [];
});

afterEach(async () => {
  interrupt?.();
  for (const ws of status.conns) ws.terminate();
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('termag events --json', () => {
  it('prints the boxes and sessions as they are, then one line per change, until interrupted', async () => {
    status.replay = [{ type: 'status', session: 'alice-webapp-fix-agent', instanceId: 'i1', status: 'waiting', waitingReason: 'approval', updatedAt: '2026-10-28T14:00:00.000Z' }];
    orch.lifecycle.parkPolls = 2;
    const done = run(['events', '--json'], ctx());

    await until(() => out.length === 3);
    for (const e of events()) expect(Date.parse(e.at as string)).not.toBeNaN();
    expect(events().map(withoutAt)).toEqual([
      { type: 'box', box: { id: 'i1', name: 'devbox' }, state: 'running', previous: null, agentConnected: true },
      { type: 'box', box: { id: 'i2', name: 'old box' }, state: 'stopped', previous: null, agentConnected: false },
      // As from an orchestrator that does not send stoppedAt: the field is left out, and nothing fails.
      { type: 'session', session: 'alice-webapp-fix-agent', box: { id: 'i1', name: 'devbox' }, status: 'waiting', previous: null, waitingReason: 'approval' },
    ]);

    status.push({ type: 'heartbeat', ts: 1 });
    status.push({ type: 'status', session: 'alice-webapp-fix-agent', instanceId: 'i1', status: 'waiting', waitingReason: 'approval', contextTokens: 90000 });
    status.push({ type: 'status', session: 'alice-webapp-fix-agent', instanceId: 'i1', status: 'idle', stoppedAt: '2026-10-28T14:01:00.000Z' });
    await until(() => out.length === 4);
    expect(withoutAt(events()[3])).toEqual({
      type: 'session', session: 'alice-webapp-fix-agent', box: { id: 'i1', name: 'devbox' }, status: 'idle', previous: 'waiting', stoppedAt: '2026-10-28T14:01:00.000Z',
    });

    const side: string[] = [];
    expect(await run(['box', 'stop', 'devbox'], ctx({ out: t => side.push(t), err: t => side.push(t) }))).toBe(0);
    status.push({ type: 'workspace', what: 'boxes' });
    await until(() => out.length === 6);
    expect(events().slice(4).map(e => [e.type, (e.box as { name: string }).name, e.previous, e.state])).toEqual([
      ['box', 'devbox', 'running', 'stopping'],
      ['box', 'devbox', 'stopping', 'stopped'],
    ]);

    interrupt!();
    expect(await done).toBe(0);
    expect(err).toEqual([]);
  });

  it('reads the box list again after the socket comes back', async () => {
    const done = run(['events', '--json'], ctx({ pollIntervalMs: 60_000 }));
    await until(() => out.length === 2 && status.conns.length === 1);
    Object.assign(orch.lifecycle.boxes[1], { state: 'running', status: 'ready', agentConnected: true });
    status.conns[0].terminate();
    await until(() => out.length === 3);
    expect(withoutAt(events()[2])).toMatchObject({ box: { name: 'old box' }, previous: 'stopped', state: 'running', agentConnected: true });
    expect(err.join('\n')).toMatch(/lost the status socket.*\n.*connected again/);
    interrupt!();
    expect(await done).toBe(0);
  });

  it('ends with exit 4 when the sign-in is revoked while it runs', async () => {
    const done = run(['events', '--json'], ctx());
    await until(() => status.conns.length === 1);
    status.conns[0].close(1008, 'This device was signed out; run `termag login`');
    expect(await done).toBe(4);
    expect(err.join('\n')).toContain('This device was signed out');
  });
});

describe('termag events', () => {
  it('needs a sign-in, and says so before printing anything', async () => {
    rmSync(join(home, '.config'), { recursive: true, force: true });
    expect(await run(['events'], ctx())).toBe(4);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('termag login');
  });

  it('prints a line a person can read without --json', async () => {
    const done = run(['events'], ctx());
    await until(() => out.length === 2);
    expect(out[0]).toMatch(/^\S+ box devbox: running$/);
    expect(out[1]).toMatch(/^\S+ box old box: stopped$/);
    interrupt!();
    expect(await done).toBe(0);
  });
});
