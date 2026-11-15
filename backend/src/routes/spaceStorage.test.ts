import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import http from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSpaceObjects } from '../services/spaces/localSpaceObjects';
import { safeInline, spaceStorageRouter } from './spaceStorage';

let root: string;
let server: Server;
let objects: LocalSpaceObjects;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'space-storage-'));
  const app = express();
  // As index.ts mounts it: ahead of the JSON parser, which must never see an upload.
  app.use('/termag/api/space-storage', (req, res, next) => spaceStorageRouter(objects)(req, res, next));
  app.use(express.json());
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/api/space-storage`;
  objects = new LocalSpaceObjects({ root, baseUrl: base, secret: 'test-secret' });
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

async function putSigned(key: string, body: string, contentType = 'text/plain', condition: { ifMatch?: string; ifNoneMatch?: '*' } | null = null) {
  const signed = await objects.presignPut(key, Buffer.byteLength(body), contentType, condition);
  return fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
}

async function getUrl(key: string, response: { contentDisposition: string; contentType?: string } = { contentDisposition: 'attachment; filename="f"' }) {
  return (await objects.presignGet(key, response)).url;
}

describe('space storage route', () => {
  it('stores a signed PUT and answers its ETag', async () => {
    const res = await putSigned('sp1/data.json', '{"a":1}', 'application/json');
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await objects.head('sp1/data.json')).toMatchObject({ size: 7, contentType: 'application/json', etag });
    expect((await objects.read('sp1/data.json', 100))!.toString()).toBe('{"a":1}');
  });

  it('answers a failed condition with S3\'s 412', async () => {
    await putSigned('sp1/a', 'one');
    const res = await putSigned('sp1/a', 'two', 'text/plain', { ifNoneMatch: '*' });
    expect(res.status).toBe(412);
    expect(await res.text()).toContain('<Code>PreconditionFailed</Code>');
  });

  it('refuses a tampered, expired or download token for a PUT', async () => {
    const signed = await objects.presignPut('sp1/a', 3, 'text/plain');
    const tampered = signed.url.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
    expect((await fetch(tampered, { method: 'PUT', headers: signed.headers, body: 'abc' })).status).toBe(403);
    const get = await getUrl('sp1/a');
    const res = await fetch(get, { method: 'PUT', headers: signed.headers, body: 'abc' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('<Code>AccessDenied</Code>');
    const stale = new LocalSpaceObjects({ root, baseUrl: signed.url.slice(0, signed.url.lastIndexOf('/')), secret: 'test-secret', now: () => Date.now() - 3_600_000 });
    const old = await stale.presignPut('sp1/a', 3, 'text/plain');
    expect((await fetch(old.url, { method: 'PUT', headers: old.headers, body: 'abc' })).status).toBe(403);
    expect(await objects.head('sp1/a')).toBeNull();
  });

  it('refuses a body or type other than the signed one', async () => {
    const signed = await objects.presignPut('sp1/a', 3, 'text/plain');
    const wrongSize = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: 'abcd' });
    expect(wrongSize.status).toBe(403);
    expect(await wrongSize.text()).toContain('SignatureDoesNotMatch');
    const wrongType = await fetch(signed.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: 'abc' });
    expect(wrongType.status).toBe(403);
    expect(await objects.head('sp1/a')).toBeNull();
    expect((await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: 'abc' })).status).toBe(200);
  });

  it('takes multipart parts and answers each ETag', async () => {
    const uploadId = await objects.createMultipart('sp1/big.bin', 'application/octet-stream');
    const urls = await objects.presignParts('sp1/big.bin', uploadId, [{ partNumber: 1, size: 4 }, { partNumber: 2, size: 2 }]);
    const parts = [];
    for (const [i, body] of ['abcd', 'ef'].entries()) {
      const res = await fetch(urls[i].url, { method: 'PUT', body });
      expect(res.status).toBe(200);
      parts.push({ partNumber: urls[i].partNumber, etag: res.headers.get('etag')! });
    }
    await objects.completeMultipart('sp1/big.bin', uploadId, parts);
    const res = await fetch(await getUrl('sp1/big.bin'));
    expect(await res.text()).toBe('abcdef');
  });

  it('serves a signed GET with its headers, ranges and conditional requests', async () => {
    const put = await putSigned('sp1/movie.mp4', '0123456789', 'video/mp4');
    const etag = put.headers.get('etag')!;
    const url = await getUrl('sp1/movie.mp4', { contentDisposition: 'inline; filename="movie.mp4"', contentType: 'video/mp4' });

    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('0123456789');
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('content-disposition')).toBe('inline; filename="movie.mp4"');
    expect(full.headers.get('etag')).toBe(etag);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('content-security-policy')).toBeNull();

    const part = await fetch(url, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('2345');
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');

    // Not fetch: it sends Cache-Control: no-cache with a conditional header, which rules out a 304.
    const conditional = await new Promise<number>((resolve, reject) => {
      http.get(url, { headers: { 'if-none-match': etag } }, res => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
    });
    expect(conditional).toBe(304);
    expect((await fetch(url, { method: 'HEAD' })).headers.get('content-length')).toBe('10');
  });

  it('sandboxes anything that could run script in termag\'s origin', async () => {
    await putSigned('sp1/page.html', '<script>alert(1)</script>', 'text/html');
    const res = await fetch(await getUrl('sp1/page.html'));
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(safeInline('image/svg+xml')).toBe(false);
    expect(safeInline('text/plain; charset=utf-8')).toBe(false);
    expect(safeInline('application/pdf')).toBe(true);
    expect(safeInline('image/png')).toBe(true);
    expect(safeInline('audio/mpeg')).toBe(true);
  });

  it('answers 404 for a missing or deleted file and 403 for an upload token', async () => {
    const missing = await fetch(await getUrl('sp1/none'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<Code>NoSuchKey</Code>');
    await putSigned('sp1/a', 'x');
    const url = await getUrl('sp1/a');
    await objects.deleteKeys(['sp1/a']);
    expect((await fetch(url)).status).toBe(404);
    const signed = await objects.presignPut('sp1/a', 1, 'text/plain');
    expect((await fetch(signed.url)).status).toBe(403);
  });
});
