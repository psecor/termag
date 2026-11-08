import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spans = vi.hoisted(() => ({ failRoot: vi.fn() }));
vi.mock('./tracing/spans', () => ({ failRoot: spans.failRoot, traceSweep: (_n: string, tick: () => unknown) => tick }));
import {
  GENERATION_POLL_MS, currentBazelCacheGeneration, parseGenerationPointer, readBazelCacheGeneration, setBazelCacheGenerationForTest, startBazelCacheGenerationReader,
} from './bazelCacheGeneration';

const ORIGIN = 'https://b-1.s3.us-east-2.amazonaws.com';
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
const status = (code: number) => async () => ({ ok: false, status: code, json: async () => ({}) });
const pointer = (generation: unknown) => ({ generation, commit: 'abc', readyAt: '2026-11-03T00:05:00Z' });

beforeEach(() => {
  setBazelCacheGenerationForTest(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('parseGenerationPointer', () => {
  it('takes the generation of a valid pointer and refuses anything else', () => {
    expect(parseGenerationPointer(pointer('2026w45'))).toEqual({ generation: '2026w45' });
    for (const bad of [null, [], 'x', {}, pointer(45), pointer('../x'), pointer('2026w99')]) expect(parseGenerationPointer(bad)).toHaveProperty('error');
  });
});

describe('readBazelCacheGeneration', () => {
  it('reads <origin>/current-generation, uses a valid pointer and calls onChange once per change', async () => {
    const fetchFn = vi.fn(ok(pointer('2026w45')));
    const onChange = vi.fn();
    expect(await readBazelCacheGeneration(ORIGIN, onChange, fetchFn)).toBe('2026w45');
    expect(fetchFn).toHaveBeenCalledWith(`${ORIGIN}/current-generation`, { signal: expect.any(AbortSignal) });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026w45');
    await readBazelCacheGeneration(ORIGIN, onChange, fetchFn);
    expect(onChange).toHaveBeenCalledTimes(1);
    await readBazelCacheGeneration(ORIGIN, onChange, ok(pointer('2026w46')));
    expect(onChange).toHaveBeenLastCalledWith('2026w46');
    expect(currentBazelCacheGeneration()).toBe('2026w46');
  });

  it.each([
    ['a 403', status(403)],
    ['a 404', status(404)],
    ['bad JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })],
    ['a bad generation name', ok(pointer('2026w45; rm -rf'))],
    ['a network error', async () => { throw new Error('ECONNREFUSED'); }],
    ['a timeout', async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }],
  ])('keeps the last good value on %s', async (_what, bad) => {
    await readBazelCacheGeneration(ORIGIN, () => {}, ok(pointer('2026w45')));
    const onChange = vi.fn();
    expect(await readBazelCacheGeneration(ORIGIN, onChange, bad as never)).toBe('2026w45');
    expect(currentBazelCacheGeneration()).toBe('2026w45');
    expect(onChange).not.toHaveBeenCalled();
    // The sweep's trace is marked failed, so error-based retention keeps it.
    expect(spans.failRoot).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('current-generation read failed') }));
  });

  it('marks no trace failed on a good read', async () => {
    spans.failRoot.mockClear();
    await readBazelCacheGeneration(ORIGIN, () => {}, ok(pointer('2026w45')));
    expect(spans.failRoot).not.toHaveBeenCalled();
  });

  it('holds none when no read has ever succeeded', async () => {
    expect(await readBazelCacheGeneration(ORIGIN, () => {}, status(503) as never)).toBeNull();
  });

  it('gives up on a read after 5 seconds', async () => {
    let signal: AbortSignal | undefined;
    await readBazelCacheGeneration(ORIGIN, () => {}, (async (_u: string, init: { signal: AbortSignal }) => { signal = init.signal; return ok(pointer('2026w45'))(); }) as never);
    expect(signal).toBeDefined();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await readBazelCacheGeneration(ORIGIN, () => {}, ok(pointer('2026w45')));
    expect(timeout).toHaveBeenCalledWith(5_000);
  });
});

describe('startBazelCacheGenerationReader', () => {
  it('reads at start and every 5 minutes, until stopped', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(ok(pointer('2026w45')));
    const stop = startBazelCacheGenerationReader(ORIGIN, () => {}, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GENERATION_POLL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(GENERATION_POLL_MS).toBe(300_000);
    stop();
    await vi.advanceTimersByTimeAsync(GENERATION_POLL_MS * 2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
