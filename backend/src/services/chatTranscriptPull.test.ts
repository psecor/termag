import { describe, expect, it } from 'vitest';
import { coalescePulls, forEachBounded, MAX_READS, parseTranscriptRead, pullTranscript, type PullDeps } from './chatTranscriptPull';
import type { TranscriptHead } from './chatTranscriptStore';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

/**
 * A box whose session file is `files[session]` (the last one is current),
 * read `window` bytes of whole lines at a time, and a store that keeps bytes
 * per session with the real offset rule.
 */
function harness(files: Record<string, string>, window = 1000, store: Record<string, string> = {}, live: string | null = null) {
  const current = Object.keys(files).at(-1)!;
  let liveSession = live;
  const reads: Array<[string | null, number]> = [];
  const deps: PullDeps = {
    head: async (): Promise<TranscriptHead | null> => (liveSession ? { sessionId: liveSession, rawBytes: Buffer.byteLength(store[liveSession] ?? ''), rawCapped: false } : null),
    read: async (sessionId, from) => {
      reads.push([sessionId, from]);
      const file = Buffer.from(files[current]);
      const start = sessionId === current ? from : 0;
      if (start > file.length) return { sessionId: current, from: start, size: file.length, data: '', shrunk: true };
      const slice = file.subarray(start, start + window);
      const cut = slice.lastIndexOf(0x0a);
      return { sessionId: current, from: start, size: file.length, data: (cut >= 0 ? slice.subarray(0, cut + 1) : Buffer.alloc(0)).toString('base64') };
    },
    append: async ({ sessionId, byteStart }, data) => {
      const have = Buffer.byteLength(store[sessionId] ?? '');
      if (have !== byteStart) return { ok: false, expected: have };
      store[sessionId] = (store[sessionId] ?? '') + data.toString('utf8');
      liveSession = sessionId;
      return { ok: true, rawBytes: have + data.length };
    },
    reset: async sessionId => { store[sessionId] = ''; },
  };
  return { deps, store, reads };
}

describe('pullTranscript', () => {
  it('backfills a session from 0, window by window, without a line still being written', async () => {
    const h = harness({ [S1]: 'one\ntwo\nthree\npart' }, 9);
    expect(await pullTranscript(h.deps)).toBe(14);
    expect(h.store[S1]).toBe('one\ntwo\nthree\n');
    expect(h.reads).toEqual([[null, 0], [S1, 8], [S1, 14]]);
  });

  it('continues from what is stored', async () => {
    const h = harness({ [S1]: 'one\ntwo\n' }, 1000, { [S1]: 'one\n' }, S1);
    expect(await pullTranscript(h.deps)).toBe(4);
    expect(h.store[S1]).toBe('one\ntwo\n');
    expect(h.reads).toEqual([[S1, 4]]);
  });

  it('stores nothing when the box has nothing new', async () => {
    const h = harness({ [S1]: 'one\n' }, 1000, { [S1]: 'one\n' }, S1);
    expect(await pullTranscript(h.deps)).toBe(0);
    expect(h.reads).toEqual([[S1, 4]]);
  });

  it('a cleared chat\'s new session is stored from 0 and the old one kept', async () => {
    const h = harness({ [S1]: 'old\n', [S2]: 'new\n' }, 1000, { [S1]: 'old\n' }, S1);
    await pullTranscript(h.deps);
    expect(h.store).toEqual({ [S1]: 'old\n', [S2]: 'new\n' });
  });

  it('a file that shrank is stored again from 0', async () => {
    const h = harness({ [S1]: 'a\n' }, 1000, { [S1]: 'a\nb\nc\n' }, S1);
    await pullTranscript(h.deps);
    expect(h.store[S1]).toBe('a\n');
  });

  it('keeps what is stored when the box cannot find the session file', async () => {
    const h = harness({ [S1]: 'a\n' }, 1000, { [S1]: 'a\nb\nc\n' }, S1);
    h.deps.read = async (_sessionId, from) => ({ sessionId: S1, from, size: 0, data: '', missing: true });
    expect(await pullTranscript(h.deps)).toBe(0);
    expect(h.store[S1]).toBe('a\nb\nc\n');
  });

  it('follows the store\'s offset when another pull moved it', async () => {
    const h = harness({ [S1]: 'one\ntwo\n' }, 1000, { [S1]: 'one\n' }, S1);
    const head = h.deps.head;
    h.deps.head = async () => ({ ...(await head())!, rawBytes: 0 });
    await pullTranscript(h.deps);
    expect(h.store[S1]).toBe('one\ntwo\n');
    expect(h.reads).toEqual([[S1, 0], [S1, 4]]);
  });

  it('a box with no session stores nothing', async () => {
    const deps: PullDeps = {
      head: async () => null, read: async () => ({ sessionId: null }),
      append: async () => { throw new Error('no'); }, reset: async () => { throw new Error('no'); },
    };
    expect(await pullTranscript(deps)).toBe(0);
  });

  it('steps past a line the box skipped, storing a placeholder for it, and reads on', async () => {
    const big = 'x'.repeat(40);
    const file = `one\n${big}\ntwo\n`;
    const appended: Array<[number, string, number | undefined]> = [];
    const deps: PullDeps = {
      head: async () => null,
      read: async (_sessionId, from) => {
        if (from === 4) return { sessionId: S1, from, size: file.length, data: '', skipped: big.length + 1 };
        const slice = Buffer.from(file).subarray(from);
        return { sessionId: S1, from, size: file.length, data: slice.subarray(0, slice.indexOf(0x0a) + 1).toString('base64') };
      },
      append: async ({ byteStart }, data, skipped) => {
        appended.push([byteStart, data.toString(), skipped]);
        return { ok: true, rawBytes: byteStart + (skipped || data.length) };
      },
      reset: async () => { throw new Error('no'); },
    };
    expect(await pullTranscript(deps)).toBe(8);
    expect(appended).toEqual([[0, 'one\n', undefined], [4, '', big.length + 1], [4 + big.length + 1, 'two\n', undefined]]);
  });

  it('stops after MAX_READS and throws on an answer it cannot read', async () => {
    const h = harness({ [S1]: 'x\n'.repeat(MAX_READS + 5) }, 2);
    expect(await pullTranscript(h.deps)).toBe(MAX_READS * 2);
    h.deps.read = async () => ({ sessionId: S1 });
    await expect(pullTranscript(h.deps)).rejects.toThrow(/unreadable/);
  });
});

