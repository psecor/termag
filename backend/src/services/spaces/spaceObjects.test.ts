import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { spaceResourceNames } from './spaceConfig';
import {
  copySource, MIN_SESSION_LEFT_MS, PART_TTL_S, presignerCredentials, presignerObjects, presignerSession, s3SpaceObjects,
  SOURCE_IDENTITY_RETRY_MS, SourceIdentityGate, spacesS3ClientConfig, sseHeaders, stsName, SWEEP_IDENTITY,
} from './spaceObjects';

const resources = spaceResourceNames('123456789012', 'us-east-2');

function objects() {
  const creds = async () => ({ accessKeyId: 'ASIATEST', secretAccessKey: 'secret', sessionToken: 'token' });
  return s3SpaceObjects(resources, { s3: new S3Client(spacesS3ClientConfig(resources, creds)) });
}

describe('presignPut', () => {
  it('signs the length, the type and the SSE-KMS headers, and returns what the client must send', async () => {
    const put = await objects().presignPut('sp/a.txt', 12, 'text/plain');
    const url = new URL(put.url);
    expect(url.host).toBe('termag-spaces-123456789012-us-east-2-an.s3.us-east-2.amazonaws.com');
    expect(url.pathname).toBe('/sp/a.txt');
    expect(url.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(expect.arrayContaining([
      'content-length', 'content-type', 'x-amz-server-side-encryption',
      'x-amz-server-side-encryption-aws-kms-key-id', 'x-amz-server-side-encryption-bucket-key-enabled',
    ]));
    expect(put.headers).toEqual({ 'content-type': 'text/plain', ...sseHeaders(resources.kmsKeyId) });
    expect(put.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe('arn:aws:kms:us-east-2:123456789012:alias/termag-spaces');
  });

  it('signs no checksum of the (empty) presign body', async () => {
    const put = await objects().presignPut('sp/a.txt', 12, 'text/plain');
    expect([...new URL(put.url).searchParams.keys()].filter(k => k.toLowerCase().includes('checksum'))).toEqual([]);
    const [part] = await objects().presignParts('sp/a.bin', 'U1', [{ partNumber: 3, size: 1024 }]);
    expect([...new URL(part.url).searchParams.keys()].filter(k => k.toLowerCase().includes('checksum'))).toEqual([]);
    expect(new URL(part.url).searchParams.get('partNumber')).toBe('3');
    expect(new URL(part.url).searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
  });

  it('signs downloads with the disposition and type the server chose', async () => {
    const get = await objects().presignGet('sp/cat.png', { contentDisposition: 'inline; filename="cat.png"', contentType: 'image/png' });
    const url = new URL(get.url);
    expect(url.searchParams.get('response-content-disposition')).toBe('inline; filename="cat.png"');
    expect(url.searchParams.get('response-content-type')).toBe('image/png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });
});

function fakeSts(opts: { expiresInMs?: number[]; denySourceIdentity?: () => boolean } = {}) {
  const expiresInMs = opts.expiresInMs ?? [3600_000];
  // Starts at the real clock: the SDK judges a cached session's expiry by Date.now().
  const start = Date.now();
  let t = start;
  let issued = 0;
  const send = vi.fn(async (cmd: { input: Record<string, unknown> }) => {
    if (cmd.input.SourceIdentity && opts.denySourceIdentity?.()) {
      throw Object.assign(new Error('not authorized to perform: sts:SetSourceIdentity'), { name: 'AccessDenied' });
    }
    issued++;
    return {
      Credentials: {
        AccessKeyId: `AK${issued}`, SecretAccessKey: 's', SessionToken: 't',
        Expiration: new Date(t + expiresInMs[Math.min(issued - 1, expiresInMs.length - 1)]),
      },
    };
  });
  const inputs = () => send.mock.calls.map(c => c[0].input);
  return { send, inputs, setNow: (offsetMs: number) => { t = start + offsetMs; }, now: () => t };
}

const aliceSession = presignerSession({ kind: 'user', userId: 'u1', email: 'alice@example.com' });

describe('presignerCredentials', () => {
  it('assumes the presigner role and reuses the session while it outlives every URL', async () => {
    const s = fakeSts();
    const creds = presignerCredentials(resources.roleArn, { session: aliceSession, sts: s as never, now: s.now });
    const a = await creds();
    s.setNow(3600_000 - MIN_SESSION_LEFT_MS - 1);
    expect(await creds()).toBe(a);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.inputs()[0]).toEqual({
      RoleArn: 'arn:aws:iam::123456789012:role/termag-spaces-presigner', DurationSeconds: 3600,
      RoleSessionName: 'user-alice@example.com', SourceIdentity: 'alice@example.com',
    });
  });

  it('renews before a part URL could outlive the session', async () => {
    const s = fakeSts({ expiresInMs: [3600_000, 7200_000] });
    const creds = presignerCredentials(resources.roleArn, { session: aliceSession, sts: s as never, now: s.now });
    await creds();
    s.setNow(3600_000 - PART_TTL_S * 1000);
    expect((await creds()).accessKeyId).toBe('AK2');
  });

  it('refuses a session too short for the longest URL', async () => {
    const s = fakeSts({ expiresInMs: [MIN_SESSION_LEFT_MS] });
    await expect(presignerCredentials(resources.roleArn, { session: aliceSession, sts: s as never, now: s.now })()).rejects.toThrow(/shorter than the longest URL/);
  });

  it('opts out of the SDK\'s own credential cache, so the renewal above is what signs', () => {
    expect(presignerCredentials(resources.roleArn, { session: aliceSession, sts: fakeSts() as never }).memoized).toBe(true);
  });

  it('falls back to no SourceIdentity on AccessDenied, for every session, and tries it again later', async () => {
    let deny = true;
    const s = fakeSts({ denySourceIdentity: () => deny });
    const gate = new SourceIdentityGate(SOURCE_IDENTITY_RETRY_MS);
    const bob = presignerSession({ kind: 'box', instanceId: 'i-1', name: 'bob-box', ownerUserId: 'u2', ownerEmail: 'bob@example.com' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await presignerCredentials(resources.roleArn, { session: aliceSession, sts: s as never, gate, now: s.now })();
    expect(s.inputs()).toEqual([
      expect.objectContaining({ RoleSessionName: 'user-alice@example.com', SourceIdentity: 'alice@example.com' }),
      expect.not.objectContaining({ SourceIdentity: expect.anything() }),
    ]);
    expect(s.inputs()[1].RoleSessionName).toBe('user-alice@example.com');

    await presignerCredentials(resources.roleArn, { session: bob, sts: s as never, gate, now: s.now })();
    expect(s.inputs()[2]).toEqual(expect.objectContaining({ RoleSessionName: 'box-bob-box' }));
    expect(s.inputs()[2].SourceIdentity).toBeUndefined();

    deny = false;
    s.setNow(SOURCE_IDENTITY_RETRY_MS);
    await presignerCredentials(resources.roleArn, { session: bob, sts: s as never, gate, now: s.now })();
    expect(s.inputs()[3]).toEqual(expect.objectContaining({ RoleSessionName: 'box-bob-box', SourceIdentity: 'bob@example.com' }));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    log.mockRestore();
  });

  it('does not retry other errors without SourceIdentity', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('throttled'), { name: 'Throttling' }); });
    await expect(presignerCredentials(resources.roleArn, { session: aliceSession, sts: { send } as never })()).rejects.toThrow('throttled');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('presignerSession', () => {
  it('names the session for what acts and SourceIdentity for the person', () => {
    expect(presignerSession({ kind: 'user', userId: 'u1', email: 'a.b+c@example.com' })).toMatchObject({ roleSessionName: 'user-a.b+c@example.com', sourceIdentity: 'a.b+c@example.com' });
    expect(presignerSession({ kind: 'box', instanceId: 'i-1', name: 'dev box', ownerUserId: 'u1', ownerEmail: 'a@example.com' })).toMatchObject({ roleSessionName: 'box-dev-box', sourceIdentity: 'a@example.com' });
    expect(presignerSession({ kind: 'box', instanceId: 'i-0abc', name: null, ownerUserId: 'u1', ownerEmail: null })).toMatchObject({ roleSessionName: 'box-i-0abc', sourceIdentity: 'u1' });
    expect(presignerSession(SWEEP_IDENTITY)).toMatchObject({ roleSessionName: 'system-sweep', sourceIdentity: null });
  });

  it('keys by identity, so two boxes with one name keep separate sessions', () => {
    const a = presignerSession({ kind: 'box', instanceId: 'i-1', name: 'dev', ownerUserId: 'u1', ownerEmail: 'a@example.com' });
    const b = presignerSession({ kind: 'box', instanceId: 'i-2', name: 'dev', ownerUserId: 'u2', ownerEmail: 'b@example.com' });
    expect(a.roleSessionName).toBe(b.roleSessionName);
    expect(a.key).not.toBe(b.key);
  });

  it('keeps names within STS rules', () => {
    for (const raw of ['', 'x', 'caf\u00e9 #1/2:3', 'aws:thing', 'a'.repeat(100), 'ok_+=,.@-']) {
      const n = stsName(raw);
      expect(n).toMatch(/^[\w+=,.@-]{2,64}$/);
    }
    expect(stsName('ok_+=,.@-')).toBe('ok_+=,.@-');
    expect(stsName('caf\u00e9:1')).toBe('caf--1');
  });
});

describe('presignerObjects', () => {
  it('keeps one session per identity, renewed on its own, and evicts the least recently used', async () => {
    const s = fakeSts();
    const built: string[] = [];
    const objectsFor = presignerObjects(resources, {
      sts: s as never, now: s.now, max: 2,
      s3: credentials => { built.push(String(built.length)); return new S3Client(spacesS3ClientConfig(resources, credentials)); },
    });
    const alice = { kind: 'user', userId: 'u1', email: 'alice@example.com' } as const;
    const bob = { kind: 'user', userId: 'u2', email: 'bob@example.com' } as const;
    const box = { kind: 'box', instanceId: 'i-1', name: 'alice-box', ownerUserId: 'u1', ownerEmail: 'alice@example.com' } as const;

    expect(objectsFor(alice)).toBe(objectsFor(alice));
    await objectsFor(alice).presignGet('sp/a', { contentDisposition: 'attachment' });
    await objectsFor(bob).presignGet('sp/a', { contentDisposition: 'attachment' });
    expect(s.inputs().map(i => i.RoleSessionName)).toEqual(['user-alice@example.com', 'user-bob@example.com']);

    objectsFor(alice);
    objectsFor(box);
    expect(built).toHaveLength(3);
    objectsFor(alice);
    expect(built).toHaveLength(3);
    objectsFor(bob);
    expect(built).toHaveLength(4);
  });

  it('signs every URL with a session that outlives it, renewing as the session ages', async () => {
    const s = fakeSts({ expiresInMs: [3600_000, 7200_000] });
    const objects = presignerObjects(resources, { sts: s as never, now: s.now })({ kind: 'user', userId: 'u1', email: 'alice@example.com' });
    const credentialOf = (url: string) => new URL(url).searchParams.get('X-Amz-Credential')!.split('/')[0];

    expect(credentialOf((await objects.presignGet('sp/a', { contentDisposition: 'attachment' })).url)).toBe('AK1');
    s.setNow(3600_000 - MIN_SESSION_LEFT_MS + 1);
    const [part] = await objects.presignParts('sp/a', 'U1', [{ partNumber: 1, size: 10 }]);
    expect(credentialOf(part.url)).toBe('AK2');
    expect(new URL(part.url).searchParams.get('X-Amz-Expires')).toBe(String(PART_TTL_S));
  });
});

describe('copySource', () => {
  it('percent-encodes every segment, glob and quote characters included', () => {
    expect(copySource('b', 'sp/img/*.png')).toBe('b/sp/img/%2A.png');
    expect(copySource('b', 'sp/report (final)!.pdf')).toBe('b/sp/report%20%28final%29%21.pdf');
    expect(copySource('b', 'sp/caf\u00e9 #1.txt')).toBe('b/sp/caf%C3%A9%20%231.txt');
  });
});

describe('purgePrefix', () => {
  it('splits a page of more than 1000 versions and markers into DeleteObjects batches', async () => {
    const versions = Array.from({ length: 900 }, (_, i) => ({ Key: `sp/f${i % 450}`, VersionId: `v${i}` }));
    const markers = Array.from({ length: 300 }, (_, i) => ({ Key: `sp/f${i}`, VersionId: `m${i}` }));
    const deleted: number[] = [];
    let listed = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: { Delete?: { Objects: unknown[] } } }) => {
      if (cmd.constructor.name === 'ListObjectVersionsCommand') return listed++ === 0 ? { Versions: versions, DeleteMarkers: markers } : {};
      deleted.push(cmd.input.Delete!.Objects.length);
      return {};
    });
    const removed = await s3SpaceObjects(resources, { s3: { send } as unknown as S3Client }).purgePrefix('sp/');
    expect(deleted).toEqual([1000, 200]);
    expect(removed).toBe(1200);
  });
});

describe('sumVersions and sweepMultipart', () => {
  it('totals every version across pages and returns the watched keys\' versions', async () => {
    const at = new Date('2026-10-16T12:00:00Z');
    const pages = [
      { IsTruncated: true, NextKeyMarker: 'sp/b', NextVersionIdMarker: 'v2', Versions: [{ Key: 'sp/a', Size: 3, LastModified: at }, { Key: 'sp/b', Size: 4, LastModified: at }] },
      { Versions: [{ Key: 'sp/b', Size: 5, LastModified: at }] },
    ];
    const send = vi.fn(async () => pages.shift());
    const out = await s3SpaceObjects(resources, { s3: { send } as unknown as S3Client }).sumVersions('sp/', new Set(['sp/b']));
    expect(out).toEqual({ total: 12n, watched: [{ key: 'sp/b', size: 4n, lastModified: at }, { key: 'sp/b', size: 5n, lastModified: at }] });
  });

  it('lists each open upload\'s parts by number, and aborts the stale ones', async () => {
    const aborted: string[] = [];
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: { UploadId?: string } }) => {
      switch (cmd.constructor.name) {
        case 'ListMultipartUploadsCommand': return { Uploads: [
          { Key: 'sp/old', UploadId: 'u0', Initiated: new Date(0) },
          { Key: 'sp/new', UploadId: 'u1', Initiated: new Date() },
        ] };
        case 'AbortMultipartUploadCommand': aborted.push(cmd.input.UploadId!); return {};
        case 'ListPartsCommand': return { Parts: [{ PartNumber: 1, Size: 8 }, { PartNumber: 3, Size: 2 }] };
        default: throw new Error(cmd.constructor.name);
      }
    });
    const out = await s3SpaceObjects(resources, { s3: { send } as unknown as S3Client }).sweepMultipart('sp/', new Date(1000));
    expect(aborted).toEqual(['u0']);
    expect(out).toEqual({ aborted: 1, inProgress: [{ key: 'sp/new', uploadId: 'u1', parts: [{ partNumber: 1, bytes: 8n }, { partNumber: 3, bytes: 2n }] }] });
  });
});

describe('read', () => {
  it('returns the object\'s bytes, and null when S3 has no such key', async () => {
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      expect(cmd.constructor.name).toBe('GetObjectCommand');
      if (cmd.input.Key === 'sp/gone.html') throw Object.assign(new Error('gone'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToByteArray: async () => new TextEncoder().encode('<p>hi</p>') } };
    });
    const objs = s3SpaceObjects(resources, { s3: { send } as unknown as S3Client });
    expect((await objs.read('sp/page.html', 100))!.toString()).toBe('<p>hi</p>');
    expect(await objs.read('sp/gone.html', 100)).toBeNull();
    expect(send.mock.calls.map(c => c[0].input)).toEqual([
      { Bucket: resources.bucket, Key: 'sp/page.html', Range: 'bytes=0-100' },
      { Bucket: resources.bucket, Key: 'sp/gone.html', Range: 'bytes=0-100' },
    ]);
  });

  it('reads an empty object as no bytes (S3 refuses any range of one)', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('range'), { name: 'InvalidRange', $metadata: { httpStatusCode: 416 } }); });
    expect((await s3SpaceObjects(resources, { s3: { send } as unknown as S3Client }).read('sp/empty.html', 100))!.length).toBe(0);
  });

  it('rethrows anything but a missing key', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); });
    await expect(s3SpaceObjects(resources, { s3: { send } as unknown as S3Client }).read('sp/a.html', 100)).rejects.toThrow('denied');
  });
});
