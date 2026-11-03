import { describe, expect, it } from 'vitest';
import { NOTIFY_PAYLOAD_MAX } from '../askReplyBus';
import { fileChangeOf, fileChangePayload, parseFileChange } from './spaceFileBus';

const ID = 'ckspace000000000000000001';

describe('the NOTIFY payload', () => {
  it('round-trips each kind', () => {
    for (const c of [
      { spaceId: ID, kind: 'put' as const, path: 'a/pr-outbox.md', etag: '"abc"' },
      { spaceId: ID, kind: 'mv' as const, path: 'd/', to: 'z/' },
      { spaceId: ID, kind: 'rm' as const, path: 'a.txt' },
    ]) expect(parseFileChange(fileChangePayload(c))).toEqual(c);
  });

  it('carries no contents: the space id, the kind, paths and a version only', () => {
    expect(JSON.parse(fileChangePayload({ spaceId: ID, kind: 'put', path: 'x.md', etag: '"e"' }))).toEqual({ s: ID, k: 'put', p: 'x.md', e: '"e"' });
  });

  it('fits a move of two of the longest paths, multibyte ones included', () => {
    const long = 'é'.repeat(495) + '.md'; // a key is at most 1024 bytes
    const p = fileChangePayload({ spaceId: ID, kind: 'mv', path: long, to: long + 'x' });
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(NOTIFY_PAYLOAD_MAX);
    expect(parseFileChange(p)?.to).toBe(long + 'x');
  });

  it('drops the paths, not the change, when they would not fit', () => {
    const huge = 'a'.repeat(5000);
    const p = fileChangePayload({ spaceId: ID, kind: 'mv', path: huge, to: huge });
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(NOTIFY_PAYLOAD_MAX);
    expect(parseFileChange(p)).toEqual({ spaceId: ID, kind: 'mv' });
  });

  it('refuses malformed payloads', () => {
    for (const p of ['', 'nope', '{}', '[]', JSON.stringify({ s: ID, k: 'get' }), JSON.stringify({ s: 3, k: 'put' })]) {
      expect(parseFileChange(p)).toBeNull();
    }
  });
});

describe('fileChangeOf', () => {
  it('maps the file events and ignores the rest', () => {
    expect(fileChangeOf(ID, 'file.put', 'a.md', '"v"')).toEqual({ spaceId: ID, kind: 'put', path: 'a.md', etag: '"v"' });
    expect(fileChangeOf(ID, 'file.mv', 'a b.md -> c - d.md', null)).toEqual({ spaceId: ID, kind: 'mv', path: 'a b.md', to: 'c - d.md' });
    expect(fileChangeOf(ID, 'file.rm', 'd/', null)).toEqual({ spaceId: ID, kind: 'rm', path: 'd/' });
    for (const a of ['file.get', 'file.put.signed', 'member.add', 'space.create']) expect(fileChangeOf(ID, a, 'a.md', null)).toBeNull();
  });
});
