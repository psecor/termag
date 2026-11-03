import { describe, it, expect } from 'vitest';
import { initialPaneHistory, loadEarlierStart, loadEarlierDone, loadEarlierFail } from './paneHistory';

const chunk = (content: string, startByte: number) =>
  ({ session: 's', content, startByte, endByte: startByte + content.length, totalBytes: 100000 });

describe('loadEarlier state transitions', () => {
  it('marks loading, and a second start while loading is a no-op', () => {
    const started = loadEarlierStart(initialPaneHistory);
    expect(started.loading).toBe(true);
    expect(loadEarlierStart(started)).toBe(started);
  });

  it('a start past exhaustion does nothing', () => {
    const done = loadEarlierDone(initialPaneHistory, chunk('x', 0));
    expect(done.exhausted).toBe(true);
    expect(loadEarlierStart(done)).toBe(done);
  });

  it('prepends chunks oldest-first and records the next page offset', () => {
    // Paging goes backward: the first chunk is the newest (largest offset).
    let s = loadEarlierStart(initialPaneHistory);
    s = loadEarlierDone(s, chunk('newer\n', 500));
    s = loadEarlierStart(s);
    s = loadEarlierDone(s, chunk('older\n', 100));
    expect(s.chunks.map(c => c.text)).toEqual(['older\n', 'newer\n']);
    expect(s.before).toBe(100);
    expect(s.exhausted).toBe(false);
    expect(s.loading).toBe(false);
  });

  it('is exhausted when the log\'s beginning is reached, even mid-chunk', () => {
    const s = loadEarlierDone(loadEarlierStart(initialPaneHistory), chunk('first page\n', 0));
    expect(s.exhausted).toBe(true);
  });

  it('an empty page (a line longer than the cap) is not exhaustion', () => {
    const s = loadEarlierDone(loadEarlierStart(initialPaneHistory), chunk('', 4000));
    expect(s.exhausted).toBe(false);
    expect(s.before).toBe(4000);
  });

  it('strips ANSI escapes from chunk text', () => {
    const s = loadEarlierDone(loadEarlierStart(initialPaneHistory), chunk('\x1b[2mghost\x1b[22m plain\x1b]0;title\x07 tail', 500));
    expect(s.chunks[0].text).toBe('ghost plain tail');
  });

  it('a 404 or 501 gives up quietly; other failures keep the button with an error', () => {
    for (const status of [404, 501]) {
      const s = loadEarlierFail(loadEarlierStart(initialPaneHistory), status);
      expect(s.exhausted).toBe(true);
      expect(s.error).toBeNull();
      expect(s.loading).toBe(false);
    }
    const failed = loadEarlierFail(loadEarlierStart(initialPaneHistory), 503);
    expect(failed.exhausted).toBe(false);
    expect(failed.error).toBe('failed');
  });
});
