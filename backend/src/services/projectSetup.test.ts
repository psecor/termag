import { describe, expect, it } from 'vitest';
import {
  cloneRoute,
  decideSetup,
  effectFailure,
  parseCloneStatusFrame,
  SETUP_STATUSES,
  toSetupStatus,
  type SetupEvent,
  type SetupSnapshot,
} from './projectSetup';

const DURABLE = ['credentials-v1', 'project-clone-v1'];
const row = (status: SetupSnapshot['status'], over: Partial<SetupSnapshot> = {}): SetupSnapshot =>
  ({ status, attempt: 2, provider: 'claude', ...over });
const report = (r: Extract<SetupEvent, { kind: 'report' }>['report'], attempt = 2): SetupEvent =>
  ({ kind: 'report', attempt, report: r });

describe('cloneRoute', () => {
  it('clones durably whenever the agent can, even for a bridge provider', () => {
    expect(cloneRoute(DURABLE, 'codex')).toBe('durable');
    expect(cloneRoute(DURABLE, 'claude')).toBe('durable');
  });

  it('falls back to the pane checkout without the capability, except for a bridge provider', () => {
    expect(cloneRoute(['credentials-v1'], 'claude')).toBe('pane');
    expect(cloneRoute([], null)).toBe('pane');
    expect(cloneRoute([], 'codex')).toBe('unsupported');
  });
});

describe('toSetupStatus', () => {
  it('reads the five statuses and nothing else', () => {
    expect(toSetupStatus('cloning')).toBe('cloning');
    expect(toSetupStatus('Cloning')).toBe(null);
    expect(toSetupStatus('done')).toBe(null);
  });
});

