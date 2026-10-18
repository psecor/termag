import { describe, expect, it } from 'vitest';
import {
  BOX_PARKED_CLOSE_CODE,
  BoxParkedNotice,
  FAILED_AFTER_ATTEMPTS,
  initialPaneLoop,
  PaneEffects,
  PaneEvent,
  PaneLoop,
  parseBoxParkedNotice,
  RECONNECT_DELAYS_MS,
  STARTING_POLL_MS,
  step,
} from './terminalReconnect';

const stopped: BoxParkedNotice = {
  instanceId: 'box-1',
  status: 'stopped',
  message: 'This box is stopped. Start it from the Boxes list first.',
};
const starting: BoxParkedNotice = { ...stopped, status: 'starting', message: 'This box is starting. Try again once it is ready.' };

/** What the backend's terminal socket does for a parked box: open, frame, legacy output copy, close. */
const refusedParked = (notice: BoxParkedNotice): PaneEvent[] => [
  { type: 'dial' },
  { type: 'open' },
  { type: 'box-power', notice },
  { type: 'output' },
  { type: 'close', code: BOX_PARKED_CLOSE_CODE },
];
/** An agent-not-connected refusal: open, output, close 1008. */
const refusedAgentDown: PaneEvent[] = [{ type: 'dial' }, { type: 'open' }, { type: 'output' }, { type: 'close', code: 1008 }];
/** A socket that never opens (backend down, network gone). */
const unreachable: PaneEvent[] = [{ type: 'dial' }, { type: 'close', code: 1006 }];
/** An attach that works: open, then the tmux repaint. */
const attached: PaneEvent[] = [{ type: 'dial' }, { type: 'open' }, { type: 'output' }];

function run(events: PaneEvent[], from: PaneLoop = initialPaneLoop) {
  let loop = from;
  const fxs: PaneEffects[] = [];
  for (const e of events) {
    const r = step(loop, e);
    loop = r.loop;
    fxs.push(r.fx);
  }
  return {
    loop,
    fxs,
    announced: fxs.filter(f => f.announceReconnected).length,
    written: fxs.filter(f => f.write).length,
    retries: fxs.flatMap(f => (f.retryInMs === undefined ? [] : [f.retryInMs])),
    lastPane: [...fxs].reverse().find(f => f.paneState)?.paneState,
  };
}

describe('a pane on a stopped box', () => {
  it('stops after the first refusal: no retry, no [reconnected], the message not written into the pane', () => {
    const r = run(refusedParked(stopped));
    expect(r.retries).toEqual([]);
    expect(r.announced).toBe(0);
    expect(r.written).toBe(0);
    expect(r.lastPane).toBe('parked');
    expect(r.loop.parked).toEqual(stopped);
  });

  it('does not spam when something does dial it again (the reported bug: a line pair every attempt)', () => {
    const r = run([...refusedParked(stopped), ...refusedParked(stopped), ...refusedParked(stopped)]);
    expect(r.announced).toBe(0);
    expect(r.written).toBe(0);
    expect(r.retries).toEqual([]);
  });

  it('is treated the same while the box is still stopping', () => {
    const r = run(refusedParked({ ...stopped, status: 'stopping' }));
    expect(r.retries).toEqual([]);
    expect(r.lastPane).toBe('parked');
  });

  it('dials once when the box list reports a different status, and not for the same one', () => {
    const { loop } = run(refusedParked(stopped));
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'stopped', ownBox: true }).fx).toEqual({});
    expect(step(loop, { type: 'box-status', instanceId: 'box-2', status: 'starting', ownBox: false }).fx).toEqual({});
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'starting', ownBox: true }).fx).toEqual({ dialNow: true });
  });

  it('dials again when its own box goes down under an open pane, whose socket the backend leaves dead', () => {
    const { loop } = run(attached);
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'stopping', ownBox: true }).fx).toEqual({ dialNow: true });
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'hibernating', ownBox: true }).fx).toEqual({ dialNow: true });
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'stopped', ownBox: true }).fx).toEqual({ dialNow: true });
    const r = run([...refusedParked({ ...stopped, status: 'stopping' })], loop);
    expect(r.announced).toBe(0);
    expect(r.lastPane).toBe('parked');
  });

  it('leaves an open pane alone for other boxes and for statuses that are not a stop', () => {
    const { loop } = run(attached);
    expect(step(loop, { type: 'box-status', instanceId: 'box-2', status: 'stopped', ownBox: false }).fx).toEqual({});
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'ready', ownBox: true }).fx).toEqual({});
    expect(step(loop, { type: 'box-status', instanceId: 'box-1', status: 'starting', ownBox: true }).fx).toEqual({});
  });
});

