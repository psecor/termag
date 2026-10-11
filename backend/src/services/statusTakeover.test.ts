import { describe, expect, it } from 'vitest';
import { createStatusTakeover } from './statusTakeover';

function harness(rehydrate: () => Promise<number> = async () => 2) {
  const suspended: boolean[] = [];
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const takeover = createStatusTakeover({
    delayMs: 36_500,
    rehydrate: () => { calls.push('rehydrate'); return rehydrate(); },
    setTimersSuspended: s => suspended.push(s),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { (t as { cleared: boolean }).cleared = true; },
    log: () => {},
  });
  return { takeover, suspended, calls, timers };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe('createStatusTakeover', () => {
  it('keeps the timers suspended through the drain window, re-reads, then arms them', async () => {
    const { takeover, suspended, calls, timers } = harness();
    takeover.serve();
    expect(suspended).toEqual([true]);
    expect(timers.map(t => t.ms)).toEqual([36_500]);
    expect(calls).toEqual([]);

    timers[0].fn();
    expect(calls).toEqual(['rehydrate']);
    expect(suspended).toEqual([true]);
    await settle();
    expect(suspended).toEqual([true, false]);
  });

  it('arms the timers even when the re-read fails', async () => {
    const { takeover, suspended, timers } = harness(async () => { throw new Error('db down'); });
    takeover.serve();
    timers[0].fn();
    await settle();
    expect(suspended).toEqual([true, false]);
  });

  it('draining before the re-read cancels it and keeps the timers suspended', async () => {
    const { takeover, suspended, calls, timers } = harness();
    takeover.serve();
    takeover.drain();
    expect(timers[0].cleared).toBe(true);
    expect(suspended).toEqual([true, true]);
    expect(calls).toEqual([]);
  });

  it('a re-read that finishes after a drain does not arm the timers', async () => {
    let finish!: (n: number) => void;
    const { takeover, suspended, timers } = harness(() => new Promise(r => { finish = r; }));
    takeover.serve();
    timers[0].fn();
    takeover.drain();
    finish(1);
    await settle();
    expect(suspended).toEqual([true, true]);
  });

  it('a re-read from an earlier term does not arm the timers for a later one', async () => {
    const finishers: Array<(n: number) => void> = [];
    const { takeover, suspended, calls, timers } = harness(() => new Promise(r => { finishers.push(r); }));
    takeover.serve();
    timers[0].fn();
    takeover.drain();
    takeover.serve();
    finishers[0](0);
    await settle();
    expect(suspended).toEqual([true, true, true]);

    timers[1].fn();
    expect(calls).toEqual(['rehydrate', 'rehydrate']);
    finishers[1](0);
    await settle();
    expect(suspended).toEqual([true, true, true, false]);
  });
});
