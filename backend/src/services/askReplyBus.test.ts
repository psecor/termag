import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, NOTIFY_PAYLOAD_MAX, ReplyAssembler, ReplyHandoff, chunkReply } from './askReplyBus';

const ID = 'cmgx1abcd0000qwerty12345';

describe('chunkReply', () => {
  it('keeps every payload under the NOTIFY limit, multi-byte text included', () => {
    const text = '日本語'.repeat(20_000) + 'tail';
    const chunks = chunkReply(ID, text);
    expect(chunks.length).toBe(Math.ceil(Buffer.byteLength(text) / CHUNK_BYTES));
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(NOTIFY_PAYLOAD_MAX);
  });

  it('sends an empty reply as one chunk', () => {
    expect(chunkReply(ID, '')).toEqual([`${ID}:0:1:`]);
  });
});

describe('ReplyAssembler', () => {
  it('reassembles chunks in any order, splitting characters across chunks', () => {
    const text = 'é'.repeat(CHUNK_BYTES * 2) + '!';
    const chunks = chunkReply(ID, text);
    expect(chunks.length).toBeGreaterThan(2);
    const a = new ReplyAssembler();
    const shuffled = [...chunks].reverse();
    for (const c of shuffled.slice(0, -1)) expect(a.accept(c)).toBeNull();
    expect(a.accept(shuffled[shuffled.length - 1])).toEqual({ messageId: ID, text });
    expect(a.pending).toBe(0);
  });

  it('ignores a repeated chunk and junk payloads', () => {
    const [c0, c1] = chunkReply(ID, 'x'.repeat(CHUNK_BYTES + 1));
    const a = new ReplyAssembler();
    expect(a.accept(c0)).toBeNull();
    expect(a.accept(c0)).toBeNull();
    expect(a.accept('not a payload')).toBeNull();
    expect(a.accept(`${ID}:5:2:AAAA`)).toBeNull();
    expect(a.accept(c1)?.text).toBe('x'.repeat(CHUNK_BYTES + 1));
  });

  it('abandons a reply whose chunks stop arriving', () => {
    let t = 0;
    const a = new ReplyAssembler(() => t);
    const [c0, c1] = chunkReply(ID, 'y'.repeat(CHUNK_BYTES + 1));
    a.accept(c0);
    t = 31_000;
    expect(a.accept(c1)).toBeNull();
    expect(a.pending).toBe(1);
  });
});

describe('ReplyHandoff', () => {
  it('holds a reply for the window, then forgets it', () => {
    let t = 0;
    const h = new ReplyHandoff(60_000, () => t);
    h.put('m', 'hello');
    t = 30_000;
    h.put('m', 'again');
    expect(h.get('m')).toBe('hello');
    t = 60_000;
    expect(h.get('m')).toBeNull();
    expect(h.size).toBe(0);
  });
});
