import { describe, it, expect } from 'vitest';
import { PARKED_STATUSES } from './boxPowerPolicy';
import { boxState, isAddressableName, shapeBox, shapeClone, shapeDevices, shapeProject, type BoxRow, type ProjectRow } from './cliViews';

const T = new Date('2026-10-01T12:00:00Z');

const box: BoxRow = {
  id: 'i1', name: 'devbox', kind: 'ec2', status: 'ready', provisioningError: null,
  ec2InstanceId: 'i-0abc', region: 'us-east-2', hostUnixUser: 'zane',
  createdAt: T, readyAt: T, projects: [{ id: 'p1', name: 'fix' }],
};

describe('boxState', () => {
  it('maps a ready box to running and passes known states through', () => {
    expect(boxState('ready')).toBe('running');
    for (const s of ['provisioning', 'stopping', 'stopped', 'hibernating', 'hibernated', 'starting', 'failed', 'awaiting-agent']) {
      expect(boxState(s)).toBe(s);
    }
    expect(boxState('warm')).toBe('unknown');
  });

  it('knows every parked status a power action leaves a box in', () => {
    for (const s of PARKED_STATUSES) expect(boxState(s)).not.toBe('unknown');
  });
});

describe('isAddressableName', () => {
  it('allows letters, digits, - and _ only', () => {
    expect(isAddressableName('dev_box-2')).toBe(true);
    expect(isAddressableName('dev box')).toBe(false);
    expect(isAddressableName('a/b')).toBe(false);
    expect(isAddressableName('')).toBe(false);
  });
});

describe('shapeBox', () => {
  it('shapes a running box', () => {
    expect(shapeBox(box, true)).toEqual({
      id: 'i1', name: 'devbox', addressable: true, kind: 'ec2', state: 'running', status: 'ready',
      agentConnected: true, error: null, ec2InstanceId: 'i-0abc', region: 'us-east-2', hostUnixUser: 'zane',
      createdAt: T.toISOString(), readyAt: T.toISOString(), projects: [{ id: 'p1', name: 'fix' }],
    });
  });

  it('surfaces the provisioning error only for a failed box', () => {
    expect(shapeBox({ ...box, status: 'failed', provisioningError: 'no AMI' }, false).error).toBe('no AMI');
    expect(shapeBox({ ...box, provisioningError: 'stale' }, false).error).toBeNull();
  });
});

describe('shapeProject', () => {
  const row: ProjectRow = {
    id: 'p1', name: 'fix', instanceId: 'i1', lastActiveAt: T,
    instance: { id: 'i1', name: 'devbox' }, user: { unixUsername: 'zane' },
    workstreams: [], workflows: [{ provider: 'claude' }],
  };

  it('addresses a project as <box>/<project>', () => {
    expect(shapeProject(row, { status: 'working', waitingReason: null })).toMatchObject({
      ref: 'devbox/fix', box: { id: 'i1', name: 'devbox' }, provider: 'claude', status: 'working', workstreams: ['main'],
    });
  });

  it('reports not_running without a status', () => {
    expect(shapeProject(row, undefined)?.status).toBe('not_running');
  });

  it('omits projects with no box', () => {
    expect(shapeProject({ ...row, instanceId: null, instance: null }, undefined)).toBeNull();
  });

  it('gives the directory under the home the box reported', () => {
    const onBox = { ...row, instance: { id: 'i1', name: 'devbox', hostHome: '/home/zane.k/' } };
    expect(shapeProject(onBox, undefined)?.directory).toBe('/home/zane.k/termag/projects/fix');
  });

  it('falls back to /home/<owner> for a box that never reported a home', () => {
    expect(shapeProject(row, undefined)?.directory).toBe('/home/zane/termag/projects/fix');
    expect(shapeProject({ ...row, instance: { id: 'i1', name: 'devbox', hostHome: null } }, undefined)?.directory)
      .toBe('/home/zane/termag/projects/fix');
  });

  it('passes the tmux sessions through, null when not supplied', () => {
    const sessions = { agent: 'zane-fix-agent', ctrl: 'zane-fix-ctrl' };
    expect(shapeProject(row, undefined, sessions)?.sessions).toEqual(sessions);
    expect(shapeProject(row, undefined)?.sessions).toBeNull();
  });

  it('carries the clone, none for an empty project already set up', () => {
    expect(shapeProject(row, undefined)?.clone).toBeNull();
    expect(shapeProject({ ...row, repoUrl: 'https://github.com/a/b', setupStatus: 'cloning' }, undefined)?.clone)
      .toEqual({ state: 'cloning', setupStatus: 'cloning', error: null, repoUrl: 'https://github.com/a/b', retryable: false });
  });
});

