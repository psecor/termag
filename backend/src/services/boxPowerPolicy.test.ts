import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POWER_TIMEOUTS,
  hibernateFallbackNote,
  hibernationRefreshDue,
  hibernationRefreshMsFromEnv,
  isHibernateRefusal,
  PARKED_STATUSES,
  PowerRequestBox,
  powerRequestError,
  powerStateError,
  powerTimeoutsFromEnv,
  settlePowerState,
  TERMINAL_BOX_PARKED_CLOSE_CODE,
  terminalAttachRefusal,
  terminalBoxParkedNotice,
} from './boxPowerPolicy';
import { INSTANCE_STATUSES } from './instanceLifecycle';

const owned: PowerRequestBox = {
  userId: 'u1', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-0abc', hibernationConfigured: true,
};
const parked: readonly string[] = PARKED_STATUSES;
const box = (over: Partial<PowerRequestBox>) => ({ ...owned, ...over });

describe('powerRequestError', () => {
  it('lets the owner stop a ready EC2 box', () => {
    expect(powerRequestError(owned, 'u1', 'stop', true)).toBe(null);
  });

  it('lets the owner start a stopped EC2 box', () => {
    expect(powerRequestError(box({ status: 'stopped' }), 'u1', 'start', true)).toBe(null);
  });

  it("answers 404 for another user's box, the same as for a missing one", () => {
    expect(powerRequestError(owned, 'u2', 'stop', true)).toEqual({ status: 404, error: 'Box not found' });
    expect(powerRequestError(null, 'u2', 'stop', true)).toEqual({ status: 404, error: 'Box not found' });
  });

  it('answers 404 for an unclaimed pool box, which has no owner', () => {
    expect(powerRequestError(box({ userId: null, status: 'warm' }), 'u1', 'stop', true)?.status).toBe(404);
  });

  it('refuses self-managed boxes', () => {
    expect(powerRequestError(box({ kind: 'external' }), 'u1', 'stop', true))
      .toEqual({ status: 400, error: 'Only EC2 boxes can be stopped from termag' });
  });

  it('refuses when box provisioning is not configured', () => {
    expect(powerRequestError(owned, 'u1', 'stop', false)?.status).toBe(503);
  });

  it('refuses a box with no EC2 instance yet', () => {
    expect(powerRequestError(box({ ec2InstanceId: null }), 'u1', 'stop', true)?.status).toBe(409);
  });

  it('accepts stop only from ready or starting', () => {
    const allowed = INSTANCE_STATUSES.filter(s => powerRequestError(box({ status: s }), 'u1', 'stop', true) === null);
    expect(allowed).toEqual(['ready', 'starting']);
  });

  it('accepts start from stopped or hibernated, which resumes it', () => {
    const allowed = INSTANCE_STATUSES.filter(s => powerRequestError(box({ status: s }), 'u1', 'start', true) === null);
    expect(allowed).toEqual(['stopped', 'hibernated']);
  });

  it('accepts hibernate only from ready', () => {
    const allowed = INSTANCE_STATUSES.filter(s => powerRequestError(box({ status: s }), 'u1', 'hibernate', true) === null);
    expect(allowed).toEqual(['ready']);
  });

  it('refuses to hibernate a box launched without hibernation, pointing at stop', () => {
    for (const hibernationConfigured of [false, undefined]) {
      expect(powerRequestError(box({ hibernationConfigured }), 'u1', 'hibernate', true)).toEqual({
        status: 409, error: 'This box was launched without hibernation support. Stop it instead.',
      });
      expect(powerRequestError(box({ hibernationConfigured }), 'u1', 'stop', true)).toBe(null);
    }
  });

  it('names hibernate in the self-managed refusal', () => {
    expect(powerRequestError(box({ kind: 'external' }), 'u1', 'hibernate', true)?.error)
      .toBe('Only EC2 boxes can be hibernated from termag');
  });

  it('names the status it refused', () => {
    expect(powerRequestError(box({ status: 'stopping' }), 'u1', 'start', true))
      .toEqual({ status: 409, error: "Can't start a box that is stopping" });
  });
});