describe('parseTranscriptRead', () => {
  it('reads an answer and refuses anything else', () => {
    expect(parseTranscriptRead({ sessionId: S1, from: 2, size: 9, data: Buffer.from('ab\n').toString('base64') })).toEqual({
      sessionId: S1, from: 2, size: 9, data: Buffer.from('ab\n'), shrunk: false, missing: false, skipped: 0,
    });
    expect(parseTranscriptRead({ sessionId: S1, from: 2, size: 0, data: '', missing: true })?.missing).toBe(true);
    expect(parseTranscriptRead({ sessionId: S1, from: 2, size: 99, data: '', skipped: 60 })?.skipped).toBe(60);
    expect(parseTranscriptRead({ sessionId: S1, from: 2, size: 99, data: '', skipped: -1 })?.skipped).toBe(0);
    expect(parseTranscriptRead({ sessionId: null })?.sessionId).toBeNull();
    expect(parseTranscriptRead({ sessionId: S1, from: -1, size: 0, data: '' })).toBeNull();
    expect(parseTranscriptRead({ sessionId: S1, from: 0, size: 0 })).toBeNull();
    expect(parseTranscriptRead('nope')).toBeNull();
  });
});

describe('coalescePulls', () => {
  it('runs a pull asked for during one that then fails', async () => {
    const running = new Map<string, { again: boolean }>();
    const errors: unknown[] = [];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const first = coalescePulls(running, 'k', async () => {
      calls++;
      if (calls === 1) { await gate; throw new Error('box gone'); }
      return true;
    }, err => errors.push(err));
    await coalescePulls(running, 'k', async () => { throw new Error('never runs'); }, err => errors.push(err));
    release();
    await first;
    expect(calls).toBe(2);
    expect(errors.map(e => (e as Error).message)).toEqual(['box gone']);
    expect(running.size).toBe(0);
  });

  it('stops when the pull returns false', async () => {
    const running = new Map<string, { again: boolean }>();
    let calls = 0;
    await coalescePulls(running, 'k', async () => { calls++; running.get('k')!.again = true; return false; }, () => {});
    expect(calls).toBe(1);
  });
});

describe('forEachBounded', () => {
  it('runs every item, never more than the limit at once', async () => {
    let live = 0, most = 0;
    const done: number[] = [];
    await forEachBounded([1, 2, 3, 4, 5], 2, async n => {
      most = Math.max(most, ++live);
      await new Promise(r => setTimeout(r, 6 - n));
      live--;
      done.push(n);
    });
    expect(most).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
