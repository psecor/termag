import { describe, it, expect } from 'vitest';
import { singleFlight } from './runner';

describe('singleFlight', () => {
  it('runs one pass at a time and queues one follow-up for requests made during a pass', async () => {
    let calls = 0; let release: () => void = () => {};
    const r = singleFlight(() => { calls++; return new Promise<void>(res => { release = res; }); });
    r.run();
    expect(calls).toBe(1);
    r.run(); r.run(); // a refresh arrives mid-sweep, twice
    expect(calls).toBe(1);
    release(); await new Promise(res => setTimeout(res, 0));
    expect(calls).toBe(2); // exactly one follow-up
    release(); await r.idle();
    expect(calls).toBe(2);
  });
  it('keeps going after a failed pass', async () => {
    const errors: unknown[] = []; let calls = 0;
    const r = singleFlight(async () => { calls++; if (calls === 1) throw new Error('boom'); }, e => errors.push(e));
    r.run(); await r.idle(); r.run(); await r.idle();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });
});