describe('decideSetup', () => {
  it('re-dispatches a pending or cloning project to a durable agent without writing', () => {
    for (const status of ['pending', 'cloning'] as const) {
      expect(decideSetup(row(status), { kind: 'agent-connected', capabilities: DURABLE })).toEqual({
        kind: 'move', from: status, to: status, effects: ['dispatch'], write: null, mainBranch: null,
      });
    }
  });

  it('turns a pending project into a plain one by the pane checkout on an older agent', () => {
    expect(decideSetup(row('pending'), { kind: 'agent-connected', capabilities: [] })).toEqual({
      kind: 'move', from: 'pending', to: 'none', effects: ['pane-checkout'],
      write: { setupStatus: 'none' }, mainBranch: null,
    });
  });

  it('fails a codex project on an agent that cannot clone durably, naming the provider', () => {
    for (const status of ['pending', 'cloning'] as const) {
      expect(decideSetup(row(status, { provider: 'codex' }), { kind: 'agent-connected', capabilities: [] })).toEqual({
        kind: 'move', from: status, to: 'failed', effects: [],
        write: {
          setupStatus: 'failed',
          setupError: "This box's agent can't clone a repository for Codex. Update the box or start empty.",
        },
        mainBranch: null,
      });
    }
  });

  it('fails a cloning project whose agent rolled back to the pane checkout, instead of typing a second clone', () => {
    expect(decideSetup(row('cloning'), { kind: 'agent-connected', capabilities: [] })).toEqual({
      kind: 'move', from: 'cloning', to: 'failed', effects: [],
      write: {
        setupStatus: 'failed',
        setupError: "This box's agent no longer runs durable clones. Retry to clone in the terminal.",
      },
      mainBranch: null,
    });
  });

  it('follows the box between pending and cloning', () => {
    expect(decideSetup(row('pending'), report({ status: 'cloning' }))).toEqual({
      kind: 'move', from: 'pending', to: 'cloning', effects: [], write: { setupStatus: 'cloning' }, mainBranch: null,
    });
    expect(decideSetup(row('cloning'), report({ status: 'pending' }))).toEqual({
      kind: 'move', from: 'cloning', to: 'pending', effects: [], write: { setupStatus: 'pending' }, mainBranch: null,
    });
  });

  it('launches on ready and records the branch the box checked out', () => {
    for (const status of ['pending', 'cloning'] as const) {
      expect(decideSetup(row(status), report({ status: 'ready', branch: 'develop' }))).toEqual({
        kind: 'move', from: status, to: 'ready', effects: ['launch'],
        write: { setupStatus: 'ready', setupError: null, repoDefaultBranch: 'develop' },
        mainBranch: 'develop',
      });
    }
  });

  it('launches on a ready without a branch and leaves the branches alone', () => {
    expect(decideSetup(row('cloning'), report({ status: 'ready', branch: null }))).toEqual({
      kind: 'move', from: 'cloning', to: 'ready', effects: ['launch'],
      write: { setupStatus: 'ready', setupError: null }, mainBranch: null,
    });
  });

  it('records the box error on failed', () => {
    for (const status of ['pending', 'cloning'] as const) {
      expect(decideSetup(row(status), report({ status: 'failed', error: 'fatal: repository not found' }))).toEqual({
        kind: 'move', from: status, to: 'failed', effects: [],
        write: { setupStatus: 'failed', setupError: 'fatal: repository not found' }, mainBranch: null,
      });
    }
  });

  it('retries a failed clone from pending under the next attempt', () => {
    expect(decideSetup(row('failed'), { kind: 'retry' })).toEqual({
      kind: 'move', from: 'failed', to: 'pending', effects: [],
      write: { setupStatus: 'pending', setupError: null, bumpAttempt: true }, mainBranch: null,
    });
  });

  it('starts a failed clone empty: makes the dir, launches, and forgets the repository', () => {
    expect(decideSetup(row('failed'), { kind: 'start-empty' })).toEqual({
      kind: 'move', from: 'failed', to: 'none', effects: ['empty-dir', 'launch'],
      write: { setupStatus: 'none', repoUrl: null, repoDefaultBranch: null, setupError: null },
      mainBranch: 'main',
    });
  });

  it('ignores a report from another attempt before anything else', () => {
    expect(decideSetup(row('cloning', { attempt: 2 }), report({ status: 'ready', branch: 'main' }, 1)))
      .toEqual({ kind: 'ignore', why: 'stale attempt' });
    expect(decideSetup(row('cloning', { attempt: 2 }), report({ status: 'failed', error: 'x' }, 3)))
      .toEqual({ kind: 'ignore', why: 'stale attempt' });
  });

  it('ignores a replayed ready, so nothing launches twice', () => {
    expect(decideSetup(row('ready'), report({ status: 'ready', branch: 'develop' })))
      .toEqual({ kind: 'ignore', why: 'report-ready while ready' });
  });

  it('refuses retry and start-empty from anything but failed', () => {
    for (const status of ['none', 'pending', 'cloning', 'ready'] as const) {
      expect(decideSetup(row(status), { kind: 'retry' }))
        .toEqual({ kind: 'refuse', error: 'Only a failed clone can be retried.' });
      expect(decideSetup(row(status), { kind: 'start-empty' }))
        .toEqual({ kind: 'refuse', error: 'Only a failed clone can start empty.' });
    }
  });

  it('moves on exactly the fourteen legal pairs and on nothing else', () => {
    const events: Array<[string, SetupEvent, SetupSnapshot['provider']]> = [
      ['connected-durable', { kind: 'agent-connected', capabilities: DURABLE }, 'claude'],
      ['connected-pane', { kind: 'agent-connected', capabilities: [] }, 'claude'],
      ['connected-unsupported', { kind: 'agent-connected', capabilities: [] }, 'codex'],
      ['report-pending', report({ status: 'pending' }), 'claude'],
      ['report-cloning', report({ status: 'cloning' }), 'claude'],
      ['report-ready', report({ status: 'ready', branch: 'main' }), 'claude'],
      ['report-failed', report({ status: 'failed', error: 'x' }), 'claude'],
      ['retry', { kind: 'retry' }, 'claude'],
      ['start-empty', { kind: 'start-empty' }, 'claude'],
    ];
    const moves: string[] = [];
    for (const status of SETUP_STATUSES) {
      for (const [name, event, provider] of events) {
        const d = decideSetup(row(status, { provider }), event);
        if (d.kind === 'move') moves.push(`${status} ${name} -> ${d.to}`);
      }
    }
    expect(moves).toEqual([
      'pending connected-durable -> pending',
      'pending connected-pane -> none',
      'pending connected-unsupported -> failed',
      'pending report-cloning -> cloning',
      'pending report-ready -> ready',
      'pending report-failed -> failed',
      'cloning connected-durable -> cloning',
      'cloning connected-pane -> failed',
      'cloning connected-unsupported -> failed',
      'cloning report-pending -> pending',
      'cloning report-ready -> ready',
      'cloning report-failed -> failed',
      'failed retry -> pending',
      'failed start-empty -> none',
    ]);
  });
});

