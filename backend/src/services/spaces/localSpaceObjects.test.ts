import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSpaceObjects, StorageError } from './localSpaceObjects';
import { preconditionFailed as isPreconditionFailed } from './spaceFileOps';
import type { PutCondition } from './spaceMemory';

let root: string;
let objects: LocalSpaceObjects;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'local-spaces-'));
  objects = new LocalSpaceObjects({ root, baseUrl: 'https://termag.test/termag/api/space-storage/', secret: 'test-secret' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tokenOf(url: string): string {
  return url.slice('https://termag.test/termag/api/space-storage/'.length);
}

/** What a client's PUT of a presigned URL does. */
async function put(key: string, body: string | Buffer, condition: PutCondition | null = null, contentType = 'text/plain', proof: string | null = null) {
  const bytes = Buffer.from(body);
  const signed = await objects.presignPut(key, bytes.length, contentType, condition, proof);
  const grant = objects.grantOf(tokenOf(signed.url));
  if (grant?.op !== 'put') throw new Error('not a put grant');
  return objects.receivePut(grant, Readable.from([bytes]));
}

async function multipart(key: string, chunks: string[], condition: PutCondition | null = null) {
  const uploadId = await objects.createMultipart(key, 'application/zip');
  const urls = await objects.presignParts(key, uploadId, chunks.map((c, i) => ({ partNumber: i + 1, size: Buffer.byteLength(c) })));
  const parts = [];
  for (const [i, u] of urls.entries()) {
    const grant = objects.grantOf(tokenOf(u.url));
    if (grant?.op !== 'part') throw new Error('not a part grant');
    parts.push({ partNumber: u.partNumber, etag: (await objects.receivePart(grant, Readable.from([Buffer.from(chunks[i])]))).etag });
  }
  return { uploadId, parts, complete: () => objects.completeMultipart(key, uploadId, parts, condition) };
}

async function text(key: string): Promise<string | null> {
  return (await objects.read(key, 1 << 20))?.toString('utf8') ?? null;
}

describe('LocalSpaceObjects', () => {
  it('writes, heads and reads a version', async () => {
    const { etag, versionId } = await put('sp1/notes/a.txt', 'hello');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const head = await objects.head('sp1/notes/a.txt');
    expect(head).toMatchObject({ size: 5, contentType: 'text/plain', etag, versionId });
    expect(await text('sp1/notes/a.txt')).toBe('hello');
    expect((await objects.read('sp1/notes/a.txt', 2))!.toString()).toBe('hel');
    expect(await objects.head('sp1/notes/b.txt')).toBeNull();
    expect(await objects.read('sp1/notes/b.txt', 10)).toBeNull();
  });

  it('reads an empty object as empty', async () => {
    await put('sp1/empty', '');
    expect(await objects.read('sp1/empty', 10)).toEqual(Buffer.alloc(0));
  });

  it('gives each version its own ETag, even for the same bytes', async () => {
    const a = await put('sp1/a', 'same');
    const b = await put('sp1/a', 'same');
    expect(a.etag).not.toBe(b.etag);
    expect((await objects.versionsOf('sp1/a')).map(v => v.etag)).toEqual([b.etag, a.etag]);
  });

  it('refuses a body that is not the signed size, and keeps nothing', async () => {
    const signed = await objects.presignPut('sp1/a', 3, 'text/plain');
    const grant = objects.grantOf(tokenOf(signed.url));
    if (grant?.op !== 'put') throw new Error('not a put grant');
    await expect(objects.receivePut(grant, Readable.from([Buffer.from('toolong')]))).rejects.toMatchObject({ code: 'IncompleteBody' });
    await expect(objects.receivePut(grant, Readable.from([Buffer.from('ab')]))).rejects.toMatchObject({ code: 'IncompleteBody' });
    expect(await objects.head('sp1/a')).toBeNull();
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  describe('conditions', () => {
    it('ifNoneMatch * writes only a new file', async () => {
      await put('sp1/a', 'one', { ifNoneMatch: '*' });
      const err = await put('sp1/a', 'two', { ifNoneMatch: '*' }).catch(e => e);
      expect(isPreconditionFailed(err)).toBe(true);
      expect(await text('sp1/a')).toBe('one');
    });

    it('ifMatch writes only over that version', async () => {
      const first = await put('sp1/a', 'one');
      const second = await put('sp1/a', 'two', { ifMatch: first.etag });
      const err = await put('sp1/a', 'three', { ifMatch: first.etag }).catch(e => e);
      expect(err).toBeInstanceOf(StorageError);
      expect(err.$metadata.httpStatusCode).toBe(412);
      expect((await objects.head('sp1/a'))!.etag).toBe(second.etag);
      // An unquoted ETag matches as S3's If-Match does.
      await put('sp1/a', 'four', { ifMatch: second.etag.replace(/"/g, '') });
      expect(await text('sp1/a')).toBe('four');
    });

    it('lets one of two racing conditional writes win', async () => {
      const base = await put('sp1/a', 'base');
      const results = await Promise.allSettled([1, 2, 3, 4].map(n => put('sp1/a', `w${n}`, { ifMatch: base.etag })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected').every(r => isPreconditionFailed((r as PromiseRejectedResult).reason))).toBe(true);
    });
  });

  it('keeps the upload proof on its version', async () => {
    const { versionId } = await put('sp1/a', 'x', null, 'text/plain', 'proof-1');
    expect(await objects.uploadProofOf('sp1/a', versionId)).toBe('proof-1');
    const plain = await put('sp1/a', 'y');
    expect(await objects.uploadProofOf('sp1/a', plain.versionId)).toBeNull();
  });

  describe('list', () => {
    beforeEach(async () => {
      for (const k of ['sp1/b.txt', 'sp1/a.txt', 'sp1/dir/x', 'sp1/dir/sub/y', 'sp1/a', 'sp1/a/inner', 'sp2/other']) await put(k, k);
    });

    it('lists one level with folders as prefixes', async () => {
      const out = await objects.list('sp1/');
      expect(out.prefixes).toEqual(['sp1/a/', 'sp1/dir/']);
      expect(out.files.map(f => f.key)).toEqual(['sp1/a', 'sp1/a.txt', 'sp1/b.txt']);
      expect(out.files[0]).toMatchObject({ size: 5, etag: expect.stringMatching(/^"/) });
      expect(out.nextCursor).toBeNull();
    });

    it('lists everything under a prefix without the delimiter', async () => {
      const out = await objects.list('sp1/dir/', { delimiter: false });
      expect(out.prefixes).toEqual([]);
      expect(out.files.map(f => f.key)).toEqual(['sp1/dir/sub/y', 'sp1/dir/x']);
    });

    it('matches a prefix that ends mid-name', async () => {
      expect((await objects.list('sp1/a')).files.map(f => f.key)).toEqual(['sp1/a', 'sp1/a.txt']);
      expect((await objects.list('sp1/a')).prefixes).toEqual(['sp1/a/']);
    });

    it('pages with a cursor', async () => {
      const first = await objects.list('sp1/', { max: 2 });
      expect([...first.files.map(f => f.key), ...first.prefixes]).toEqual(['sp1/a', 'sp1/a.txt']);
      const second = await objects.list('sp1/', { max: 2, cursor: first.nextCursor });
      expect([...second.files.map(f => f.key), ...second.prefixes].sort()).toEqual(['sp1/a/', 'sp1/b.txt']);
      const third = await objects.list('sp1/', { max: 2, cursor: second.nextCursor });
      expect(third.prefixes).toEqual(['sp1/dir/']);
      expect(third.nextCursor).toBeNull();
    });

    it('leaves out deleted files and folders with nothing left', async () => {
      await objects.deleteKeys(['sp1/dir/x', 'sp1/dir/sub/y', 'sp1/b.txt']);
      const out = await objects.list('sp1/');
      expect(out.prefixes).toEqual(['sp1/a/']);
      expect(out.files.map(f => f.key)).toEqual(['sp1/a', 'sp1/a.txt']);
      expect(await objects.list('nothing/here/')).toEqual({ prefixes: [], files: [], nextCursor: null });
    });
  });

  it('stores a segment too long for a filename', async () => {
    const long = 'n'.repeat(240);
    await put(`sp1/${long}/${long}.txt`, 'deep');
    expect(await text(`sp1/${long}/${long}.txt`)).toBe('deep');
    expect((await objects.list('sp1/')).prefixes).toEqual([`sp1/${long}/`]);
    expect((await objects.list(`sp1/${long}/`)).files.map(f => f.key)).toEqual([`sp1/${long}/${long}.txt`]);
  });

  it('keeps names that look like paths inside their own folder', async () => {
    await put('sp1/..', 'dots');
    await put('sp1/.hidden', 'h');
    expect((await objects.list('sp1/')).files.map(f => f.key)).toEqual(['sp1/..', 'sp1/.hidden']);
    await expect(objects.head('sp1//a')).rejects.toMatchObject({ code: 'InvalidArgument' });
  });

  it('deletes with a marker, keeping the versions', async () => {
    const v = await put('sp1/a', 'one');
    expect(await objects.deleteKeys(['sp1/a', 'sp1/never'])).toEqual([]);
    expect(await objects.head('sp1/a')).toBeNull();
    const versions = await objects.versionsOf('sp1/a');
    expect(versions.map(x => [x.deleteMarker, x.etag])).toEqual([[true, null], [false, v.etag]]);
    expect(await objects.versionsOf('sp1/never')).toEqual([]);
  });

  it('restores an older version as a new one', async () => {
    const one = await put('sp1/a', 'one');
    const two = await put('sp1/a', 'two');
    const err = await objects.restoreVersion('sp1/a', one.versionId, one.etag).catch(e => e);
    expect(isPreconditionFailed(err)).toBe(true);
    const { etag } = await objects.restoreVersion('sp1/a', one.versionId, two.etag);
    expect(await text('sp1/a')).toBe('one');
    expect(etag).not.toBe(one.etag);
    expect(await objects.versionsOf('sp1/a')).toHaveLength(3);
    await expect(objects.restoreVersion('sp1/a', 'nope')).rejects.toMatchObject({ name: 'NoSuchVersion' });
  });

  it('restores past a delete marker', async () => {
    const one = await put('sp1/a', 'one');
    await objects.deleteKeys(['sp1/a']);
    await objects.restoreVersion('sp1/a', one.versionId);
    expect(await text('sp1/a')).toBe('one');
  });

  it('copies with the source condition, type and metadata', async () => {
    const src = await put('sp1/a', 'data', null, 'text/csv', 'p');
    await expect(objects.copy('sp1/a', 'sp1/b', { sourceIfMatch: '"0000"' })).rejects.toMatchObject({ name: 'PreconditionFailed' });
    await objects.copy('sp1/a', 'sp1/b', { sourceIfMatch: src.etag });
    const head = await objects.head('sp1/b');
    expect(head).toMatchObject({ size: 4, contentType: 'text/csv' });
    expect(await text('sp1/b')).toBe('data');
    expect(await objects.uploadProofOf('sp1/b', head!.versionId!)).toBe('p');
    await expect(objects.copy('sp1/missing', 'sp1/c')).rejects.toMatchObject({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  });

  describe('multipart', () => {
    it('assembles the parts in order', async () => {
      const up = await multipart('sp1/big.zip', ['aaa', 'bb', 'c']);
      const { etag } = await up.complete();
      expect(etag).toMatch(/^"[0-9a-f]{32}-3"$/);
      expect(await text('sp1/big.zip')).toBe('aaabbc');
      expect(await objects.head('sp1/big.zip')).toMatchObject({ size: 6, contentType: 'application/zip', etag });
      expect(readdirSync(join(root, 'uploads'))).toEqual([]);
    });

    it('refuses a part whose ETag does not match', async () => {
      const up = await multipart('sp1/big.zip', ['aaa', 'bb']);
      await expect(objects.completeMultipart('sp1/big.zip', up.uploadId, [up.parts[0], { partNumber: 2, etag: '"ffff"' }]))
        .rejects.toMatchObject({ name: 'InvalidPart' });
      await expect(objects.completeMultipart('sp1/big.zip', up.uploadId, [up.parts[1], up.parts[0]]))
        .rejects.toMatchObject({ name: 'InvalidPartOrder' });
    });

    it('checks the condition when it completes', async () => {
      await put('sp1/big.zip', 'old');
      const up = await multipart('sp1/big.zip', ['new'], { ifNoneMatch: '*' });
      expect(isPreconditionFailed(await up.complete().catch(e => e))).toBe(true);
      expect(await text('sp1/big.zip')).toBe('old');
    });

    it('aborts, and refuses an upload of another key', async () => {
      const up = await multipart('sp1/big.zip', ['a']);
      await expect(objects.completeMultipart('sp1/other.zip', up.uploadId, up.parts)).rejects.toMatchObject({ name: 'NoSuchUpload' });
      await objects.abortMultipart('sp1/big.zip', up.uploadId);
      await expect(up.complete()).rejects.toMatchObject({ name: 'NoSuchUpload' });
      await expect(objects.completeMultipart('sp1/big.zip', '../escape', [])).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('sweeps old uploads and reports the open ones with their parts', async () => {
      const old = await multipart('sp1/old.zip', ['aa']);
      const later = new Date(Date.now() + 60_000);
      const fresh = await multipart('sp1/new.zip', ['bbb', 'cc']);
      await multipart('sp2/elsewhere.zip', ['x']);
      // Everything started before `later` is old; nothing started before the epoch.
      expect(await objects.sweepMultipart('sp1/', new Date(0))).toEqual({
        aborted: 0,
        inProgress: expect.arrayContaining([
          { key: 'sp1/old.zip', uploadId: old.uploadId, parts: [{ partNumber: 1, bytes: 2n }] },
          { key: 'sp1/new.zip', uploadId: fresh.uploadId, parts: [{ partNumber: 1, bytes: 3n }, { partNumber: 2, bytes: 2n }] },
        ]),
      });
      expect((await objects.sweepMultipart('sp1/', later)).aborted).toBe(2);
      expect((await objects.sweepMultipart('sp2/', new Date(0))).inProgress).toHaveLength(1);
    });
  });

  it('sums every version under a prefix, delete markers aside', async () => {
    await put('sp1/a', '12345');
    await put('sp1/a', '12');
    await put('sp1/dir/b', '123');
    await objects.deleteKeys(['sp1/dir/b']);
    await put('sp2/c', '1234567');
    const { total, watched } = await objects.sumVersions('sp1/', new Set(['sp1/a']));
    expect(total).toBe(10n);
    expect(watched.map(w => w.size).sort()).toEqual([2n, 5n]);
  });

  it('purges every version under a prefix and the folders left empty', async () => {
    await put('sp1/a', '1');
    await put('sp1/a', '2');
    await put('sp1/dir/sub/b', '3');
    await objects.deleteKeys(['sp1/dir/sub/b']);
    await put('sp2/c', '4');
    expect(await objects.purgePrefix('sp1/')).toBe(4);
    expect(await objects.versionsOf('sp1/a')).toEqual([]);
    expect(readdirSync(join(root, 'objects'))).toEqual(['d.sp2']);
    expect(await text('sp2/c')).toBe('4');
  });

  it('signs URLs that carry the grant and expire', async () => {
    let now = 1_000_000;
    const timed = new LocalSpaceObjects({ root, baseUrl: 'https://termag.test/termag/api/space-storage', secret: 's', now: () => now });
    const { url } = await timed.presignGet('sp1/a', { contentDisposition: 'attachment' }, 60);
    expect(timed.grantOf(tokenOf(url))).toMatchObject({ op: 'get', key: 'sp1/a', disposition: 'attachment' });
    expect(objects.grantOf(tokenOf(url))).toBeNull();
    now += 61_000;
    expect(timed.grantOf(tokenOf(url))).toBeNull();
  });
});