describe('powerStateError', () => {
  it('explains a stopped, stopping, starting, hibernating or hibernated box', () => {
    expect(powerStateError('stopped')).toMatch(/stopped\. Start it/);
    expect(powerStateError('stopping')).toMatch(/stopping/);
    expect(powerStateError('starting')).toMatch(/starting/);
    expect(powerStateError('hibernating')).toMatch(/hibernating/);
    expect(powerStateError('hibernated')).toMatch(/hibernated\. Resume it/);
  });

  it('says nothing for any other status', () => {
    for (const s of INSTANCE_STATUSES.filter(s => !parked.includes(s))) {
      expect(powerStateError(s)).toBe(null);
    }
  });
});

describe('terminalBoxParkedNotice', () => {
  it('names the box, its power state and the message a parked pane shows', () => {
    expect(terminalBoxParkedNotice('box-1', 'stopped')).toEqual({
      type: 'box-power',
      instanceId: 'box-1',
      status: 'stopped',
      message: 'This box is stopped. Start it from the Boxes list first.',
    });
    expect(terminalBoxParkedNotice('box-1', 'starting')?.status).toBe('starting');
    expect(terminalBoxParkedNotice('box-1', 'stopping')?.status).toBe('stopping');
    expect(terminalBoxParkedNotice('box-1', 'hibernated')?.status).toBe('hibernated');
  });

  it('is null for every other status, which keeps the plain "agent not connected" close', () => {
    for (const s of INSTANCE_STATUSES.filter(s => !parked.includes(s))) {
      expect(terminalBoxParkedNotice('box-1', s)).toBe(null);
    }
  });

  it('uses an application close code, distinct from the 1008 every other refusal uses', () => {
    expect(TERMINAL_BOX_PARKED_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(TERMINAL_BOX_PARKED_CLOSE_CODE).toBeLessThan(5000);
  });
});

describe('terminalAttachRefusal', () => {
  const settled = { id: 'p1', setupStatus: 'none' };
  const project = (setupStatus: string) => ({ id: 'p1', setupStatus });

  it('refuses a stopping box whose agent is still connected, as EC2 has not powered it off yet', () => {
    expect(terminalAttachRefusal('box-1', 'stopping', true, settled)).toEqual({
      kind: 'parked',
      notice: expect.objectContaining({ type: 'box-power', instanceId: 'box-1', status: 'stopping' }),
    });
  });

  it('refuses a parked box the same way whether or not its agent is connected', () => {
    for (const status of parked) {
      for (const connected of [true, false]) {
        expect(terminalAttachRefusal('box-1', status, connected, settled)?.kind).toBe('parked');
      }
    }
  });

  it('routes a ready box with its agent, and refuses one without as agent-not-connected', () => {
    expect(terminalAttachRefusal('box-1', 'ready', true, settled)).toBe(null);
    expect(terminalAttachRefusal('box-1', 'ready', false, settled)).toEqual({ kind: 'agent-not-connected' });
  });

  it('judges a box-less project on its agent alone', () => {
    expect(terminalAttachRefusal(null, null, true, settled)).toBe(null);
    expect(terminalAttachRefusal(null, null, false, settled)).toEqual({ kind: 'agent-not-connected' });
    expect(terminalAttachRefusal(null, null, true, null)).toBe(null);
  });

  it('says a parked box is parked before it says the project is still cloning', () => {
    expect(terminalAttachRefusal('box-1', 'stopped', false, project('pending'))?.kind).toBe('parked');
  });

  it('refuses a project that is still setting up, with the reason, even with its agent connected', () => {
    expect(terminalAttachRefusal('box-1', 'ready', true, project('cloning'))).toEqual({
      kind: 'setup',
      refusal: { setupStatus: 'cloning', message: 'This project is still cloning its repository.' },
    });
    expect(terminalAttachRefusal('box-1', 'ready', true, project('failed'))).toEqual({
      kind: 'setup',
      refusal: { setupStatus: 'failed', message: "This project's clone failed. Retry it or start empty." },
    });
  });

  it('says a cold box is waiting to clone rather than that its agent is away', () => {
    expect(terminalAttachRefusal('box-1', 'ready', false, project('pending'))).toEqual({
      kind: 'setup',
      refusal: { setupStatus: 'pending', message: 'This project is waiting for its box to clone the repository.' },
    });
  });

  it('lets a ready project through to the agent check', () => {
    expect(terminalAttachRefusal('box-1', 'ready', true, project('ready'))).toBe(null);
    expect(terminalAttachRefusal('box-1', 'ready', false, project('ready'))).toEqual({ kind: 'agent-not-connected' });
  });
});

describe('settlePowerState', () => {
  const t = DEFAULT_POWER_TIMEOUTS;
  const stopping = { status: 'stopping', provisioningError: null };
  const starting = { status: 'starting', provisioningError: null };

  it('settles stopping to stopped once EC2 reports stopped', () => {
    expect(settlePowerState(stopping, 'stopped', 1000, t)).toEqual({ status: 'stopped', provisioningError: null });
  });

  it('waits while EC2 is still stopping', () => {
    expect(settlePowerState(stopping, 'stopping', t.stopMs * 2, t)).toBe(null);
  });

  it('gives up on a stop EC2 never carried out, back to ready with the reason', () => {
    expect(settlePowerState(stopping, 'running', t.stopMs - 1, t)).toBe(null);
    expect(settlePowerState(stopping, 'running', t.stopMs, t)).toEqual({
      status: 'ready',
      provisioningError: 'Stop did not complete: EC2 still reports the instance running after 10 minutes',
    });
  });

  it('leaves the row alone when the instance cannot be described', () => {
    expect(settlePowerState(stopping, undefined, t.stopMs * 2, t)).toBe(null);
    expect(settlePowerState(starting, undefined, t.startMs * 2, t)).toBe(null);
  });

  it('never settles starting to ready: only the agent connect does that', () => {
    for (const state of ['pending', 'running', 'stopping', 'stopped', 'terminated']) {
      expect(settlePowerState(starting, state, t.startMs * 2, t)?.status).not.toBe('ready');
    }
  });

  it('reports a start that did not take, after EC2 has had time to catch up', () => {
    expect(settlePowerState(starting, 'stopped', 10_000, t)).toBe(null);
    expect(settlePowerState(starting, 'stopped', 60_000, t)).toEqual({
      status: 'stopped', provisioningError: 'Start did not take: EC2 reports the instance stopped',
    });
  });

  it('reports a running box whose agent never connects, once, and keeps it starting', () => {
    expect(settlePowerState(starting, 'running', t.startMs - 1, t)).toBe(null);
    const reported = settlePowerState(starting, 'running', t.startMs, t);
    expect(reported).toEqual({
      provisioningError: 'The box is running but its agent has not connected after 15 minutes. '
        + 'Stop it and start it again, or terminate it.',
    });
    expect(settlePowerState({ status: 'starting', provisioningError: reported!.provisioningError }, 'running', t.startMs * 2, t))
      .toBe(null);
  });

  const hibernating = { status: 'hibernating', provisioningError: null };

  it('keeps the note a hibernate fallback left when the stop settles', () => {
    const note = hibernateFallbackNote('not ready');
    expect(settlePowerState({ status: 'stopping', provisioningError: note }, 'stopped', 1000, t))
      .toEqual({ status: 'stopped', provisioningError: note });
  });

  it('settles hibernating to hibernated once EC2 reports it stopped by the hibernate', () => {
    expect(settlePowerState(hibernating, 'stopped', 1000, t, 'Client.UserInitiatedHibernate'))
      .toEqual({ status: 'hibernated', provisioningError: null });
    expect(settlePowerState(hibernating, 'stopped', 1000, t)).toEqual({ status: 'hibernated', provisioningError: null });
  });

  it('settles hibernating to stopped when EC2 says the instance stopped some other way', () => {
    expect(settlePowerState(hibernating, 'stopped', 1000, t, 'Client.UserInitiatedShutdown')).toEqual({
      status: 'stopped',
      provisioningError: 'EC2 stopped the box without hibernating it (Client.UserInitiatedShutdown). '
        + 'Its sessions are recreated when you start it.',
    });
  });

  it('waits while EC2 is writing the RAM out, and gives up on one it never carries out', () => {
    expect(settlePowerState(hibernating, 'stopping', t.stopMs * 2, t)).toBe(null);
    expect(settlePowerState(hibernating, 'running', t.stopMs, t)).toEqual({
      status: 'ready',
      provisioningError: 'Hibernate did not complete: EC2 still reports the instance running after 10 minutes',
    });
  });

  it('puts a resume that did not take back to hibernated', () => {
    expect(settlePowerState({ ...starting, hibernatedAt: new Date() }, 'stopped', 60_000, t)).toEqual({
      status: 'hibernated', provisioningError: 'Start did not take: EC2 reports the instance stopped',
    });
  });

  it('ignores every other status', () => {
    for (const s of INSTANCE_STATUSES.filter(s => !['stopping', 'hibernating', 'starting'].includes(s))) {
      expect(settlePowerState({ status: s, provisioningError: null }, 'stopped', t.startMs * 2, t)).toBe(null);
    }
  });
});

describe('powerTimeoutsFromEnv', () => {
  it('defaults to 10 minutes to stop and 15 to start', () => {
    expect(powerTimeoutsFromEnv({})).toEqual({ stopMs: 600_000, startMs: 900_000 });
  });

  it('reads positive second overrides and ignores junk', () => {
    expect(powerTimeoutsFromEnv({ BOX_STOP_TIMEOUT_SECONDS: '30', BOX_START_TIMEOUT_SECONDS: 'x' }))
      .toEqual({ stopMs: 30_000, startMs: 900_000 });
  });
});

describe('isHibernateRefusal', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('recognises EC2 refusing the hibernate itself', () => {
    expect(isHibernateRefusal(named('UnsupportedHibernationConfiguration', 'not configured'))).toBe(true);
    expect(isHibernateRefusal(named('UnsupportedOperation', 'Instance is not ready to hibernate yet, please try again later.'))).toBe(true);
  });

  it('leaves every other stop failure to the ordinary error path', () => {
    expect(isHibernateRefusal(named('UnauthorizedOperation', 'You are not authorized to perform this operation.'))).toBe(false);
    expect(isHibernateRefusal(named('IncorrectInstanceState', 'The instance is not in a state from which it can be stopped.'))).toBe(false);
  });
});