describe('shapeClone', () => {
  const repoUrl = 'https://github.com/example-org/webapp';
  const box = { id: 'i1', name: 'devbox', kind: 'ec2', status: 'ready', provisioningError: null };

  it('reads setupStatus as the web UI\'s clone tile does', () => {
    expect(shapeClone({ repoUrl, setupStatus: 'pending', instance: box })?.state).toBe('waiting');
    expect(shapeClone({ repoUrl, setupStatus: 'cloning', instance: box })?.state).toBe('cloning');
    expect(shapeClone({ repoUrl, setupStatus: 'ready', instance: box })).toEqual({
      state: 'done', setupStatus: 'ready', error: null, repoUrl, retryable: false,
    });
  });

  it('gives a failed clone its error and says it can be retried', () => {
    expect(shapeClone({ repoUrl, setupStatus: 'failed', setupError: ' fatal: repository not found ', instance: box })).toEqual({
      state: 'failed', setupStatus: 'failed', error: 'fatal: repository not found', repoUrl, retryable: true,
    });
    expect(shapeClone({ repoUrl, setupStatus: 'failed', setupError: null, instance: box })?.error).toBe('clone failed');
    expect(shapeClone({ repoUrl: null, setupStatus: 'failed', instance: box })?.error).toBe('setup failed');
  });

  it('fails a clone waiting on a box that failed to launch, which Retry relaunches', () => {
    expect(shapeClone({ repoUrl, setupStatus: 'pending', instance: { ...box, status: 'failed', provisioningError: 'no AMI' } })).toEqual({
      state: 'failed', setupStatus: 'pending', error: 'The box failed to launch: no AMI. Retry launches a new one.', repoUrl, retryable: true,
    });
    expect(shapeClone({ repoUrl, setupStatus: 'pending', instance: { ...box, kind: 'external', status: 'failed' } })?.state).toBe('waiting');
  });

  it('cannot tell how a checkout typed into the agent pane went', () => {
    expect(shapeClone({ repoUrl, setupStatus: 'none', instance: box })?.state).toBe('unknown');
    expect(shapeClone({ repoUrl, setupStatus: 'something-newer', instance: box })).toMatchObject({ state: 'unknown', setupStatus: 'something-newer' });
  });

  it('has nothing to wait for on an empty project already set up, but waits with one whose box is booting', () => {
    expect(shapeClone({ repoUrl: null, setupStatus: 'none', instance: box })).toBeNull();
    expect(shapeClone({ instance: box })).toBeNull();
    expect(shapeClone({ repoUrl: null, setupStatus: 'pending', instance: box })).toMatchObject({ state: 'waiting', repoUrl: null });
  });
});

describe('shapeDevices', () => {
  it('lists live devices with their expiry and drops lapsed ones', () => {
    const day = 24 * 60 * 60 * 1000;
    const devices = shapeDevices([
      { id: 'a', deviceName: 'mbp', tokenPrefix: 'tmcli_1…', createdAt: T, lastUsedAt: T, revokedAt: null },
      { id: 'b', deviceName: 'old', tokenPrefix: 'tmcli_2…', createdAt: new Date(T.getTime() - 10 * day), lastUsedAt: new Date(T.getTime() - 8 * day), revokedAt: null },
    ], T);
    expect(devices).toEqual([{
      id: 'a', deviceName: 'mbp', tokenPrefix: 'tmcli_1…', createdAt: T.toISOString(), lastUsedAt: T.toISOString(),
      expiresAt: new Date(T.getTime() + 7 * day).toISOString(),
    }]);
  });
});