describe('effectFailure', () => {
  it('fails the setup from where it was, with the reason and nothing else to run', () => {
    expect(effectFailure('pending', 'The checkout was not typed.')).toEqual({
      kind: 'move', from: 'pending', to: 'failed', effects: [],
      write: { setupStatus: 'failed', setupError: 'The checkout was not typed.' }, mainBranch: null,
    });
  });
});

describe('parseCloneStatusFrame', () => {
  const frame = { type: 'project-clone-status', projectId: 'p1', instanceId: 'box1', attempt: 0 };

  it('reads each status the box reports', () => {
    expect(parseCloneStatusFrame({ ...frame, status: 'cloning' }))
      .toEqual({ projectId: 'p1', instanceId: 'box1', attempt: 0, report: { status: 'cloning' } });
    expect(parseCloneStatusFrame({ ...frame, status: 'ready', branch: 'release/2026.10' }))
      .toEqual({ projectId: 'p1', instanceId: 'box1', attempt: 0, report: { status: 'ready', branch: 'release/2026.10' } });
    expect(parseCloneStatusFrame({ ...frame, attempt: 3, status: 'failed', error: 'no space left' }))
      .toEqual({ projectId: 'p1', instanceId: 'box1', attempt: 3, report: { status: 'failed', error: 'no space left' } });
  });

  it('drops a frame without a readable project, box, attempt or status', () => {
    expect(parseCloneStatusFrame({ ...frame, status: 'cloning', attempt: undefined })).toBe(null);
    expect(parseCloneStatusFrame({ ...frame, status: 'cloning', attempt: -1 })).toBe(null);
    expect(parseCloneStatusFrame({ ...frame, status: 'cloning', attempt: 1.5 })).toBe(null);
    expect(parseCloneStatusFrame({ ...frame, status: 'done' })).toBe(null);
    expect(parseCloneStatusFrame({ ...frame, status: 'cloning', projectId: 7 })).toBe(null);
    expect(parseCloneStatusFrame({ ...frame, status: 'cloning', instanceId: '' })).toBe(null);
    expect(parseCloneStatusFrame(null)).toBe(null);
    expect(parseCloneStatusFrame([frame])).toBe(null);
  });

  it('keeps only a branch name git would accept', () => {
    expect(parseCloneStatusFrame({ ...frame, status: 'ready', branch: '-x' })?.report)
      .toEqual({ status: 'ready', branch: null });
    expect(parseCloneStatusFrame({ ...frame, status: 'ready', branch: 'a;rm -rf' })?.report)
      .toEqual({ status: 'ready', branch: null });
    expect(parseCloneStatusFrame({ ...frame, status: 'ready' })?.report)
      .toEqual({ status: 'ready', branch: null });
  });

  it('cleans a failure message: control characters out, trimmed, 256 characters at most', () => {
    expect(parseCloneStatusFrame({ ...frame, status: 'failed', error: '  fatal:\u001b[31m denied\r\n' })?.report)
      .toEqual({ status: 'failed', error: 'fatal: [31m denied' });
    const long = parseCloneStatusFrame({ ...frame, status: 'failed', error: 'e'.repeat(1000) })?.report;
    expect(long).toEqual({ status: 'failed', error: 'e'.repeat(256) });
    expect(parseCloneStatusFrame({ ...frame, status: 'failed', error: ' \n ' })?.report)
      .toEqual({ status: 'failed', error: 'clone failed' });
    expect(parseCloneStatusFrame({ ...frame, status: 'failed' })?.report)
      .toEqual({ status: 'failed', error: 'clone failed' });
  });
});