describe('hibernation refresh', () => {
  const day = 24 * 60 * 60 * 1000;

  it('defaults to 55 days, reads overrides, caps below 60 and turns off at 0', () => {
    expect(hibernationRefreshMsFromEnv({})).toBe(55 * day);
    expect(hibernationRefreshMsFromEnv({ BOX_HIBERNATION_REFRESH_DAYS: '30' })).toBe(30 * day);
    expect(hibernationRefreshMsFromEnv({ BOX_HIBERNATION_REFRESH_DAYS: '90' })).toBe(59 * day);
    expect(hibernationRefreshMsFromEnv({ BOX_HIBERNATION_REFRESH_DAYS: '0' })).toBe(0);
    expect(hibernationRefreshMsFromEnv({ BOX_HIBERNATION_REFRESH_DAYS: 'soon' })).toBe(55 * day);
  });

  it('is due only for a box hibernated at least that long', () => {
    const now = Date.UTC(2026, 9, 6);
    const at = (daysAgo: number) => new Date(now - daysAgo * day);
    expect(hibernationRefreshDue({ status: 'hibernated', hibernatedAt: at(55) }, now, 55 * day)).toBe(true);
    expect(hibernationRefreshDue({ status: 'hibernated', hibernatedAt: at(54) }, now, 55 * day)).toBe(false);
    expect(hibernationRefreshDue({ status: 'hibernated', hibernatedAt: null }, now, 55 * day)).toBe(false);
    expect(hibernationRefreshDue({ status: 'stopped', hibernatedAt: at(80) }, now, 55 * day)).toBe(false);
    expect(hibernationRefreshDue({ status: 'hibernated', hibernatedAt: at(80) }, now, 0)).toBe(false);
  });
});
