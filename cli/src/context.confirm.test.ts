import { describe, expect, it, vi } from 'vitest';

// The terminal prompt itself, over a stand-in readline: one outcome, and nothing left listening.
const fake = vi.hoisted(() => ({
  rl: null as null | {
    listeners: Map<string, () => void>;
    closed: boolean;
    answer: (a: string) => void;
    ask: Promise<string>;
  },
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => {
    let answer!: (a: string) => void;
    const ask = new Promise<string>((resolve) => { answer = resolve; });
    const rl = {
      listeners: new Map<string, () => void>(),
      closed: false,
      answer,
      ask,
      on(ev: string, fn: () => void) { this.listeners.set(ev, fn); return this; },
      off(ev: string) { this.listeners.delete(ev); return this; },
      question: () => ask,
      close() { this.closed = true; },
    };
    fake.rl = rl;
    return rl;
  },
}));

const { defaultCtx } = await import('./context.js');

describe('the terminal prompt', () => {
  it('answers yes or no, then lets go of the terminal', async () => {
    const asked = defaultCtx().confirm!('Go? ');
    fake.rl!.answer('y');
    expect(await asked).toBe(true);
    expect(fake.rl!.closed).toBe(true);
    expect(fake.rl!.listeners.size).toBe(0);
  });

  it('with a signal, answers null on Ctrl-C at the prompt, and on the signal, removing its listeners', async () => {
    const ac = new AbortController();
    const asked = defaultCtx().confirm!('Go? ', { signal: ac.signal });
    fake.rl!.listeners.get('SIGINT')!();
    expect(await asked).toBeNull();
    expect(fake.rl!.listeners.size).toBe(0);

    const again = defaultCtx().confirm!('Go? ', { signal: ac.signal });
    ac.abort();
    expect(await again).toBeNull();
    expect(fake.rl!.closed).toBe(true);
  });

  it('without a signal, still ends the command on Ctrl-C with a real SIGINT', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      void defaultCtx().confirm!('Go? ');
      fake.rl!.listeners.get('SIGINT')!();
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
      expect(fake.rl!.closed).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});
