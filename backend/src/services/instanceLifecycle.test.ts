import { describe, it, expect } from 'vitest';
import type { Instance, User } from '@prisma/client';
import {
  isManagedBox,
  INSTANCE_STATUSES,
  connectUpdate,
  nextStatusOnConnect,
  parseAgentConnection,
  registryKeyOf,
  warmCompletionUpdate,
} from './instanceLifecycle';

const user = { id: 'user_1', unixUsername: 'peter' } as unknown as User;
const instance = { id: 'inst_1', name: 'peter-heavy', status: 'provisioning' } as unknown as Instance;

function instanceWithStatus(status: string): Instance {
  return { ...instance, status } as Instance;
}

describe('parseAgentConnection', () => {
  it('reads a legacy per-user token as a user-agent', () => {
    expect(parseAgentConnection({ user, instance: null })).toEqual({ kind: 'user-agent', user });
  });

  it('reads an owned instance token as an owned-box', () => {
    expect(parseAgentConnection({ user, instance })).toEqual({ kind: 'owned-box', user, instance });
  });

  it('reads an ownerless instance token as a warm-box', () => {
    expect(parseAgentConnection({ user: null, instance })).toEqual({ kind: 'warm-box', instance });
  });

  it('returns null when the token carries neither an owner nor a box', () => {
    expect(parseAgentConnection({ user: null, instance: null })).toBe(null);
  });
});

describe('registryKeyOf', () => {
  it('keys a user-agent by user id and logs the unix username', () => {
    expect(registryKeyOf({ kind: 'user-agent', user }))
      .toEqual({ scope: 'user', key: 'user_1', label: 'peter' });
  });

  it('keys an owned-box by instance id and logs "instance <name>"', () => {
    expect(registryKeyOf({ kind: 'owned-box', user, instance }))
      .toEqual({ scope: 'instance', key: 'inst_1', label: 'instance peter-heavy' });
  });

  it('keys a warm-box the same way as an owned-box', () => {
    expect(registryKeyOf({ kind: 'warm-box', instance }))
      .toEqual({ scope: 'instance', key: 'inst_1', label: 'instance peter-heavy' });
  });
});

describe('nextStatusOnConnect', () => {
  it('promotes provisioning to ready', () => {
    expect(nextStatusOnConnect('provisioning')).toBe('ready');
  });

  it('promotes awaiting-agent to ready', () => {
    expect(nextStatusOnConnect('awaiting-agent')).toBe('ready');
  });

  it('leaves warming alone so the on-warm result decides', () => {
    expect(nextStatusOnConnect('warming')).toBe('warming');
  });

  it('leaves warm alone', () => {
    expect(nextStatusOnConnect('warm')).toBe('warm');
  });

  it('leaves ready alone', () => {
    expect(nextStatusOnConnect('ready')).toBe('ready');
  });

  it('makes a starting box ready: its agent is back after a start', () => {
    expect(nextStatusOnConnect('starting')).toBe('ready');
  });

  // A stopped box whose agent dials in was started outside termag, e.g. by the
  // Resize box workflow; without this it would read "stopped" while running.
  it('makes a stopped box ready when its agent connects', () => {
    expect(nextStatusOnConnect('stopped')).toBe('ready');
  });

  it('leaves stopping alone: a redial during shutdown is not the box coming back', () => {
    expect(nextStatusOnConnect('stopping')).toBe('stopping');
  });

  it('treats hibernating and hibernated like stopping and stopped', () => {
    expect(nextStatusOnConnect('hibernating')).toBe('hibernating');
    expect(nextStatusOnConnect('hibernated')).toBe('ready');
  });

  it('does not resurrect a failed box', () => {
    expect(nextStatusOnConnect('failed')).toBe('failed');
  });

  it('does not resurrect a terminated box', () => {
    expect(nextStatusOnConnect('terminated')).toBe('terminated');
  });

  it('passes an unrecognised status through unchanged', () => {
    expect(nextStatusOnConnect('hibernating')).toBe('hibernating');
  });

  it('passes the empty string through unchanged', () => {
    expect(nextStatusOnConnect('')).toBe('');
  });

  it('maps every known status to another known status', () => {
    for (const status of INSTANCE_STATUSES) {
      expect(INSTANCE_STATUSES).toContain(nextStatusOnConnect(status));
    }
  });
});

