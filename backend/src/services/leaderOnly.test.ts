import { describe, expect, it, vi } from 'vitest';
import { leaderOnly, type LeaderOnlyService } from './leaderOnly';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fakeService(startResult: () => Promise<boolean> = async () => true) {
  const calls: string[] = [];
  const svc: LeaderOnlyService = {
    name: 'FAKE',
    start: vi.fn(async () => { calls.push('start'); return startResult(); }),
    stop: vi.fn(async () => { calls.push('stop'); }),
  };
  return { svc, calls };
}

describe('leaderOnly', () => {
  it('never connects until the lease is held', async () => {
    const { svc, calls } = fakeService();
    const bot = leaderOnly(svc, () => {});
    await bot.settled();
    expect(calls).toEqual([]);
    expect(bot.isRunning()).toBe(false);
  });

  it('starts on serve and stops on drain', async () => {
    const { svc, calls } = fakeService();
    const bot = leaderOnly(svc, () => {});
    bot.set(true);
    await bot.settled();
    expect(bot.isRunning()).toBe(true);
    bot.set(false);
    await bot.settled();
    expect(calls).toEqual(['start', 'stop']);
    expect(bot.isRunning()).toBe(false);
  });

  it('a drain during a start stops once the start has finished', async () => {
    const gate = deferred<boolean>();
    const { svc, calls } = fakeService(() => gate.promise);
    const bot = leaderOnly(svc, () => {});
    bot.set(true);
    bot.set(false);
    gate.resolve(true);
    await bot.settled();
    expect(calls).toEqual(['start', 'stop']);
    expect(bot.isRunning()).toBe(false);
  });

  it('serve, drain, serve while starting ends connected with one start', async () => {
    const gate = deferred<boolean>();
    const { svc, calls } = fakeService(() => gate.promise);
    const bot = leaderOnly(svc, () => {});
    bot.set(true);
    bot.set(false);
    bot.set(true);
    gate.resolve(true);
    await bot.settled();
    expect(calls).toEqual(['start']);
    expect(bot.isRunning()).toBe(true);
  });

  it('a disabled or failed start is not retried until the next serve', async () => {
    const results = [false, true];
    const { svc, calls } = fakeService(async () => results.shift()!);
    const bot = leaderOnly(svc, () => {});
    bot.set(true);
    await bot.settled();
    expect(bot.isRunning()).toBe(false);
    expect(calls).toEqual(['start']);
    bot.set(true);
    await bot.settled();
    expect(calls).toEqual(['start', 'start']);
    expect(bot.isRunning()).toBe(true);
  });

  it('a start that throws is logged, not raised', async () => {
    const log = vi.fn();
    const { svc } = fakeService(async () => { throw new Error('boom'); });
    const bot = leaderOnly(svc, log);
    bot.set(true);
    await bot.settled();
    expect(bot.isRunning()).toBe(false);
    expect(log).toHaveBeenCalledWith('[FAKE] start failed: boom');
  });
});
