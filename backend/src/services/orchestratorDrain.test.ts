import { describe, expect, it } from 'vitest';
import { createDrain } from './orchestratorDrain';

function harness() {
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const drain = createDrain({
    graceMs: 45_000,
    browserDelayMs: 1_500,
    startLeaderWork: () => calls.push('start'),
    stopLeaderWork: () => calls.push('stop'),
    closeAgents: () => { calls.push('agents'); return 2; },
    closeBrowsers: () => { calls.push('browsers'); return 3; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    log: () => {},
  });
  return { drain, calls, timers };
}

describe('createDrain', () => {
  it('is not serving until told to, so a starting process fails its health check', () => {
    const { drain, calls } = harness();
    expect(drain.isServing()).toBe(false);
    drain.serve();
    drain.serve();
    expect(drain.isServing()).toBe(true);
    expect(calls).toEqual(['start']);
  });

  it('stops the singleton work at once, closes agents after the grace and browsers after that', () => {
    const { drain, calls, timers } = harness();
    drain.serve();
    drain.drain();
    expect(drain.isServing()).toBe(false);
    expect(calls).toEqual(['start', 'stop']);
    expect(timers.map(t => t.ms)).toEqual([45_000]);
    timers[0].fn();
    expect(calls).toEqual(['start', 'stop', 'agents']);
    expect(timers.map(t => t.ms)).toEqual([45_000, 1_500]);
    timers[1].fn();
    expect(calls).toEqual(['start', 'stop', 'agents', 'browsers']);
  });

  it('serving again during the grace keeps every connection', () => {
    const { drain, calls, timers } = harness();
    drain.serve();
    drain.drain();
    drain.serve();
    expect(timers[0].cleared).toBe(true);
    expect(calls).toEqual(['start', 'stop', 'start']);
  });

  it('serving again between the agent and browser closes keeps the browsers', () => {
    const { drain, calls, timers } = harness();
    drain.serve();
    drain.drain();
    timers[0].fn();
    drain.serve();
    expect(timers[1].cleared).toBe(true);
    expect(calls).toEqual(['start', 'stop', 'agents', 'start']);
  });
});
