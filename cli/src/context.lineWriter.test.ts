import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { lineWriter } from './context.js';

/** Just enough of a stdout: what was written, and an `error` event to emit. */
function fakeStream() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const stream = {
    write: (chunk: string) => { written.push(chunk); return true; },
    on: (event: string, listener: (...a: unknown[]) => void) => { emitter.on(event, listener); return stream; },
  };
  const fail = (code: string) => emitter.emit('error', Object.assign(new Error(`write ${code}`), { code }));
  return { stream: stream as unknown as Parameters<typeof lineWriter>[0], written, fail, listeners: () => emitter.listenerCount('error') };
}

describe('lineWriter', () => {
  it('writes each text as a line', () => {
    const f = fakeStream();
    const out = lineWriter(f.stream);
    out('one');
    out('two\n');
    expect(f.written).toEqual(['one\n', 'two\n']);
  });

  it('stops writing, without throwing, once the reader has gone (EPIPE)', () => {
    const f = fakeStream();
    const out = lineWriter(f.stream);
    out('first');
    expect(() => f.fail('EPIPE')).not.toThrow();
    out('second');
    expect(f.written).toEqual(['first\n']);
  });

  it('throws any other stream error, as an unhandled one did', () => {
    const f = fakeStream();
    lineWriter(f.stream);
    expect(f.listeners()).toBe(1);
    expect(() => f.fail('EIO')).toThrow('write EIO');
  });
});