describe('connectUpdate', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('marks a provisioning box ready', () => {
    expect(connectUpdate(instanceWithStatus('provisioning'), now)).toEqual({
      where: { id: instance.id, status: 'provisioning' },
      data: { status: 'ready', lastConnectedAt: now },
    });
  });

  it('does not make a warming box ready', () => {
    expect(connectUpdate(instanceWithStatus('warming'), now)).toEqual({
      where: { id: instance.id, status: 'warming' },
      data: { status: 'warming', lastConnectedAt: now },
    });
  });

  it('does not resurrect a terminated box', () => {
    expect(connectUpdate(instanceWithStatus('terminated'), now)).toEqual({
      where: { id: instance.id, status: 'terminated' },
      data: { status: 'terminated', lastConnectedAt: now },
    });
  });

  // The status here is computed from the row as it was read when the socket
  // authenticated. Writing it unguarded puts that snapshot back over whatever
  // the row has since become, and the case that costs something is a box that
  // reached `warm` in the meantime being handed back to the pool as `warming`.
  it('only writes the status the decision was made from', () => {
    for (const status of INSTANCE_STATUSES) {
      expect(connectUpdate(instanceWithStatus(status), now).where)
        .toEqual({ id: instance.id, status });
    }
  });

  it('never writes agentDisconnectedAt, which only the close path owns', () => {
    // The connect and close writes are both fire-and-forget and unordered, so a
    // connect update that touched this column would clear a disconnect that had
    // already landed and leave a dead box reading as connected.
    for (const status of INSTANCE_STATUSES) {
      expect(Object.keys(connectUpdate(instanceWithStatus(status), now).data).sort())
        .toEqual(['lastConnectedAt', 'status']);
    }
  });
});

describe('warmCompletionUpdate', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('guards the promotion on warming plus a succeeded on-warm run', () => {
    expect(warmCompletionUpdate('inst_1', true, now)).toEqual({
      where: { id: 'inst_1', status: 'warming', onWarmStatus: 'succeeded' },
      data: { status: 'warm', warmedAt: now },
    });
  });

  it('attempts nothing while the agent is not connected', () => {
    expect(warmCompletionUpdate('inst_1', false, now)).toBe(null);
  });

  it('attempts the promotion only once the agent has connected, whichever event is second', () => {
    const later = new Date('2026-09-21T12:00:05.000Z');
    // On-warm succeeds first, agent connects second: the first call is a no-op
    // because liveness is the missing half, the second carries the promotion.
    expect([warmCompletionUpdate('inst_1', false, now), warmCompletionUpdate('inst_1', true, later)]).toEqual([
      null,
      { where: { id: 'inst_1', status: 'warming', onWarmStatus: 'succeeded' }, data: { status: 'warm', warmedAt: later } },
    ]);
    // Agent connects first, on-warm succeeds second: both calls carry the same
    // guarded update, and the where clause is what makes the second a no-op.
    expect([warmCompletionUpdate('inst_1', true, now), warmCompletionUpdate('inst_1', true, later)].map(u => u?.where)).toEqual([
      { id: 'inst_1', status: 'warming', onWarmStatus: 'succeeded' },
      { id: 'inst_1', status: 'warming', onWarmStatus: 'succeeded' },
    ]);
  });
});

describe('isManagedBox', () => {
  it('is an owned EC2 box only', () => {
    expect(isManagedBox({ userId: 'u', kind: 'ec2' })).toBe(true);
    expect(isManagedBox({ userId: 'u', kind: 'external' })).toBe(false);
    expect(isManagedBox({ userId: null, kind: 'ec2' })).toBe(false);
  });
});