describe('a pane on a starting box', () => {
  it('polls at the slow interval without writing anything, however many attempts it takes', () => {
    const events = Array.from({ length: 6 }, () => refusedParked(starting)).flat();
    const r = run(events);
    expect(r.retries).toEqual(Array(6).fill(STARTING_POLL_MS));
    expect(r.announced).toBe(0);
    expect(r.written).toBe(0);
    expect(r.loop.attempt).toBe(0);
    const afterFirstRefusal = r.fxs.slice(refusedParked(starting).length);
    expect(afterFirstRefusal.every(f => f.paneState === undefined || f.paneState === 'parked')).toBe(true);
  });

  it('polls more slowly than the quick-retry schedule', () => {
    expect(STARTING_POLL_MS).toBeGreaterThan(RECONNECT_DELAYS_MS[FAILED_AFTER_ATTEMPTS - 1]);
  });

  it('announces [reconnected] once and writes again when the box is back', () => {
    const { loop } = run([...refusedParked(stopped), ...refusedParked(starting)]);
    const r = run([...attached, { type: 'output' }], loop);
    expect(r.announced).toBe(1);
    expect(r.written).toBe(2);
    expect(r.lastPane).toBe('connected');
    expect(r.loop.parked).toBe(null);
  });
});

describe('every other disconnect behaves as before', () => {
  it('a dropped attach retries on the original schedule and goes to failed after the budget', () => {
    const r = run([...attached, ...Array.from({ length: 9 }, () => unreachable).flat()]);
    expect(r.retries).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000]);
    expect(r.lastPane).toBe('failed');
  });

  it('an agent-not-connected refusal still writes its message and announces [reconnected] on the next open', () => {
    const r = run([...attached, { type: 'close', code: 1006 }, ...refusedAgentDown]);
    expect(r.announced).toBe(1);
    expect(r.written).toBe(2);
    expect(r.retries).toEqual([500, 500]);
  });

  it('a parked pane whose next attempt fails some other way goes back to the ordinary schedule', () => {
    const r = run([...refusedParked(starting), ...unreachable]);
    expect(r.retries).toEqual([STARTING_POLL_MS, 500]);
    expect(r.loop.parked).toBe(null);
    expect(r.lastPane).toBe('reconnecting');
  });

  it('a manual retry resets the budget and dials at once', () => {
    const { loop } = run([...attached, ...unreachable, ...unreachable]);
    expect(loop.attempt).toBe(2);
    const r = step(loop, { type: 'retry' });
    expect(r.loop.attempt).toBe(0);
    expect(r.fx).toEqual({ dialNow: true });
  });
});

describe('parseBoxParkedNotice', () => {
  it('reads the backend frame', () => {
    expect(parseBoxParkedNotice({ type: 'box-power', ...stopped })).toEqual(stopped);
  });

  it('reads a hibernating or hibernated box as parked', () => {
    for (const status of ['hibernating', 'hibernated'] as const) {
      expect(parseBoxParkedNotice({ type: 'box-power', ...stopped, status })?.status).toBe(status);
    }
  });

  it('rejects anything else', () => {
    expect(parseBoxParkedNotice({ type: 'output', data: 'x' })).toBe(null);
    expect(parseBoxParkedNotice({ type: 'box-power', instanceId: 'b', status: 'ready', message: 'm' })).toBe(null);
    expect(parseBoxParkedNotice({ type: 'box-power', status: 'stopped', message: 'm' })).toBe(null);
    expect(parseBoxParkedNotice(null)).toBe(null);
  });
});
