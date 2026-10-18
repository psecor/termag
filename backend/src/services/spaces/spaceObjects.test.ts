import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { spaceResourceNames } from './spaceConfig';
import {
  copySource, MIN_SESSION_LEFT_MS, PART_TTL_S, presignerCredentials, s3SpaceObjects, spacesS3ClientConfig, sseHeaders,
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

describe('presignerCredentials', () => {
  function sts(expiresInMs: number[]) {
    let t = 0;
    const send = vi.fn(async () => ({
      Credentials: {
        AccessKeyId: `AK${send.mock.calls.length}`, SecretAccessKey: 's', SessionToken: 't',
        Expiration: new Date(t + expiresInMs[Math.min(send.mock.calls.length - 1, expiresInMs.length - 1)]),
      },
    }));
    return { send, setNow: (v: number) => { t = v; }, now: () => t };
  }

  it('assumes the presigner role and reuses the session while it outlives every URL', async () => {
    const s = sts([3600_000]);
    const creds = presignerCredentials(resources.roleArn, { sts: s as never, now: s.now });
    const a = await creds();
    s.setNow(3600_000 - MIN_SESSION_LEFT_MS - 1);
    expect(await creds()).toBe(a);
    expect(s.send).toHaveBeenCalledTimes(1);
    const input = (s.send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({ RoleArn: 'arn:aws:iam::123456789012:role/termag-spaces-presigner', DurationSeconds: 3600 });
  });

  it('renews before a part URL could outlive the session', async () => {
    const s = sts([3600_000, 7200_000]);
    const creds = presignerCredentials(resources.roleArn, { sts: s as never, now: s.now });
    await creds();
    s.setNow(3600_000 - PART_TTL_S * 1000);
    expect((await creds()).accessKeyId).toBe('AK2');
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
